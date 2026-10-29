import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context } from "./context.js";
import { satisfiesNpmConstraint, validNpmConstraint } from "./npm-spec.js";
import { HOST_PACKAGE, readPiManifest } from "./providers/pi.js";
import type { HerdrInspection } from "./providers/herdr.js";
import {
  exceptionState,
  parseReleaseMetadata,
  validateReleaseIntegrity,
  type BundleSubject,
  type ReleaseMetadata,
} from "./release.js";
import type { Difference, HealthCheck, Ownership } from "./types.js";

export const LAYERS = ["public", "team", "personal", "machine"] as const;
export type LayerName = typeof LAYERS[number];
export type UpdatePolicy = "compatible" | "fixed" | "manual";

export interface NpmDeclaration {
  source: { type: "npm"; spec: string; integrity?: string };
  update: UpdatePolicy;
}

export interface IntegrationDeclaration {
  update: "compatible" | "manual";
}

export type ResourceDeclaration = NpmDeclaration | IntegrationDeclaration;

export interface BundleSource {
  layer: LayerName;
  file: string;
  sha256: string;
}

export interface BundleEvent {
  layer: LayerName;
  effect: "declared" | "overridden" | "removed" | "restored";
}

export interface ResolvedResource {
  id: string;
  declaration: ResourceDeclaration;
  layer: LayerName;
  history: BundleEvent[];
}

export interface RemovedResource {
  id: string;
  layer: LayerName;
  history: BundleEvent[];
}

export interface ResolvedBundle {
  schemaVersion: 1;
  sources: BundleSource[];
  resources: Record<string, ResolvedResource>;
  removed: Record<string, RemovedResource>;
  required: string[];
  forbidden: string[];
  inputHash: string;
  release?: ReleaseMetadata;
}

interface LayerFile {
  source: BundleSource;
  resources: Record<string, ResourceDeclaration>;
  override: Set<string>;
  remove: Set<string>;
  required: Set<string>;
  forbidden: Set<string>;
  release?: ReleaseMetadata;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${where} contains unknown field ${key}`);
  }
}

function validPackageName(name: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
    && name !== HOST_PACKAGE
    && !name.startsWith("@earendil-works/pi-");
}

export function packageForResource(id: string): string {
  if (!id.startsWith("npm:") || !validPackageName(id.slice(4))) {
    throw new Error(`unsupported or unsafe npm resource ${id}; Pi host dependencies remain machine-local`);
  }
  return id.slice(4);
}

function resourceDeclaration(id: string, value: unknown, where: string, release = false): ResourceDeclaration {
  if (!isObject(value)) throw new Error(`${where} must be a complete resource declaration object`);
  if (id.startsWith("npm:")) {
    packageForResource(id);
    checkKeys(value, ["source", "update"], where);
    if (!isObject(value.source)) throw new Error(`${where}.source must be an npm source object`);
    const releasePin = release && value.update === "fixed";
    checkKeys(value.source, releasePin ? ["type", "spec", "integrity"] : ["type", "spec"], `${where}.source`);
    if (value.source.type !== "npm" || typeof value.source.spec !== "string") {
      throw new Error(`${where}.source requires type npm and a spec string`);
    }
    if (!["compatible", "fixed", "manual"].includes(String(value.update))) {
      throw new Error(`${where}.update must be compatible, fixed, or manual`);
    }
    const spec = value.source.spec;
    if (!validNpmConstraint(spec)) {
      throw new Error(`${where}.source.spec must be an exact, caret, or tilde npm semver constraint`);
    }
    if (value.update === "fixed" && !validNpmConstraint(spec, true)) {
      throw new Error(`${where} fixed policy requires an exact semver, not a range`);
    }
    const integrity = releasePin ? validateReleaseIntegrity(value.source.integrity, `${where}.source.integrity`) : undefined;
    return { source: { type: "npm", spec, ...(integrity ? { integrity } : {}) }, update: value.update as UpdatePolicy };
  }
  if (id === "herdr.pi-integration") {
    checkKeys(value, ["update"], where);
    if (value.update !== "compatible" && value.update !== "manual") {
      throw new Error(`${where}.update must be compatible or manual for herdr integration`);
    }
    return { update: value.update };
  }
  throw new Error(`${where} uses an unknown resource type or missing Provider: ${id}`);
}

function stringSet(value: unknown, field: string, where: string): Set<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`${where}.${field} must be an array of resource IDs`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${where}.${field} contains duplicates`);
  return new Set(value as string[]);
}

function readLayer(kind: LayerName, file: string): LayerFile {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${file} must be a regular layer file`);
  if (stat.size > 1024 * 1024) throw new Error(`${file} exceeds the 1 MiB layer size limit`);
  const text = fs.readFileSync(file, "utf8");
  const value: unknown = JSON.parse(text);
  const where = `${kind} layer ${file}`;
  if (!isObject(value)) throw new Error(`${where} must contain a JSON object`);
  const releaseInput = value.kind === "agentbrew-release";
  checkKeys(value, releaseInput
    ? ["schemaVersion", "kind", "layer", "release", "resources", "required", "forbidden", "host", "exceptions", "verification"]
    : ["schemaVersion", "kind", "layer", "resources", "override", "remove", "required", "forbidden"], where);
  if (value.schemaVersion !== 1 || value.layer !== kind || (!releaseInput && value.kind !== "agentbrew-layer")) {
    throw new Error(`${where} has an unsupported schemaVersion, kind, or layer`);
  }
  if (releaseInput && kind !== "team") throw new Error(`${where} must place a Bundle Release in the team layer`);
  if (!isObject(value.resources)) throw new Error(`${where}.resources must be an object`);
  const release = releaseInput ? parseReleaseMetadata(value, where) : undefined;
  const resources: Record<string, ResourceDeclaration> = {};
  for (const id of Object.keys(value.resources).sort()) {
    resources[id] = resourceDeclaration(id, value.resources[id], `${where}.resources.${id}`, releaseInput);
  }
  const override = stringSet(value.override, "override", where);
  const remove = stringSet(value.remove, "remove", where);
  const required = stringSet(value.required, "required", where);
  const forbidden = stringSet(value.forbidden, "forbidden", where);
  const validateReference = (id: string) => {
    if (id.startsWith("npm:")) packageForResource(id);
    else if (id !== "herdr.pi-integration") throw new Error(`${where} references unknown resource ${id}`);
  };
  for (const id of [...remove, ...override]) {
    if (!(id in resources) && !remove.has(id)) throw new Error(`${where} references unknown resource ${id} in override/remove`);
    validateReference(id);
  }
  for (const id of override) {
    if (!(id in resources)) throw new Error(`${where}.override entries must accompany a resource declaration: ${id}`);
  }
  if (kind !== "team" && (required.size > 0 || forbidden.size > 0)) {
    throw new Error(`${where} cannot declare required/forbidden policy outside the team layer`);
  }
  for (const id of [...required, ...forbidden]) validateReference(id);
  for (const id of required) {
    if (forbidden.has(id)) throw new Error(`${where} cannot both require and forbid ${id}`);
  }
  for (const entry of release?.exceptions ?? []) {
    validateReference(entry.resource);
    if (!required.has(entry.resource)) throw new Error(`${where} exception ${entry.resource} must reference a team-required resource`);
    if (!resources[entry.resource]) throw new Error(`${where} exception ${entry.resource} must reference a declared resource`);
  }
  return {
    source: { layer: kind, file, sha256: createHash("sha256").update(text).digest("hex") },
    resources,
    override,
    remove,
    required,
    forbidden,
    ...(release ? { release } : {}),
  };
}

export function parseLayerArguments(inputs: string[]): Array<{ layer: LayerName; file: string }> {
  const parsed: Array<{ layer: LayerName; file: string }> = [];
  const seen = new Set<LayerName>();
  for (const input of inputs) {
    const separator = input.indexOf("=");
    const layer = input.slice(0, separator) as LayerName;
    const file = input.slice(separator + 1);
    if (separator < 1 || !LAYERS.includes(layer) || !file.trim()) {
      throw new Error(`--layer requires public|team|personal|machine=<path>: ${input}`);
    }
    if (seen.has(layer)) throw new Error(`only one ${layer} layer is allowed in this version`);
    seen.add(layer);
    parsed.push({ layer, file: path.resolve(file) });
  }
  return parsed.sort((a, b) => LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer));
}

export function loadBundle(inputs: string[], subject: BundleSubject = {}): ResolvedBundle | null {
  if (inputs.length === 0) return null;
  const layers = parseLayerArguments(inputs).map(({ layer, file }) => readLayer(layer, file));
  const resources: Record<string, ResolvedResource> = {};
  const removed: Record<string, RemovedResource> = {};
  const seen = new Set<string>();
  const required = new Set<string>();
  const forbidden = new Set<string>();
  const release = layers.find((layer) => layer.release)?.release;
  const mayOverrideRequired = (id: string): boolean => release?.exceptions.some(
    (entry) => entry.resource === id && exceptionState(entry, subject) === "applied",
  ) ?? false;

  for (const layer of layers) {
    for (const id of [...layer.remove].sort()) {
      if (required.has(id)) throw new Error(`${layer.source.layer} cannot remove team-required resource ${id}`);
      const previous = resources[id];
      const history = previous ? [...previous.history, { layer: layer.source.layer, effect: "removed" as const }] : [
        { layer: layer.source.layer, effect: "removed" as const },
      ];
      delete resources[id];
      removed[id] = { id, layer: layer.source.layer, history };
      seen.add(id);
    }
    for (const [id, declaration] of Object.entries(layer.resources)) {
      if (required.has(id) && !mayOverrideRequired(id)) {
        throw new Error(`${layer.source.layer} cannot override team-required resource ${id} without a matching team exception`);
      }
      if (forbidden.has(id)) throw new Error(`${layer.source.layer} cannot add team-forbidden resource ${id}`);
      if (seen.has(id) && !layer.override.has(id)) {
        throw new Error(`${layer.source.layer} must explicitly override or remove-and-restore resource ${id}`);
      }
      const previous = resources[id] ?? removed[id];
      const effect: BundleEvent["effect"] = previous ? (removed[id] ? "restored" : "overridden") : "declared";
      const history = [...(previous?.history ?? []), { layer: layer.source.layer, effect }];
      resources[id] = { id, declaration, layer: layer.source.layer, history };
      delete removed[id];
      seen.add(id);
    }
    for (const id of layer.required) required.add(id);
    for (const id of layer.forbidden) forbidden.add(id);
  }
  for (const id of required) {
    if (!resources[id]) throw new Error(`team-required resource ${id} is missing or removed in the final Bundle`);
  }
  for (const id of forbidden) {
    if (resources[id]) throw new Error(`team-forbidden resource ${id} is present in the final Bundle`);
  }
  const inputHash = createHash("sha256").update(JSON.stringify(layers.map((layer) => layer.source))).digest("hex");
  return {
    schemaVersion: 1,
    sources: layers.map((layer) => layer.source),
    resources,
    removed,
    required: [...required].sort(),
    forbidden: [...forbidden].sort(),
    inputHash,
    ...(release ? { release } : {}),
  };
}

export function bundleSummary(bundle: ResolvedBundle | null): unknown {
  if (!bundle) return undefined;
  return {
    schemaVersion: bundle.schemaVersion,
    layers: bundle.sources.map(({ layer, sha256 }) => ({ layer, sha256 })),
    resources: Object.keys(bundle.resources).sort(),
    removed: Object.keys(bundle.removed).sort(),
    required: bundle.required,
    forbidden: bundle.forbidden,
    inputHash: bundle.inputHash,
    ...(bundle.release ? { release: { name: bundle.release.name, ...(bundle.release.hostCompatible ? { hostCompatible: bundle.release.hostCompatible } : {}) } } : {}),
  };
}

export function bundleDifferences(context: Context, bundle: ResolvedBundle): Difference[] {
  const manifest = readPiManifest(context);
  const differences: Difference[] = [];
  for (const [id, resource] of Object.entries(bundle.resources)) {
    if (!id.startsWith("npm:")) continue;
    const declaration = resource.declaration as NpmDeclaration;
    const name = packageForResource(id);
    const actual = manifest.dependencies[name] ?? "missing";
    if (actual !== declaration.source.spec) {
      differences.push({
        resource: id,
        kind: declaration.update === "manual" ? "manual-drift" : "bundle-spec",
        expected: declaration.source.spec,
        actual,
      });
    }
  }
  for (const id of Object.keys(bundle.removed)) {
    if (!id.startsWith("npm:")) continue;
    const name = packageForResource(id);
    const actual = manifest.dependencies[name];
    if (actual !== undefined) differences.push({ resource: id, kind: "removed-resource", expected: "absent", actual });
  }
  return differences;
}

export function bundleHealth(
  context: Context,
  bundle: ResolvedBundle,
  ownership: Record<string, Ownership>,
  herdr: HerdrInspection,
): HealthCheck[] {
  const checks: HealthCheck[] = [];
  const manifest = readPiManifest(context);
  for (const [id, resource] of Object.entries(bundle.resources)) {
    const required = bundle.required.includes(id);
    const managed = ownership[id] === "manage" || ownership[id] === "generate";
    if (id.startsWith("npm:")) {
      const name = packageForResource(id);
      const actual = manifest.dependencies[name];
      const expected = (resource.declaration as NpmDeclaration).source.spec;
      if (actual !== expected) {
        checks.push({
          resource: id,
          status: required || managed ? "fail" : "warn",
          message: actual === undefined
            ? `declared ${expected} but is not declared locally${required ? "; required by team policy" : ""}`
            : `declared ${expected}, found ${actual}`,
        });
      } else {
        try {
          const installed = JSON.parse(fs.readFileSync(path.join(context.npmDir, "node_modules", name, "package.json"), "utf8"));
          if (installed?.name !== name || typeof installed?.version !== "string" || !satisfiesNpmConstraint(installed.version, expected)) {
            throw new Error(`installed package ${installed?.name ?? "unknown"}@${installed?.version ?? "unknown"} does not satisfy ${expected}`);
          }
          checks.push({ resource: id, status: "pass", message: `installed ${installed.version} satisfies ${expected}; runtime loading is verified separately` });
        } catch (error) {
          checks.push({
            resource: id,
            status: required || managed ? "fail" : "warn",
            message: `installed package cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    } else if (id === "herdr.pi-integration" && required && (!herdr.available || herdr.integration !== "current")) {
      checks.push({ resource: id, status: "fail", message: "team-required herdr Pi integration is unavailable or not current" });
    }
  }
  return checks;
}
