import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Context } from "./context.js";
import { createMetadataClient, type MetadataClient } from "./metadata.js";
import { validNpmConstraint } from "./npm-spec.js";
import { validateReleaseIntegrity } from "./release.js";
import { HOST_PACKAGE } from "./providers/pi.js";

const INSTALLER_PACKAGE = "@earendil-works/pi-coding-agent-install";

export interface PiArtifactEvidence {
  name: string;
  version: string;
  resolved: string;
  integrity: string;
}

export interface PiArtifactPlan {
  targetVersion: string;
  packageJson: string;
  packageLock: string;
  packageJsonSha256: string;
  packageLockSha256: string;
  artifacts: PiArtifactEvidence[];
}

interface LockEntry {
  version?: unknown;
  resolved?: unknown;
  integrity?: unknown;
  [key: string]: unknown;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validIntegrity(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^sha(1|256|384|512)-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const lengths: Record<string, number> = { "1": 20, "256": 32, "384": 48, "512": 64 };
  return Buffer.from(match[2]!, "base64").length === lengths[match[1]!];
}

function registryUrl(value: unknown, where: string): string {
  if (typeof value !== "string") throw new Error(`${where} requires a registry URL`);
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error(`${where} must use HTTPS`);
  if (url.username || url.password) throw new Error(`${where} must not contain credentials`);
  return value;
}

function packageName(lockPath: string): string {
  const marker = "node_modules/";
  const index = lockPath.lastIndexOf(marker);
  if (index < 0) throw new Error(`installer lock entry has an invalid package path: ${lockPath}`);
  const name = lockPath.slice(index + marker.length);
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error(`installer lock entry has an unsafe package identity: ${name}`);
  }
  return name;
}

function internalPiPackage(name: string): boolean {
  return name === HOST_PACKAGE || name.startsWith("@earendil-works/pi-");
}

function manifestEvidence(value: unknown, name: string, version: string, resolved: string): PiArtifactEvidence {
  if (!object(value) || value.name !== name || value.version !== version || !object(value.dist)) {
    throw new Error(`registry manifest for ${name}@${version} does not match the installer lock`);
  }
  const integrity = validateReleaseIntegrity(value.dist.integrity, `${name}@${version} integrity`);
  if (value.dist.tarball !== resolved) throw new Error(`installer and registry tarball URLs differ for ${name}@${version}`);
  return { name, version, resolved, integrity };
}

export async function preparePiArtifacts(
  context: Context,
  targetVersion: string,
  client: MetadataClient = createMetadataClient({
    releaseUrl: context.env.AGENTBREW_PI_RELEASE_URL,
    registryUrl: context.env.AGENTBREW_NPM_REGISTRY_URL,
    installerUrl: context.env.AGENTBREW_PI_INSTALLER_URL,
    signal: context.signal,
  }),
): Promise<PiArtifactPlan> {
  if (!validNpmConstraint(targetVersion, true)) throw new Error(`invalid target Pi version: ${targetVersion}`);
  const [installerValue, lockValue] = await Promise.all([
    client.getInstallerManifest(targetVersion),
    client.getInstallerLock(targetVersion),
  ]);
  if (!object(installerValue) || installerValue.name !== INSTALLER_PACKAGE || installerValue.version !== targetVersion
    || !object(installerValue.dependencies) || installerValue.dependencies[HOST_PACKAGE] !== targetVersion) {
    throw new Error(`installer manifest does not identify ${INSTALLER_PACKAGE}@${targetVersion}`);
  }
  if (!object(lockValue) || lockValue.lockfileVersion !== 3 || !object(lockValue.packages) || !object(lockValue.packages[""])) {
    throw new Error("Pi installer did not provide a supported lockfileVersion 3 document");
  }
  const root = lockValue.packages[""];
  if (root.name !== INSTALLER_PACKAGE || root.version !== targetVersion
    || !object(root.dependencies) || root.dependencies[HOST_PACKAGE] !== targetVersion) {
    throw new Error("Pi installer lock root does not match the reviewed target");
  }

  const packages = lockValue.packages as Record<string, LockEntry>;
  const internal: Array<{ path: string; entry: LockEntry; name: string; version: string; resolved: string }> = [];
  for (const [lockPath, entry] of Object.entries(packages)) {
    if (lockPath === "") continue;
    if (!object(entry)) throw new Error(`installer lock entry ${lockPath} must be an object`);
    const name = packageName(lockPath);
    if (typeof entry.version !== "string" || !validNpmConstraint(entry.version, true)) {
      throw new Error(`installer lock entry ${name} has no valid exact version`);
    }
    const resolved = registryUrl(entry.resolved, `${name}@${entry.version} resolved URL`);
    if (internalPiPackage(name)) {
      internal.push({ path: lockPath, entry, name, version: entry.version, resolved });
    } else if (!validIntegrity(entry.integrity)) {
      throw new Error(`installer lock entry ${name}@${entry.version} has no valid registry integrity`);
    }
  }
  const host = internal.find((entry) => entry.name === HOST_PACKAGE);
  if (!host || host.version !== targetVersion) throw new Error("Pi installer lock does not contain the exact target host package");
  const artifacts = await Promise.all(internal.map(async (entry) => {
    const evidence = manifestEvidence(await client.getManifest(entry.name, entry.version), entry.name, entry.version, entry.resolved);
    entry.entry.integrity = evidence.integrity;
    return evidence;
  }));
  artifacts.sort((left, right) => left.name.localeCompare(right.name));
  const packageJson = `${JSON.stringify(installerValue, null, 2)}\n`;
  const packageLock = `${JSON.stringify(lockValue, null, 2)}\n`;
  return {
    targetVersion,
    packageJson,
    packageLock,
    packageJsonSha256: hash(packageJson),
    packageLockSha256: hash(packageLock),
    artifacts,
  };
}

export function piArtifactEvidence(plan: PiArtifactPlan): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "agentbrew-pi-install-plan",
    targetVersion: plan.targetVersion,
    packageJsonSha256: plan.packageJsonSha256,
    packageLockSha256: plan.packageLockSha256,
    artifacts: plan.artifacts,
    verification: "reviewed installer documents bind native npm ci retrieval to registry integrity; this is not a signature or runtime safety proof",
  };
}

export function assertTargetReleaseUnavailable(context: Context, targetVersion: string): void {
  const releaseDir = path.join(context.agentDir, "install", "releases", targetVersion);
  if (fs.existsSync(releaseDir)) {
    throw new Error(`target Pi release ${targetVersion} already exists without a verifiable artifact-binding path; inspect or remove that inactive release explicitly before retrying`);
  }
}

export async function withVerifiedPiInstaller<T>(plan: PiArtifactPlan, operation: (installerBase: string) => Promise<T>): Promise<T> {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const body = request.method === "GET" && pathname === `/${encodeURIComponent(plan.targetVersion)}/package.json`
      ? plan.packageJson
      : request.method === "GET" && pathname === `/${encodeURIComponent(plan.targetVersion)}/package-lock.json`
        ? plan.packageLock
        : null;
    if (body === null) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not bind the reviewed Pi installer to loopback");
  }
  try {
    return await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}
