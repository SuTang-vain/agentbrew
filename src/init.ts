import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isInside, type Context } from "./context.js";
import { isManaged, readOwnership, type OwnershipState } from "./ownership.js";
import {
  describePiLinks,
  diffPi,
  doctorPi,
  piHostDependencyNames,
  piManifestFile,
  readPiManifest,
  resolveHost,
  HOST_PACKAGE,
} from "./providers/pi.js";
import {
  diffHerdrInspection,
  doctorHerdrInspection,
  inspectHerdr,
  type HerdrInspection,
} from "./providers/herdr.js";
import type {
  CommandResult,
  Difference,
  EnvironmentClass,
  HealthCheck,
  InitAssessment,
  InitMode,
  InitPlan,
  InitResource,
} from "./types.js";

interface EntryState {
  name: string;
  kind: "directory" | "symlink" | "file" | "other";
}

export interface EnvironmentEvaluation {
  assessment: InitAssessment;
  differences: Difference[];
  checks: HealthCheck[];
  herdr: HerdrInspection;
}

function entries(dir: string): EntryState[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map((name) => {
    const stat = fs.lstatSync(path.join(dir, name));
    return {
      name,
      kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
    };
  });
}

function escapesRoot(root: string, candidate: string): boolean {
  try {
    if (!fs.existsSync(candidate)) return false;
    return !isInside(fs.realpathSync(candidate), fs.realpathSync(root));
  } catch {
    return true;
  }
}

function herdrResource(available: boolean): InitResource {
  return {
    id: "herdr.pi-integration",
    description: "Generate the native herdr Pi integration",
    sideEffect: available ? "Runs herdr integration install pi when outdated" : "Unavailable until herdr is installed",
    required: false,
  };
}

export function evaluateEnvironment(context: Context): EnvironmentEvaluation {
  const issues: string[] = [];
  let rootEntries: EntryState[] = [];
  let npmEntries: EntryState[] = [];
  let layoutKnown = true;
  try {
    rootEntries = entries(context.agentDir);
    npmEntries = entries(context.npmDir);
  } catch (error) {
    layoutKnown = false;
    issues.push(error instanceof Error ? error.message : String(error));
  }

  let host: InitAssessment["host"] = null;
  try {
    host = resolveHost(context);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  let manifest: InitAssessment["manifest"] = null;
  let manifestText: string | null = null;
  let manifestError = false;
  try {
    manifestText = fs.readFileSync(piManifestFile(context), "utf8");
    manifest = readPiManifest(context);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      manifestError = true;
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }

  let hostDependencies: string[] = [];
  if (manifest) {
    try {
      hostDependencies = piHostDependencyNames(context);
    } catch (error) {
      manifestError = true;
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }

  const onlyHostDirectories = layoutKnown && rootEntries.every((entry) => entry.name === "install" || entry.name === "npm");
  const installEntry = rootEntries.find((entry) => entry.name === "install");
  const npmEntry = rootEntries.find((entry) => entry.name === "npm");
  const validManagedLayout = !installEntry || (
    installEntry.kind === "directory"
    && host?.source === "managed"
    && isInside(host.dir, path.join(context.agentDir, "install", "releases"))
  );
  const freshEligible = layoutKnown
    && !manifest
    && !manifestError
    && (!npmEntry || npmEntry.kind === "directory")
    && npmEntries.length === 0
    && onlyHostDirectories
    && validManagedLayout;

  let herdr: HerdrInspection;
  try {
    herdr = inspectHerdr(context);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
    herdr = { available: false, integration: "unknown", plugins: [] };
  }
  let ownership: OwnershipState | null = null;
  let ownershipError = false;
  try {
    ownership = readOwnership(context);
  } catch (error) {
    ownershipError = true;
    issues.push(error instanceof Error ? error.message : String(error));
  }
  const integrationRequired = !freshEligible && (ownership
    ? isManaged(ownership.resources["herdr.pi-integration"])
    : Boolean(manifest));

  const differences: Difference[] = [];
  const checks: HealthCheck[] = [];
  let piInspectionFailed = false;
  if (manifest && host && !manifestError) {
    try {
      differences.push(...diffPi(context));
      checks.push(...doctorPi(context));
    } catch (error) {
      piInspectionFailed = true;
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!freshEligible) differences.push(...diffHerdrInspection(herdr));
  checks.push(...doctorHerdrInspection(herdr, integrationRequired));

  const links = describePiLinks(context, hostDependencies);
  const unsafeLink = links.some((link) => link.state === "not a symlink");
  const escapingDirectory = [context.npmDir, path.join(context.npmDir, "host-deps"), path.join(context.npmDir, "node_modules")]
    .some((candidate) => escapesRoot(context.agentDir, candidate));
  const requiredDifference = differences.some((difference) => difference.resource !== "herdr.pi-integration" || integrationRequired);

  let classification: EnvironmentClass;
  if (freshEligible) classification = "empty";
  else if (!layoutKnown || ownershipError || (!manifest && !manifestError)) classification = "unknown";
  else if (manifestError || !manifest || !host || piInspectionFailed || unsafeLink || escapingDirectory) classification = "damaged";
  else if (herdr.available && herdr.integration === "unknown" && integrationRequired) classification = "unknown";
  else if (requiredDifference || checks.some((check) => check.status === "fail")) classification = "repairable";
  else classification = "healthy";

  const resources: InitResource[] = freshEligible
    ? [{
        id: "pi.base",
        description: "Create the minimal npm manifest and links for the current Pi host",
        sideEffect: "Writes only npm configuration and links; npm lifecycle scripts are disabled",
        required: true,
      }, herdrResource(herdr.available)]
    : [
        ...(manifest ? [{
          id: "pi.host",
          description: "Adopt or manage the active Pi host declaration",
          sideEffect: "Manage normalizes only the host dependency declaration; init never upgrades the host",
          required: false,
        }, {
          id: "pi.host-links",
          description: "Repair generated host and host-dependency links",
          sideEffect: "Replaces only missing or existing symbolic links; personal declarations are unchanged in Repair mode",
          required: false,
        }] : []),
        herdrResource(herdr.available),
        ...(manifest ? Object.keys(manifest.dependencies).filter((name) => name !== HOST_PACKAGE).sort().map((name) => ({
          id: `npm:${name}`,
          description: `Adopt or manage ${name}`,
          sideEffect: hostDependencies.includes(name)
            ? "Manage normalizes its portable host dependency declaration; no package upgrade runs"
            : "Changes local ownership only; no package installation or upgrade runs",
          required: false,
        })) : []),
      ];

  const ownershipFile = path.join(context.stateDir, "ownership.json");
  const ownershipHash = fs.existsSync(ownershipFile)
    ? createHash("sha256").update(fs.readFileSync(ownershipFile)).digest("hex")
    : "missing";
  let hostManifestHash = "missing";
  if (host) {
    try {
      hostManifestHash = createHash("sha256").update(fs.readFileSync(path.join(host.dir, "package.json"))).digest("hex");
    } catch {
      hostManifestHash = "unreadable";
    }
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({
    classification,
    rootEntries,
    npmEntries: npmEntries.map((entry) => entry.name),
    host,
    hostManifestHash,
    manifestHash: manifestText === null ? "missing" : createHash("sha256").update(manifestText).digest("hex"),
    links,
    integration: herdr.integration,
    ownershipHash,
  })).digest("hex");

  return {
    assessment: { classification, host, manifest, resources, freshEligible, issues, fingerprint },
    differences,
    checks,
    herdr,
  };
}

export function allowedInitModes(classification: EnvironmentClass): InitMode[] {
  if (classification === "empty") return ["observe", "fresh"];
  if (classification === "healthy") return ["observe", "adopt", "manage"];
  if (classification === "repairable") return ["observe", "adopt", "repair", "manage"];
  return ["observe", "repair"];
}

export function createInitPlan(
  context: Context,
  evaluation: EnvironmentEvaluation,
  mode: InitMode,
  selectedResources: string[],
): InitPlan {
  const { assessment } = evaluation;
  if (!allowedInitModes(assessment.classification).includes(mode)) {
    throw new Error(`${mode} is not allowed for a ${assessment.classification} target`);
  }
  if (mode === "fresh" && (!assessment.freshEligible || !assessment.host)) {
    throw new Error("Fresh install requires a proven-empty configuration root and a working Pi host; install the host first");
  }
  const resources = [...new Set(selectedResources)];
  if (mode === "observe" && resources.length > 0) throw new Error("Observe does not accept resource changes");
  if (mode !== "observe" && resources.length === 0) throw new Error("select at least one resource explicitly");
  const available = new Map(assessment.resources.map((resource) => [resource.id, resource]));
  for (const id of resources) {
    if (!available.has(id)) throw new Error(`resource is not available for this target: ${id}`);
    if (mode === "repair" && !["pi.host-links", "herdr.pi-integration"].includes(id)) {
      throw new Error(`Repair only accepts generated resources: ${id}`);
    }
  }
  if (mode === "fresh" && !resources.includes("pi.base")) throw new Error("Fresh install requires the pi.base resource");
  if (mode === "fresh" && resources.some((id) => !["pi.base", "herdr.pi-integration"].includes(id))) {
    throw new Error("Fresh install only accepts pi.base and herdr.pi-integration");
  }

  const ordered = assessment.resources.map((resource) => resource.id).filter((id) => resources.includes(id));
  const actions: InitPlan["actions"] = [];
  if (mode === "fresh") actions.push("install-minimal-pi");
  if (ordered.includes("pi.host-links") && (mode === "repair" || mode === "manage")) actions.push("repair-pi-links");
  if (mode === "manage" && ordered.some((id) => id === "pi.host" || id.startsWith("npm:"))) {
    actions.push("normalize-pi-dependencies");
  }
  if (ordered.includes("herdr.pi-integration") && mode !== "adopt") actions.push("generate-herdr-integration");
  if (mode !== "observe") actions.push("record-ownership");

  return {
    schemaVersion: 1,
    kind: "agentbrew-init-plan",
    target: { agentDir: context.agentDir },
    classification: assessment.classification,
    mode,
    resources: ordered,
    host: assessment.host,
    actions,
    assessmentHash: assessment.fingerprint,
  };
}

export function initResult(
  context: Context,
  evaluation: EnvironmentEvaluation,
  status: CommandResult["status"] = "success",
): CommandResult {
  return {
    schemaVersion: 1,
    command: "init",
    status,
    target: { agentDir: context.agentDir },
    changes: "none",
    steps: [],
    differences: evaluation.differences,
    checks: evaluation.checks,
    data: { assessment: evaluation.assessment },
  };
}

export function readInitPlan(file: string): InitPlan {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value?.schemaVersion !== 1 || value.kind !== "agentbrew-init-plan" || typeof value.target?.agentDir !== "string") {
    throw new Error(`${file} is not an Agentbrew init plan`);
  }
  if (!Array.isArray(value.resources) || !value.resources.every((resource: unknown) => typeof resource === "string")) {
    throw new Error(`${file} has an invalid init resource list`);
  }
  return value as InitPlan;
}

export function writeInitPlan(file: string, plan: InitPlan): void {
  fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
