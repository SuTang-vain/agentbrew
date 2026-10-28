import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context } from "./context.js";
import {
  bundleDifferences,
  loadBundle,
  packageForResource,
  type BundleSource,
  type NpmDeclaration,
  type ResolvedBundle,
} from "./bundle.js";
import { readOwnership } from "./ownership.js";
import { redact } from "./process.js";
import { diffHerdr, inspectHerdr } from "./providers/herdr.js";
import { diffPi, piFingerprint, piManifestFile } from "./providers/pi.js";
import { diffCommand } from "./plan.js";
import type { CommandResult, Target } from "./types.js";

export type BundleAction =
  | { resource: string; type: "set-npm-dependency"; name: string; spec: string }
  | { resource: string; type: "remove-npm-dependency"; name: string }
  | { resource: "herdr.pi-integration"; type: "ensure-herdr-integration" };

export interface BundlePlan {
  schemaVersion: 1;
  kind: "agentbrew-bundle-plan";
  mode: "manage";
  target: Target;
  layers: BundleSource[];
  resources: string[];
  actions: BundleAction[];
  manifestHash: string;
  ownershipHash: string;
  targetHash: string;
  sourceHash: string;
}

function fileHash(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function ownershipHash(context: Context): string {
  const file = path.join(context.stateDir, "ownership.json");
  return fs.existsSync(file) ? fileHash(file) : "missing";
}

export function bundleTargetHash(context: Context): string {
  const lockFile = path.join(context.npmDir, "package-lock.json");
  return createHash("sha256").update(JSON.stringify({
    pi: piFingerprint(context),
    herdr: inspectHerdr(context).integration,
    ownership: ownershipHash(context),
    packageLock: fs.existsSync(lockFile) ? fileHash(lockFile) : "missing",
  })).digest("hex");
}

export function layerArguments(plan: BundlePlan): string[] {
  return plan.layers.map((source) => `${source.layer}=${source.file}`);
}

export function createBundlePlan(context: Context, bundle: ResolvedBundle, selected: string[]): BundlePlan {
  const resources = [...new Set(selected)].sort();
  if (resources.length === 0) throw new Error("Bundle planning requires repeated explicit --resource selections");
  const nativeDifferences = [...diffPi(context), ...diffHerdr(context)];
  const differences = [...nativeDifferences, ...bundleDifferences(context, bundle)];
  const actions: BundleAction[] = [];
  for (const id of resources) {
    const resource = bundle.resources[id];
    const removed = bundle.removed[id];
    if (!resource && !removed) throw new Error(`resource is not present in the effective Bundle: ${id}`);
    const resourceDifferences = differences.filter((difference) => difference.resource === id);
    if (resourceDifferences.length === 0) throw new Error(`selected resource has no Bundle difference to converge: ${id}`);
    if (id.startsWith("npm:")) {
      const name = packageForResource(id);
      if (removed) {
        if (!resourceDifferences.some((difference) => difference.kind === "removed-resource")) {
          throw new Error(`npm removal is not supported for the current difference: ${id}`);
        }
        actions.push({ resource: id, type: "remove-npm-dependency", name });
      } else {
        const declaration = resource!.declaration as NpmDeclaration;
        if (!resourceDifferences.some((difference) => ["bundle-spec", "manual-drift"].includes(difference.kind))) {
          throw new Error(`native host/link drift is not a Bundle npm convergence action: ${id}`);
        }
        actions.push({ resource: id, type: "set-npm-dependency", name, spec: declaration.source.spec });
      }
    } else if (id === "herdr.pi-integration") {
      if (removed) throw new Error("herdr integration removal is not supported by this Provider");
      if (!resourceDifferences.some((difference) => difference.kind === "integration-state")) {
        throw new Error(`no convergent herdr integration difference was found: ${id}`);
      }
      actions.push({ resource: id, type: "ensure-herdr-integration" });
    } else {
      throw new Error(`no Provider supports Bundle convergence for ${id}`);
    }
  }
  return {
    schemaVersion: 1,
    kind: "agentbrew-bundle-plan",
    mode: "manage",
    target: { agentDir: context.agentDir },
    layers: bundle.sources,
    resources,
    actions,
    manifestHash: fileHash(piManifestFile(context)),
    ownershipHash: ownershipHash(context),
    targetHash: bundleTargetHash(context),
    sourceHash: bundle.inputHash,
  };
}

function assertObject(value: unknown, where: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where} must be an object`);
}

function assertKeys(value: Record<string, unknown>, keys: string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${where} contains unknown field ${key}`);
  }
}

export function validateBundlePlan(value: unknown): BundlePlan {
  assertObject(value, "Bundle plan");
  assertKeys(value, ["schemaVersion", "kind", "mode", "target", "layers", "resources", "actions", "manifestHash", "ownershipHash", "targetHash", "sourceHash"], "Bundle plan");
  if (value.schemaVersion !== 1 || value.kind !== "agentbrew-bundle-plan" || value.mode !== "manage") {
    throw new Error("not an Agentbrew Bundle manage plan with schemaVersion 1");
  }
  assertObject(value.target, "Bundle plan target");
  assertKeys(value.target, ["agentDir"], "Bundle plan target");
  if (typeof value.target.agentDir !== "string" || !value.target.agentDir) throw new Error("Bundle plan target is invalid");
  if (!Array.isArray(value.layers) || value.layers.length === 0) throw new Error("Bundle plan layers are missing");
  for (const source of value.layers) {
    assertObject(source, "Bundle plan layer");
    assertKeys(source, ["layer", "file", "sha256"], "Bundle plan layer");
    if (!["public", "team", "personal", "machine"].includes(String(source.layer)) || typeof source.file !== "string" || !/^[a-f0-9]{64}$/.test(String(source.sha256))) {
      throw new Error("Bundle plan contains an invalid layer source");
    }
  }
  if (!Array.isArray(value.resources) || value.resources.length === 0 || value.resources.some((id) => typeof id !== "string" || !id)) {
    throw new Error("Bundle plan resources must be a nonempty string array");
  }
  if (new Set(value.resources).size !== value.resources.length
    || JSON.stringify(value.resources) !== JSON.stringify([...value.resources].sort())) {
    throw new Error("Bundle plan resources must be unique and sorted");
  }
  if (!Array.isArray(value.actions) || value.actions.length !== value.resources.length) {
    throw new Error("Bundle plan must contain exactly one action per selected resource");
  }
  for (const action of value.actions) {
    assertObject(action, "Bundle plan action");
    if (action.type === "set-npm-dependency") {
      assertKeys(action, ["resource", "type", "name", "spec"], "Bundle plan action");
      if (typeof action.resource !== "string" || typeof action.name !== "string" || typeof action.spec !== "string") throw new Error("invalid npm set action");
    } else if (action.type === "remove-npm-dependency") {
      assertKeys(action, ["resource", "type", "name"], "Bundle plan action");
      if (typeof action.resource !== "string" || typeof action.name !== "string") throw new Error("invalid npm remove action");
    } else if (action.type === "ensure-herdr-integration") {
      assertKeys(action, ["resource", "type"], "Bundle plan action");
      if (action.resource !== "herdr.pi-integration") throw new Error("invalid herdr integration action");
    } else {
      throw new Error("Bundle plan contains an unsupported action");
    }
  }
  for (const field of ["manifestHash", "ownershipHash", "targetHash", "sourceHash"]) {
    const hash = value[field];
    if (hash !== "missing" && (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) throw new Error(`Bundle plan ${field} is invalid`);
  }
  return value as unknown as BundlePlan;
}

export function readBundlePlan(file: string): BundlePlan {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read Bundle plan ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateBundlePlan(value);
}

export function writeBundlePlan(file: string, plan: BundlePlan): string {
  const destination = path.resolve(file);
  fs.writeFileSync(destination, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return destination;
}

export function revalidateBundlePlan(context: Context, plan: BundlePlan): ResolvedBundle {
  if (path.resolve(plan.target.agentDir) !== context.agentDir) throw new Error("Bundle plan target does not match the confirmed target");
  const bundle = loadBundle(layerArguments(plan));
  if (!bundle || bundle.inputHash !== plan.sourceHash) throw new Error("Bundle sources changed after planning; review and create a new plan");
  if (JSON.stringify(bundle.sources) !== JSON.stringify(plan.layers)) throw new Error("Bundle plan layer identities or hashes were modified");
  const current = createBundlePlan(context, bundle, plan.resources);
  if (JSON.stringify(current.actions) !== JSON.stringify(plan.actions)) throw new Error("Bundle plan actions do not match a fresh validated plan");
  for (const field of ["manifestHash", "ownershipHash", "targetHash", "sourceHash"] as const) {
    if (current[field] !== plan[field]) throw new Error(`Bundle plan precondition ${field} changed; review the new state and retry`);
  }
  return bundle;
}

export function bundlePlanCommand(
  context: Context,
  selected: string[],
  mode?: string,
  planOut?: string,
): CommandResult {
  const result = diffCommand(context);
  try {
    if (!planOut) {
      if (mode || selected.length) throw new Error("--resource/--mode manage with diff require --plan-out; use explain for source details");
      return result;
    }
    if (!context.layers.length) throw new Error("Bundle planning requires at least one explicit --layer");
    if (result.status !== "success") throw new Error(result.error ?? "cannot plan from an invalid target");
    if (mode !== "manage") throw new Error("Bundle planning requires explicit --mode manage; shared declarations do not grant local ownership");
    const bundle = loadBundle(context.layers)!;
    const plan = createBundlePlan(context, bundle, selected);
    const destination = writeBundlePlan(planOut, plan);
    result.status = "not-executed";
    result.data = { ...(result.data as object ?? {}), planOut: destination, plan };
    result.error = "plan written only; authorize it separately with agentbrew apply --plan <file>";
  } catch (error) {
    result.status = "not-executed";
    result.error = redact(error instanceof Error ? error.message : String(error));
  }
  return result;
}
