import type { Context } from "./context.js";
import { bundleDifferences, bundleHealth, bundleSummary, loadBundle, type ResolvedBundle } from "./bundle.js";
import { isManaged, readOwnership, type OwnershipState } from "./ownership.js";
import { redact } from "./process.js";
import { resolvedUpdateCommand } from "./resolved-update.js";
import { sourceRegistrationFingerprint } from "./source-state.js";
import { withOperationLock, writeStateJson } from "./state.js";
import {
  combineChanges,
  failedStep,
  skippedStep,
  successfulStep,
  type CommandResult,
  type StepResult,
} from "./types.js";
import {
  describePiPlan,
  diffPi,
  doctorPi,
  HOST_PACKAGE,
  inspectPi,
  piFingerprint,
  preflightPi,
  readPiManifest,
  reconcilePi,
  runSelftest,
  snapshotPi,
  updatePiHost,
} from "./providers/pi.js";
import { diffHerdr, doctorHerdr, doctorHerdrInspection, inspectHerdr, updateHerdr } from "./providers/herdr.js";

function baseResult(context: Context, command: CommandResult["command"]): CommandResult {
  return {
    schemaVersion: 1,
    command,
    status: "success",
    target: { agentDir: context.agentDir },
    changes: "none",
    steps: [],
    differences: [],
    checks: [],
  };
}

function errorResult(context: Context, command: CommandResult["command"], error: unknown): CommandResult {
  return {
    ...baseResult(context, command),
    status: "failed",
    error: redact(error instanceof Error ? error.message : String(error)),
  };
}

function integrationManaged(state: OwnershipState | null): boolean {
  return !state || isManaged(state.resources["herdr.pi-integration"]);
}

function unmanagedNativeResources(context: Context, state: OwnershipState | null): string[] {
  if (!state) return [];
  const manifest = readPiManifest(context);
  const resources = [
    "pi.host",
    "pi.host-links",
    ...Object.keys(manifest.dependencies).filter((name) => name !== HOST_PACKAGE).map((name) => `npm:${name}`),
  ];
  return resources.filter((resource) => !isManaged(state.resources[resource]));
}

export function inspectCommand(context: Context): CommandResult {
  const result = baseResult(context, "inspect");
  try {
    const pi = inspectPi(context);
    const ownership = readOwnership(context);
    const bundle = loadBundle(context.layers);
    result.data = { pi, ownership, bundle: bundleSummary(bundle) };
    try {
      result.data = { pi, herdr: inspectHerdr(context), ownership, bundle: bundleSummary(bundle) };
    } catch (error) {
      result.data = { pi, herdr: { available: false, error: redact(error instanceof Error ? error.message : String(error)) }, ownership, bundle: bundleSummary(bundle) };
    }
  } catch (error) {
    return errorResult(context, "inspect", error);
  }
  return result;
}

export function diffCommand(context: Context): CommandResult {
  const result = baseResult(context, "diff");
  try {
    const bundle = loadBundle(context.layers);
    result.differences = [...diffPi(context), ...diffHerdr(context), ...(bundle ? bundleDifferences(context, bundle) : [])];
    result.data = { count: result.differences.length, bundle: bundleSummary(bundle) };
  } catch (error) {
    return errorResult(context, "diff", error);
  }
  return result;
}

export function doctorCommand(context: Context): CommandResult {
  const result = baseResult(context, "doctor");
  try {
    const ownership = readOwnership(context);
    const bundle = loadBundle(context.layers);
    const herdr = inspectHerdr(context);
    result.checks = [...doctorPi(context), ...doctorHerdrInspection(herdr, integrationManaged(ownership))];
    if (bundle) result.checks.push(...bundleHealth(context, bundle, ownership?.resources ?? {}, herdr));
    result.data = { bundle: bundleSummary(bundle) };
    if (context.selftest) {
      const selftest = runSelftest(context);
      result.steps.push(selftest);
      result.checks.push({
        resource: "pi.selftest",
        status: selftest.status === "success" ? "pass" : "fail",
        message: selftest.message ?? (selftest.status === "success" ? "selftest passed" : "selftest failed"),
      });
    }
    if (result.checks.some((check) => check.status === "fail")) result.status = "unhealthy";
    return result;
  } catch (error) {
    return errorResult(context, "doctor", error);
  }
}

function integrationUpdatable(state: OwnershipState | null, bundle: ResolvedBundle | null): boolean {
  const declaration = bundle?.resources["herdr.pi-integration"]?.declaration;
  return integrationManaged(state) && !(declaration && !("source" in declaration) && declaration.update === "manual");
}

function dryRunUpdate(context: Context, ownership: OwnershipState | null, bundle: ResolvedBundle | null): CommandResult {
  const result = baseResult(context, "update");
  try {
    const inspection = preflightPi(context);
    const herdr = inspectHerdr(context);
    result.steps = [
      { id: "pi-update", label: "Update Pi and configured extensions", status: "planned", changes: "none" },
      { id: "pi-links", label: "Repair host links and portable declarations", status: "planned", changes: "none" },
      { id: "npm-install", label: "Install npm dependencies", status: "planned", changes: "none" },
      herdr.available && integrationUpdatable(ownership, bundle)
        ? { id: "herdr-integration", label: "Rebuild the herdr Pi integration", status: "planned", changes: "none" }
        : skippedStep("herdr-integration", "Rebuild the herdr Pi integration", herdr.available ? "integration is not managed or is manual" : "herdr is not available"),
      context.selftest
        ? { id: "selftest", label: "Run the explicitly trusted selftest", status: "planned", changes: "none" }
        : skippedStep("selftest", "Run the Pi configuration selftest", "enable explicitly with --selftest"),
      { id: "doctor", label: "Verify the final state", status: "planned", changes: "none" },
    ];
    result.data = {
      nativeMode: true,
      host: inspection.host,
      plan: describePiPlan(context),
      bundle: bundleSummary(bundle),
      note: "Pi is re-resolved after its native update; the target host version is not predicted",
    };
  } catch (error) {
    return errorResult(context, "update", error);
  }
  return result;
}

export async function updateCommand(context: Context): Promise<CommandResult> {
  let ownership: OwnershipState | null;
  let bundle: ResolvedBundle | null;
  try {
    ownership = readOwnership(context);
    bundle = loadBundle(context.layers);
    const result = baseResult(context, "update");
    result.data = { bundle: bundleSummary(bundle) };
    if (bundle && !ownership) {
      result.status = "not-executed";
      result.error = "Bundle updates require initialized local ownership; run init to select resources explicitly";
      return result;
    }
    const declarationDifferences = bundle ? bundleDifferences(context, bundle) : [];
    if (declarationDifferences.length > 0) {
      result.status = "not-executed";
      result.differences = declarationDifferences;
      result.error = "Bundle declarations differ from local state; review them with diff --mode manage --resource <id> --plan-out <file> instead of overwriting drift through update";
      return result;
    }
    const unmanaged = unmanagedNativeResources(context, ownership);
    if (unmanaged.length > 0) {
      result.status = "not-executed";
      result.error = `native Pi update would exceed local ownership: ${unmanaged.join(", ")}; rerun init to select resources explicitly`;
      result.data = { ...(result.data as object), unmanagedResources: unmanaged };
      return result;
    }
    if (bundle) return resolvedUpdateCommand(context, ownership!, bundle);
  } catch (error) {
    return errorResult(context, "update", error);
  }
  if (context.dryRun) return dryRunUpdate(context, ownership, bundle);

  let fingerprint: string;
  let sourceFingerprint: string;
  let snapshot: unknown;
  try {
    preflightPi(context);
    fingerprint = piFingerprint(context);
    sourceFingerprint = sourceRegistrationFingerprint(context);
    snapshot = snapshotPi(context);
  } catch (error) {
    return errorResult(context, "update", error);
  }

  try {
    return withOperationLock(context, () => {
      const result = baseResult(context, "update");
      result.data = { bundle: bundleSummary(bundle) };
      result.steps.push(successfulStep("preflight", "Validate the target and capture a pre-update snapshot"));
      try {
        if (piFingerprint(context) !== fingerprint || sourceRegistrationFingerprint(context) !== sourceFingerprint
          || JSON.stringify(readOwnership(context)) !== JSON.stringify(ownership)) {
          throw new Error("the target, ownership, or Bundle changed while waiting for the operation lock; review the new state and retry");
        }
        writeStateJson(context, "last-snapshot.json", snapshot);

        const hostUpdate = updatePiHost(context);
        result.steps.push(hostUpdate);
        if (hostUpdate.status !== "failed") result.steps.push(...reconcilePi(context));
        if (!result.steps.some((step) => step.status === "failed")) {
          result.steps.push(integrationUpdatable(ownership, bundle)
            ? updateHerdr(context)
            : skippedStep("herdr-integration", "Rebuild the herdr Pi integration", "integration is not managed or is manual"));
        }
        if (!result.steps.some((step) => step.status === "failed")) {
          result.steps.push(context.selftest
            ? runSelftest(context)
            : skippedStep("selftest", "Run the Pi configuration selftest", "enable explicitly with --selftest"));
        }

        if (!result.steps.some((step) => step.status === "failed")) {
          const herdr = inspectHerdr(context);
          result.checks = [...doctorPi(context), ...doctorHerdrInspection(herdr, integrationManaged(ownership))];
          if (bundle) result.checks.push(...bundleHealth(context, bundle, ownership?.resources ?? {}, herdr));
          const unhealthy = result.checks.some((check) => check.status === "fail");
          result.steps.push(unhealthy
            ? failedStep("doctor", "Verify the final state", "one or more health checks failed", "none")
            : successfulStep("doctor", "Verify the final state"));
        }

        result.changes = combineChanges(result.steps);
        if (result.checks.some((check) => check.status === "fail")) {
          result.status = "unhealthy";
        } else if (result.steps.some((step) => step.status === "failed")) {
          result.status = result.changes === "none" ? "failed" : "partial";
          result.error = "one or more update steps failed; review the recorded steps before retrying";
        }
      } catch (error) {
        result.steps.push(failedStep("execute", "Execute the update plan", error));
        result.changes = combineChanges(result.steps);
        result.status = result.changes === "none" ? "failed" : "partial";
        result.error = redact(error instanceof Error ? error.message : String(error));
      }
      writeStateJson(context, "last-result.json", result);
      return result;
    });
  } catch (error) {
    return errorResult(context, "update", error);
  }
}
