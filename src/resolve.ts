import fs from "node:fs";
import path from "node:path";
import type { Context } from "./context.js";
import { packageForResource, type NpmDeclaration, type ResolvedBundle, type ResolvedResource } from "./bundle.js";
import type { MetadataClient } from "./metadata.js";
import { compareNpmVersions, satisfiesNpmConstraint, satisfiesPeerRange, validNpmConstraint } from "./npm-spec.js";
import { redact } from "./process.js";
import { HOST_PACKAGE, resolveHost } from "./providers/pi.js";

export interface PeerEvidence {
  dependency: string;
  range: string;
  hostVersion: string;
  compatible: boolean | null;
}

export interface HostResolution {
  currentVersion: string;
  targetVersion: string;
  action: "update" | "keep";
  source: "pi-release-channel";
  reason: string;
  integrity?: string;
  compatibleRange?: string;
  dependencies: Record<string, string>;
}

export type ResourceAction = "update" | "keep" | "unknown" | "blocked";

export interface ResourceResolution {
  id: string;
  policy: "compatible" | "fixed" | "manual";
  required: boolean;
  currentVersion: string | null;
  targetVersion: string | null;
  action: ResourceAction;
  reason: string;
  integrity?: string;
  releasePin?: boolean;
  peerEvidence: PeerEvidence[];
}

export interface ResolveReport {
  schemaVersion: 1;
  ready: boolean;
  complete: boolean;
  host: HostResolution | null;
  resources: ResourceResolution[];
  errors: Array<{ source: string; message: string }>;
  release?: { name: string; hostCompatible?: string };
}

interface PackageManifest {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  integrity?: string;
}

interface PeerEvaluation {
  status: "compatible" | "incompatible" | "unknown";
  evidence: PeerEvidence[];
  reason: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function manifest(value: unknown, expectedName?: string, expectedVersion?: string): PackageManifest | null {
  if (!isObject(value) || typeof value.name !== "string" || typeof value.version !== "string") return null;
  if (!validNpmConstraint(value.version, true)) return null;
  if (expectedName && value.name !== expectedName) return null;
  if (expectedVersion && value.version !== expectedVersion) return null;
  const integrity = isObject(value.dist) && typeof value.dist.integrity === "string" ? value.dist.integrity : undefined;
  return {
    name: value.name,
    version: value.version,
    dependencies: stringMap(value.dependencies),
    peerDependencies: stringMap(value.peerDependencies),
    ...(integrity ? { integrity } : {}),
  };
}

function installedManifest(context: Context, name: string): { value: PackageManifest | null; error: string | null } {
  try {
    const file = path.join(context.npmDir, "node_modules", name, "package.json");
    const value = manifest(JSON.parse(fs.readFileSync(file, "utf8")), name);
    if (!value) return { value: null, error: "installed package manifest has an invalid name or version" };
    return { value, error: null };
  } catch {
    return { value: null, error: "installed package manifest is unavailable" };
  }
}

function evaluatePeers(value: PackageManifest, host: HostResolution): PeerEvaluation {
  const evidence: PeerEvidence[] = [];
  let unknown = false;
  for (const [dependency, range] of Object.entries(value.peerDependencies)) {
    if (dependency !== HOST_PACKAGE && !dependency.startsWith("@earendil-works/pi-")) continue;
    const hostVersion = dependency === HOST_PACKAGE ? host.targetVersion : host.dependencies[dependency];
    if (!hostVersion) {
      unknown = true;
      evidence.push({ dependency, range, hostVersion: "unknown", compatible: null });
      continue;
    }
    const compatible = satisfiesPeerRange(hostVersion, range);
    if (compatible === null) unknown = true;
    evidence.push({ dependency, range, hostVersion, compatible });
  }
  if (evidence.length === 0) return { status: "unknown", evidence, reason: "no Pi peer compatibility metadata" };
  if (evidence.some((entry) => entry.compatible === false)) {
    return { status: "incompatible", evidence, reason: "a Pi peer constraint excludes the target host" };
  }
  if (unknown || evidence.some((entry) => entry.compatible === null)) {
    return { status: "unknown", evidence, reason: "Pi peer compatibility is incomplete or unsupported" };
  }
  return { status: "compatible", evidence, reason: "all declared Pi peer constraints accept the target host" };
}

function emptyResource(resource: ResolvedResource, required: boolean, currentVersion: string | null, action: ResourceAction, reason: string): ResourceResolution {
  const declaration = resource.declaration as NpmDeclaration;
  return {
    id: resource.id,
    policy: declaration.update,
    required,
    currentVersion,
    targetVersion: null,
    action,
    reason,
    peerEvidence: [],
  };
}

function resolveCurrent(
  resource: ResolvedResource,
  required: boolean,
  current: PackageManifest,
  host: HostResolution,
): ResourceResolution {
  const declaration = resource.declaration as NpmDeclaration;
  const peers = evaluatePeers(current, host);
  const compatible = peers.status === "compatible";
  return {
    id: resource.id,
    policy: declaration.update,
    required,
    currentVersion: current.version,
    targetVersion: compatible ? current.version : null,
    action: compatible ? "keep" : peers.status === "incompatible" ? "blocked" : "unknown",
    reason: compatible ? `keep current version; ${peers.reason}` : peers.reason,
    peerEvidence: peers.evidence,
  };
}

function releasePinned(resource: ResolvedResource): boolean {
  const declaration = resource.declaration as NpmDeclaration;
  return declaration.update === "fixed" && declaration.source.integrity !== undefined;
}

function resolveReleasePin(
  resource: ResolvedResource,
  required: boolean,
  current: PackageManifest | null,
  value: unknown,
  host: HostResolution,
): ResourceResolution {
  const declaration = resource.declaration as NpmDeclaration;
  const name = packageForResource(resource.id);
  const candidate = manifest(value, name, declaration.source.spec);
  const base = {
    ...emptyResource(resource, required, current?.version ?? null, "blocked", "Release pin metadata is invalid"),
    releasePin: true,
    integrity: declaration.source.integrity,
  };
  if (!candidate) return { ...base, reason: "Release pin requires an exact registry manifest with matching package identity" };
  if (!candidate.integrity || candidate.integrity !== declaration.source.integrity) {
    return { ...base, reason: "Release pin integrity does not match the registry manifest" };
  }
  const peers = evaluatePeers(candidate, host);
  if (peers.status !== "compatible") {
    return { ...base, reason: `Release pin is not proven compatible with the target host; ${peers.reason}`, peerEvidence: peers.evidence };
  }
  const keep = current?.version === candidate.version;
  return {
    id: resource.id,
    policy: "fixed",
    required,
    currentVersion: current?.version ?? null,
    targetVersion: candidate.version,
    action: keep ? "keep" : "update",
    reason: `${keep ? "current version matches" : "install the exact version selected by"} the reviewed Release; ${peers.reason}`,
    integrity: declaration.source.integrity,
    releasePin: true,
    peerEvidence: peers.evidence,
  };
}

function resolveCompatible(
  resource: ResolvedResource,
  required: boolean,
  current: PackageManifest | null,
  currentError: string | null,
  packument: unknown,
  host: HostResolution,
): ResourceResolution {
  const declaration = resource.declaration as NpmDeclaration;
  const name = packageForResource(resource.id);
  if (!isObject(packument) || !isObject(packument.versions)) {
    return emptyResource(resource, required, current?.version ?? null, current ? "unknown" : "blocked", "npm packument has no versions object");
  }
  const versions = Object.keys(packument.versions)
    .filter((version) => validNpmConstraint(version, true) && satisfiesNpmConstraint(version, declaration.source.spec))
    .sort((a, b) => compareNpmVersions(b, a) ?? 0);
  let sawUnknown = false;
  let sawIncompatible = false;
  let sawMissingIntegrity = false;
  for (const version of versions) {
    if (current && (compareNpmVersions(current.version, version) ?? 0) > 0) break;
    const candidate = manifest(packument.versions[version], name, version);
    if (!candidate) {
      sawUnknown = true;
      continue;
    }
    const peers = evaluatePeers(candidate, host);
    if (peers.status === "incompatible") {
      sawIncompatible = true;
      continue;
    }
    if (peers.status === "unknown") {
      sawUnknown = true;
      continue;
    }
    const isCurrent = current?.version === version;
    if (!candidate.integrity && !isCurrent) {
      sawMissingIntegrity = true;
      continue;
    }
    return {
      id: resource.id,
      policy: declaration.update,
      required,
      currentVersion: current?.version ?? null,
      targetVersion: version,
      action: isCurrent ? "keep" : "update",
      reason: isCurrent ? `current version is the latest compatible candidate; ${peers.reason}` : `selected the newest candidate satisfying the Bundle and target host; ${peers.reason}`,
      ...(candidate.integrity ? { integrity: candidate.integrity } : {}),
      peerEvidence: peers.evidence,
    };
  }
  if (current && satisfiesNpmConstraint(current.version, declaration.source.spec)) {
    const retained = resolveCurrent(resource, required, current, host);
    if (retained.action === "keep") {
      retained.reason = "no newer compatible candidate was found; retain the current compatible version";
      return retained;
    }
    if (retained.action === "blocked") return retained;
  }
  const reasons = [
    sawIncompatible ? "candidates exclude the target host" : "",
    sawUnknown ? "candidate compatibility is unknown" : "",
    sawMissingIntegrity ? "candidate integrity is missing" : "",
    currentError ?? "",
  ].filter(Boolean);
  return emptyResource(
    resource,
    required,
    current?.version ?? null,
    current && !required ? "unknown" : "blocked",
    reasons.join("; ") || "no candidate satisfies the Bundle and target host",
  );
}

function selectedResources(bundle: ResolvedBundle, selected: string[]): ResolvedResource[] {
  const unique = [...new Set(selected)];
  for (const id of unique) {
    if (!bundle.resources[id]) throw new Error(`resource is not active in the effective Bundle: ${id}`);
    if (!id.startsWith("npm:")) throw new Error(`resolve currently supports only npm resources: ${id}`);
  }
  return Object.values(bundle.resources)
    .filter((resource) => resource.id.startsWith("npm:") && (unique.length === 0 || unique.includes(resource.id)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const METADATA_CONCURRENCY = 4;

async function eachLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  });
  await Promise.all(runners);
}

export async function resolveConfiguration(
  context: Context,
  bundle: ResolvedBundle,
  selected: string[],
  client: MetadataClient,
): Promise<ResolveReport> {
  const resources = selectedResources(bundle, selected);
  const currentHost = resolveHost(context);
  const progress = context.progress ?? (() => {});
  const errors: Array<{ source: string; message: string }> = [];
  let host: HostResolution | null = null;
  progress("resolving the Pi release channel…");
  try {
    const release = await client.getRelease();
    if (!isObject(release) || typeof release.version !== "string" || !validNpmConstraint(release.version, true)) {
      throw new Error("Pi release response has no valid exact version");
    }
    if (release.packageName !== undefined && release.packageName !== HOST_PACKAGE) {
      throw new Error(`Pi release package identity is unexpected: ${String(release.packageName)}`);
    }
    const comparison = compareNpmVersions(release.version, currentHost.version);
    if (comparison === null) throw new Error("current or released Pi version is invalid");
    const compatibleRange = bundle.release?.hostCompatible;
    const currentAllowed = compatibleRange ? satisfiesPeerRange(currentHost.version, compatibleRange) : true;
    const releaseAllowed = compatibleRange ? satisfiesPeerRange(release.version, compatibleRange) : true;
    if (currentAllowed === null || releaseAllowed === null) throw new Error("Release host compatibility range is unsupported");
    if (currentAllowed === false && (comparison <= 0 || releaseAllowed !== true)) {
      throw new Error(`current Pi ${currentHost.version} is outside ${compatibleRange}; the release channel cannot provide a newer compatible host`);
    }
    const update = comparison > 0 && releaseAllowed === true;
    const targetVersion = update ? release.version : currentHost.version;
    host = {
      currentVersion: currentHost.version,
      targetVersion,
      action: update ? "update" : "keep",
      source: "pi-release-channel",
      reason: update
        ? `Pi release channel selects a newer host${compatibleRange ? ` within ${compatibleRange}` : ""}`
        : compatibleRange && releaseAllowed === false
          ? `current host satisfies ${compatibleRange}; the newer release is outside that range`
          : "current host is at or above the release version; no downgrade is planned",
      ...(compatibleRange ? { compatibleRange } : {}),
      dependencies: {},
    };
    const hostManifestValue = await client.getManifest(HOST_PACKAGE, targetVersion);
    const hostManifest = manifest(hostManifestValue, HOST_PACKAGE, targetVersion);
    if (!hostManifest) throw new Error(`registry manifest for ${HOST_PACKAGE}@${targetVersion} is invalid`);
    host.dependencies = Object.fromEntries(Object.entries(hostManifest.dependencies)
      .filter(([name]) => name.startsWith("@earendil-works/pi-")));
    if (hostManifest.integrity) host.integrity = hostManifest.integrity;
    if (update && !hostManifest.integrity) throw new Error(`registry integrity for ${HOST_PACKAGE}@${targetVersion} is missing`);
    progress(`target host ${targetVersion} (${host.action})`);
  } catch (error) {
    errors.push({ source: "pi.host", message: redact(error instanceof Error ? error.message : String(error)) });
  }

  const resolved: ResourceResolution[] = [];
  const fetchable = host
    ? resources.filter((resource) => (resource.declaration as NpmDeclaration).update === "compatible" || releasePinned(resource))
    : [];
  const packuments = new Map<string, unknown>();
  const pinManifests = new Map<string, unknown>();
  const failures = new Map<string, Error>();
  if (fetchable.length > 0) {
    progress(`resolving ${fetchable.length} npm resource(s)…`);
    let completed = 0;
    await eachLimit(fetchable, METADATA_CONCURRENCY, async (resource) => {
      progress(`resolving ${resource.id}…`);
      try {
        if (releasePinned(resource)) {
          const declaration = resource.declaration as NpmDeclaration;
          pinManifests.set(resource.id, await client.getManifest(packageForResource(resource.id), declaration.source.spec));
        } else {
          packuments.set(resource.id, await client.getPackument(packageForResource(resource.id)));
        }
      } catch (error) {
        failures.set(resource.id, error instanceof Error ? error : new Error(String(error)));
      }
      completed += 1;
      progress(`resolved ${completed}/${fetchable.length}…`);
    });
  }
  for (const resource of resources) {
    const required = bundle.required.includes(resource.id);
    const name = packageForResource(resource.id);
    const installed = installedManifest(context, name);
    if (!host) {
      resolved.push(emptyResource(resource, required, installed.value?.version ?? null, required ? "blocked" : "unknown", "target host metadata is unavailable"));
      continue;
    }
    const declaration = resource.declaration as NpmDeclaration;
    const failure = failures.get(resource.id);
    if (releasePinned(resource)) {
      if (failure) {
        errors.push({ source: resource.id, message: redact(failure.message) });
        resolved.push({
          ...emptyResource(resource, required, installed.value?.version ?? null, "blocked", `Release pin metadata is unavailable: ${redact(failure.message)}`),
          releasePin: true,
          integrity: declaration.source.integrity,
        });
      } else {
        resolved.push(resolveReleasePin(resource, required, installed.value, pinManifests.get(resource.id), host));
      }
      continue;
    }
    if (declaration.update !== "compatible") {
      if (installed.value) resolved.push(resolveCurrent(resource, required, installed.value, host));
      else resolved.push(emptyResource(resource, required, null, required ? "blocked" : "unknown", installed.error ?? "current package is unavailable"));
      continue;
    }
    if (failure) {
      errors.push({ source: resource.id, message: redact(failure.message) });
      resolved.push(emptyResource(
        resource,
        required,
        installed.value?.version ?? null,
        installed.value && !required ? "unknown" : "blocked",
        `npm metadata is unavailable: ${redact(failure.message)}`,
      ));
      continue;
    }
    resolved.push(resolveCompatible(resource, required, installed.value, installed.value ? null : installed.error, packuments.get(resource.id), host));
  }

  const hostNeedsUpdate = host?.action === "update";
  const hasUnknown = resolved.some((resource) => resource.action === "unknown");
  const hasBlocked = resolved.some((resource) => resource.action === "blocked");
  const ready = host !== null && errors.length === 0 && !hasBlocked && !(hostNeedsUpdate && hasUnknown);
  return {
    schemaVersion: 1,
    ready,
    complete: errors.length === 0 && !hasUnknown,
    host,
    resources: resolved,
    errors,
    ...(bundle.release ? { release: { name: bundle.release.name, ...(bundle.release.hostCompatible ? { hostCompatible: bundle.release.hostCompatible } : {}) } } : {}),
  };
}
