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
  peerEvidence: PeerEvidence[];
}

export interface ResolveReport {
  schemaVersion: 1;
  ready: boolean;
  complete: boolean;
  host: HostResolution | null;
  resources: ResourceResolution[];
  errors: Array<{ source: string; message: string }>;
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
    const update = comparison > 0;
    const targetVersion = update ? release.version : currentHost.version;
    host = {
      currentVersion: currentHost.version,
      targetVersion,
      action: update ? "update" : "keep",
      source: "pi-release-channel",
      reason: update ? "Pi release channel selects a newer host" : "current host is at or above the release version; no downgrade is planned",
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
  if (resources.length > 0) progress(`resolving ${resources.length} npm resource(s)…`);
  for (const [index, resource] of resources.entries()) {
    progress(`resolving ${resource.id} (${index + 1}/${resources.length})…`);
    const required = bundle.required.includes(resource.id);
    const name = packageForResource(resource.id);
    const installed = installedManifest(context, name);
    if (!host) {
      resolved.push(emptyResource(resource, required, installed.value?.version ?? null, required ? "blocked" : "unknown", "target host metadata is unavailable"));
      continue;
    }
    const declaration = resource.declaration as NpmDeclaration;
    if (declaration.update !== "compatible") {
      if (installed.value) resolved.push(resolveCurrent(resource, required, installed.value, host));
      else resolved.push(emptyResource(resource, required, null, required ? "blocked" : "unknown", installed.error ?? "current package is unavailable"));
      continue;
    }
    try {
      const packument = await client.getPackument(name);
      resolved.push(resolveCompatible(resource, required, installed.value, installed.value ? null : installed.error, packument, host));
    } catch (error) {
      errors.push({ source: resource.id, message: redact(error instanceof Error ? error.message : String(error)) });
      resolved.push(emptyResource(
        resource,
        required,
        installed.value?.version ?? null,
        installed.value && !required ? "unknown" : "blocked",
        `npm metadata is unavailable: ${redact(error instanceof Error ? error.message : String(error))}`,
      ));
    }
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
  };
}
