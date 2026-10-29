import fs from "node:fs";
import path from "node:path";
import type { Context } from "./context.js";
import { bundleDifferences, bundleHealth, bundleSummary, loadBundle, type NpmDeclaration, type ResolvedBundle } from "./bundle.js";
import { installLockedNpmResources, type LockedNpmResource } from "./immutable-npm.js";
import { createMetadataClient } from "./metadata.js";
import { satisfiesNpmConstraint } from "./npm-spec.js";
import { isManaged, readOwnership, type OwnershipState } from "./ownership.js";
import {
  assertTargetReleaseUnavailable,
  piArtifactEvidence,
  preparePiArtifacts,
  withVerifiedPiInstaller,
  type PiArtifactPlan,
} from "./pi-artifacts.js";
import { redact } from "./process.js";
import { resolveConfiguration, type ResolveReport } from "./resolve.js";
import { metadataOffline, resolutionChecks } from "./resolve-cli.js";
import { readSourceRegistration } from "./source-state.js";
import { withOperationLock, writeStateJson } from "./state.js";
import { doctorHerdrInspection, inspectHerdr, updateHerdr, type HerdrInspection } from "./providers/herdr.js";
import {
  diffPi,
  doctorPi,
  piInstallationMatches,
  preflightPi,
  readPiManifest,
  reconcileResolvedPi,
  resolvedUpdateFingerprint,
  resolveHost,
  runSelftest,
  snapshotPi,
  updatePiHostTo,
  verifyPiHost,
  verifyPiInstallation,
} from "./providers/pi.js";
import {
  combineChanges,
  failedStep,
  skippedStep,
  successfulStep,
  type CommandResult,
  type StepResult,
} from "./types.js";

function updateResult(context: Context): CommandResult {
  return {
    schemaVersion: 1,
    command: "update",
    status: "success",
    target: { agentDir: context.agentDir },
    changes: "none",
    steps: [],
    differences: [],
    checks: [],
  };
}

function notExecuted(context: Context, message: string, data?: unknown): CommandResult {
  return { ...updateResult(context), status: "not-executed", error: redact(message), ...(data ? { data } : {}) };
}

function integrationManaged(ownership: OwnershipState): boolean {
  return isManaged(ownership.resources["herdr.pi-integration"]);
}

function integrationUpdatable(ownership: OwnershipState, bundle: ResolvedBundle): boolean {
  const declaration = bundle.resources["herdr.pi-integration"]?.declaration;
  return integrationManaged(ownership) && !(declaration && !("source" in declaration) && declaration.update === "manual");
}

function coverageErrors(context: Context, bundle: ResolvedBundle, ownership: OwnershipState): string[] {
  const errors: string[] = [];
  for (const id of Object.keys(bundle.resources)) {
    if (id.startsWith("npm:") && !isManaged(ownership.resources[id])) {
      errors.push(`${id} has no local Manage ownership`);
    }
  }
  for (const name of Object.keys(readPiManifest(context).dependencies)) {
    if (name.startsWith("@earendil-works/pi-")) continue;
    const id = `npm:${name}`;
    if (!bundle.resources[id]) errors.push(`${id} is managed locally but has no active Bundle declaration`);
  }
  return errors;
}

function lockedResources(bundle: ResolvedBundle, report: ResolveReport): LockedNpmResource[] {
  return report.resources.map((resource) => {
    const version = resource.targetVersion ?? resource.currentVersion;
    if (!version) throw new Error(`${resource.id} has no exact installed or target version; an executable lock plan cannot be formed`);
    const declaration = bundle.resources[resource.id]?.declaration as NpmDeclaration | undefined;
    if (!declaration?.source) throw new Error(`${resource.id} no longer has an active npm declaration`);
    if (resource.action !== "update" && resource.currentVersion
      && !satisfiesNpmConstraint(resource.currentVersion, declaration.source.spec)) {
      throw new Error(`${resource.id} is retained at ${resource.currentVersion}, which does not satisfy its declaration ${declaration.source.spec}`);
    }
    return {
      id: resource.id,
      name: resource.id.slice(4),
      version,
      ...(resource.integrity ? { integrity: resource.integrity } : {}),
    };
  });
}

function verifyRetainedResources(context: Context, bundle: ResolvedBundle, resources: LockedNpmResource[]): void {
  const manifest = readPiManifest(context);
  for (const resource of resources) {
    const declaration = bundle.resources[resource.id]?.declaration as NpmDeclaration | undefined;
    if (!declaration?.source || manifest.dependencies[resource.name] !== declaration.source.spec) {
      throw new Error(`portable declaration changed for ${resource.id}`);
    }
    const installed = JSON.parse(fs.readFileSync(path.join(context.npmDir, "node_modules", resource.name, "package.json"), "utf8"));
    if (installed.name !== resource.name || installed.version !== resource.version) {
      throw new Error(`${resource.id} is not installed at its retained exact version ${resource.version}`);
    }
  }
}

function executeNpmPlan(
  context: Context,
  bundle: ResolvedBundle,
  resources: LockedNpmResource[],
  required: boolean,
): StepResult {
  if (required) {
    const installed = installLockedNpmResources(context, resources);
    if (installed.status === "failed") return installed;
    try {
      verifyPiInstallation(context);
      return installed;
    } catch (error) {
      return failedStep("npm-install", "Verify host links after locked npm installation", error, "unknown");
    }
  }
  try {
    verifyRetainedResources(context, bundle, resources);
    verifyPiInstallation(context);
    return successfulStep("npm-install", "Verify the retained exact npm versions and host links", "none", "no npm installation was necessary");
  } catch (error) {
    return failedStep("npm-install", "Verify the retained exact npm versions and host links", error, "none");
  }
}

function plannedSteps(
  context: Context,
  ownership: OwnershipState,
  bundle: ResolvedBundle,
  report: ResolveReport,
  herdr: HerdrInspection,
  npmRequired: boolean,
): StepResult[] {
  const steps: StepResult[] = [
    report.host?.action === "update"
      ? { id: "pi-host", label: `Update the Pi host to ${report.host.targetVersion}`, status: "planned", changes: "none" }
      : skippedStep("pi-host", "Use the current Pi host", `resolved target ${report.host?.targetVersion ?? "unknown"} is already active`),
    { id: "pi-host-deps", label: "Reconcile dependencies derived from the target host", status: "planned", changes: "none" },
  ];
  const updates = report.resources.filter((resource) => resource.action === "update");
  steps.push(npmRequired
    ? { id: "npm-install", label: `Generate and install an exact lock plan (${updates.length} package upgrade(s))`, status: "planned", changes: "none" }
    : skippedStep("npm-install", "Install the exact npm lock plan", "all resolved packages and host links already match their retained versions"));
  for (const resource of report.resources) {
    if (resource.action === "unknown") steps.push(skippedStep(`npm-retain:${resource.id}`, `Retain ${resource.id}`, resource.reason));
  }
  steps.push(herdr.available && integrationUpdatable(ownership, bundle)
    ? { id: "herdr-integration", label: "Rebuild the herdr Pi integration", status: "planned", changes: "none" }
    : skippedStep("herdr-integration", "Rebuild the herdr Pi integration", herdr.available ? "integration is not managed or is manual" : "herdr is not available"));
  steps.push(context.selftest
    ? { id: "selftest", label: "Run the explicitly trusted selftest", status: "planned", changes: "none" }
    : skippedStep("selftest", "Run the Pi configuration selftest", "enable explicitly with --selftest"));
  steps.push({ id: "doctor", label: "Verify the final state", status: "planned", changes: "none" });
  return steps;
}

function incompleteResult(result: CommandResult, report: ResolveReport): CommandResult {
  if (report.complete) return result;
  result.status = "partial";
  result.error = "one or more resource upgrades have unknown compatibility; existing versions were retained";
  return result;
}

export async function resolvedUpdateCommand(
  context: Context,
  ownership: OwnershipState,
  bundle: ResolvedBundle,
): Promise<CommandResult> {
  if (metadataOffline(context.env)) {
    return notExecuted(context, "resolved Bundle update requires release and npm metadata; PI_OFFLINE is enabled and no network request was made");
  }
  const coverage = coverageErrors(context, bundle, ownership);
  if (coverage.length) return notExecuted(context, `resolved Bundle update is not authorized: ${coverage.join("; ")}`);

  let herdr: HerdrInspection;
  let fingerprint: string;
  let report: ResolveReport;
  try {
    preflightPi(context);
    herdr = inspectHerdr(context);
    fingerprint = resolvedUpdateFingerprint(context, bundle);
    const client = createMetadataClient({
      releaseUrl: context.env.AGENTBREW_PI_RELEASE_URL,
      registryUrl: context.env.AGENTBREW_NPM_REGISTRY_URL,
      signal: context.signal,
    });
    report = await resolveConfiguration(context, bundle, [], client);
    if (context.signal?.aborted) throw new Error("resolved Bundle update was cancelled before execution");
  } catch (error) {
    return notExecuted(context, error instanceof Error ? error.message : String(error));
  }

  const cachedGit = context.dryRun && context.layerOrigin === "registered"
    && readSourceRegistration(context)?.layers.some((layer) => layer.git);
  let data: Record<string, unknown> = {
    nativeMode: false,
    resolvedMode: true,
    layerOrigin: context.layerOrigin,
    bundle: bundleSummary(bundle),
    resolution: report,
    ...(cachedGit ? { sourceRefresh: { state: "cached", command: "agentbrew source refresh", message: "dry-run uses the registered commit; refresh explicitly to advance it" } } : {}),
  };
  const result = updateResult(context);
  result.data = data;
  result.checks = resolutionChecks(report);
  if (!report.ready || !report.host) {
    result.status = "not-executed";
    result.error = "no trustworthy complete update plan is available; resolve the reported metadata or compatibility failures first";
    return result;
  }
  if (report.host.action === "update" && resolveHost(context).source !== "managed") {
    result.status = "not-executed";
    result.error = "resolved host updates currently require a Pi managed installation; no extensions or host files were changed";
    return result;
  }

  let resources: LockedNpmResource[];
  let npmRequired: boolean;
  try {
    resources = lockedResources(bundle, report);
    npmRequired = report.host.action === "update"
      || report.resources.some((resource) => resource.action === "update")
      || diffPi(context).length > 0
      || !piInstallationMatches(context);
  } catch (error) {
    result.status = "not-executed";
    result.error = redact(error instanceof Error ? error.message : String(error));
    return result;
  }
  data = { ...data, npmRequired };
  result.data = data;

  if (context.dryRun) {
    result.steps = plannedSteps(context, ownership, bundle, report, herdr, npmRequired);
    return incompleteResult(result, report);
  }

  let snapshot: unknown;
  let piArtifacts: PiArtifactPlan | undefined;
  try {
    if (report.host.action === "update") {
      assertTargetReleaseUnavailable(context, report.host.targetVersion);
      piArtifacts = await preparePiArtifacts(context, report.host.targetVersion);
      data = { ...data, piArtifacts: piArtifactEvidence(piArtifacts) };
      result.data = data;
    }
    snapshot = snapshotPi(context);
  } catch (error) {
    return notExecuted(context, error instanceof Error ? error.message : String(error));
  }

  try {
    return await withOperationLock(context, async () => {
      const executed = updateResult(context);
      executed.data = data;
      executed.steps.push(successfulStep("preflight", "Resolve and validate the immutable Bundle update plan"));
      let authorized = false;
      try {
        const currentBundle = loadBundle(context.layers, context);
        if (!currentBundle || currentBundle.inputHash !== bundle.inputHash
          || JSON.stringify(readOwnership(context)) !== JSON.stringify(ownership)
          || resolvedUpdateFingerprint(context, bundle) !== fingerprint
          || bundleDifferences(context, currentBundle).length > 0) {
          throw new Error("the target, ownership, Bundle, lockfile, or installed packages changed during resolution; review and retry");
        }
        if (report.host!.action === "update") assertTargetReleaseUnavailable(context, report.host!.targetVersion);
        authorized = true;
        writeStateJson(context, "last-resolution.json", {
          schemaVersion: 1,
          kind: "agentbrew-resolution",
          target: { agentDir: context.agentDir },
          sourceHash: bundle.inputHash,
          fingerprint,
          report,
        });
        writeStateJson(context, "last-snapshot.json", { schemaVersion: 1, kind: "agentbrew-update-snapshot", pi: snapshot, herdr });
        if (piArtifacts) writeStateJson(context, "last-pi-install-plan.json", piArtifactEvidence(piArtifacts));

        if (report.host!.action === "update") {
          executed.steps.push(await withVerifiedPiInstaller(
            piArtifacts!,
            (installerBase) => updatePiHostTo(context, report.host!.targetVersion, installerBase),
          ));
        } else {
          try {
            verifyPiHost(context, report.host!.targetVersion);
            executed.steps.push(successfulStep("pi-host", "Verify the resolved Pi host", "none", `active host ${report.host!.targetVersion}`));
          } catch (error) {
            executed.steps.push(failedStep("pi-host", "Verify the resolved Pi host", error, "none"));
          }
        }
        if (!executed.steps.some((step) => step.status === "failed")) {
          executed.steps.push(...reconcileResolvedPi(context, resolveHost(context), report.host!.dependencies));
        }
        if (!executed.steps.some((step) => step.status === "failed")) {
          executed.steps.push(executeNpmPlan(context, bundle, resources, npmRequired));
        }
        for (const resource of report.resources) {
          if (resource.action === "unknown") executed.steps.push(skippedStep(`npm-retain:${resource.id}`, `Retain ${resource.id}`, resource.reason));
        }
        if (!executed.steps.some((step) => step.status === "failed")) {
          executed.steps.push(integrationUpdatable(ownership, bundle)
            ? updateHerdr(context)
            : skippedStep("herdr-integration", "Rebuild the herdr Pi integration", "integration is not managed or is manual"));
        }
        if (!executed.steps.some((step) => step.status === "failed")) {
          executed.steps.push(context.selftest
            ? runSelftest(context)
            : skippedStep("selftest", "Run the Pi configuration selftest", "enable explicitly with --selftest"));
        }
        if (!executed.steps.some((step) => step.status === "failed")) {
          const currentHerdr = inspectHerdr(context);
          executed.checks = [
            ...resolutionChecks(report),
            ...doctorPi(context),
            ...doctorHerdrInspection(currentHerdr, integrationManaged(ownership)),
            ...bundleHealth(context, bundle, ownership.resources, currentHerdr),
          ];
          const unhealthy = executed.checks.some((check) => check.status === "fail");
          executed.steps.push(unhealthy
            ? failedStep("doctor", "Verify the final state", "one or more health checks failed", "none")
            : successfulStep("doctor", "Verify the final state"));
        }

        executed.changes = combineChanges(executed.steps);
        if (executed.checks.some((check) => check.status === "fail")) {
          executed.status = "unhealthy";
        } else if (executed.steps.some((step) => step.status === "failed")) {
          executed.status = executed.changes === "none" ? "failed" : "partial";
          executed.error = "one or more resolved update steps failed; dependent steps were not executed";
        } else {
          incompleteResult(executed, report);
        }
      } catch (error) {
        executed.steps.push(failedStep("execute", "Execute the resolved update plan", error, authorized ? "unknown" : "none"));
        executed.changes = combineChanges(executed.steps);
        executed.status = authorized ? (executed.changes === "none" ? "failed" : "partial") : "not-executed";
        executed.error = redact(error instanceof Error ? error.message : String(error));
      }
      writeStateJson(context, "last-result.json", executed);
      return executed;
    });
  } catch (error) {
    return { ...updateResult(context), status: "failed", data, error: redact(error instanceof Error ? error.message : String(error)) };
  }
}
