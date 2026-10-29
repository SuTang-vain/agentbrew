import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertInside, isInside, type Context } from "./context.js";
import { assertProcessSuccess, runProcess } from "./process.js";
import { HOST_PACKAGE, readPiManifest } from "./providers/pi.js";
import { writeStateJson } from "./state.js";
import { failedStep, successfulStep, type StepResult } from "./types.js";

export interface LockedNpmResource {
  id: string;
  name: string;
  version: string;
  integrity?: string;
}

interface NpmLock {
  lockfileVersion: number;
  packages: Record<string, {
    version?: string;
    integrity?: string;
    dependencies?: Record<string, string>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

function exactVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function safePackageName(name: string): void {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
    || name === HOST_PACKAGE || name.startsWith("@earendil-works/pi-")) {
    throw new Error(`unsafe external npm package in locked plan: ${name}`);
  }
}

function writeJsonAtomic(file: string, value: unknown, root: string): void {
  assertInside(file, root);
  const realRoot = fs.realpathSync(root);
  const realParent = fs.realpathSync(path.dirname(file));
  if (!isInside(realParent, realRoot)) throw new Error(`refusing to write through a directory link outside ${root}`);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function lockEntry(lock: NpmLock, name: string): { version?: string; integrity?: string } {
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry) throw new Error(`generated package-lock has no direct entry for ${name}`);
  return entry;
}

export function installLockedNpmResources(context: Context, resources: LockedNpmResource[]): StepResult {
  const label = "Install the complete exact-version npm lock plan without lifecycle scripts";
  let stageDir: string | null = null;
  let targetWriteStarted = false;
  try {
    const manifest = readPiManifest(context);
    const manifestText = fs.readFileSync(path.join(context.npmDir, "package.json"), "utf8");
    const lockFile = path.join(context.npmDir, "package-lock.json");
    const previousLockText = fs.existsSync(lockFile) ? fs.readFileSync(lockFile, "utf8") : null;
    const externalNames = Object.keys(manifest.dependencies)
      .filter((name) => name !== HOST_PACKAGE && !name.startsWith("@earendil-works/pi-"))
      .sort();
    const byName = new Map(resources.map((resource) => [resource.name, resource]));
    if (byName.size !== resources.length || externalNames.length !== byName.size
      || externalNames.some((name) => !byName.has(name))) {
      throw new Error("the locked npm plan does not exactly cover all local direct external dependencies");
    }

    const exactDependencies = { ...manifest.dependencies };
    for (const resource of resources) {
      safePackageName(resource.name);
      if (!exactVersion(resource.version)) throw new Error(`invalid exact version in locked npm plan: ${resource.id}`);
      exactDependencies[resource.name] = resource.version;
    }

    fs.mkdirSync(context.stateDir, { recursive: true, mode: 0o700 });
    stageDir = path.join(context.stateDir, `.npm-plan-${process.pid}-${randomUUID()}`);
    fs.mkdirSync(stageDir, { mode: 0o700 });
    fs.writeFileSync(path.join(stageDir, "package.json"), `${JSON.stringify({ ...manifest, dependencies: exactDependencies }, null, 2)}\n`);
    for (const [name, spec] of Object.entries(manifest.dependencies)) {
      if (name !== HOST_PACKAGE && !name.startsWith("@earendil-works/pi-")) continue;
      if (!spec.startsWith("file:")) throw new Error(`host dependency is not portable before locked installation: ${name}`);
      const source = path.resolve(context.npmDir, spec.slice(5));
      assertInside(source, context.npmDir);
      const target = fs.realpathSync(source);
      const link = path.join(stageDir, spec.slice(5));
      assertInside(link, stageDir);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link, "dir");
    }

    const prepared = runProcess("npm", ["install", "--package-lock-only", "--ignore-scripts", "--legacy-peer-deps"], {
      cwd: stageDir,
      env: context.env,
      timeout: 600_000,
    });
    assertProcessSuccess(prepared);
    const lock = JSON.parse(fs.readFileSync(path.join(stageDir, "package-lock.json"), "utf8")) as NpmLock;
    if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object" || !lock.packages[""]) {
      throw new Error("npm did not produce a supported lockfileVersion 3 plan");
    }
    for (const resource of resources) {
      const entry = lockEntry(lock, resource.name);
      if (entry.version !== resource.version) {
        throw new Error(`locked version mismatch for ${resource.id}: expected ${resource.version}, found ${entry.version ?? "missing"}`);
      }
      if (!entry.integrity) throw new Error(`locked registry integrity is missing for ${resource.id}`);
      if (resource.integrity && entry.integrity !== resource.integrity) {
        throw new Error(`locked integrity differs from resolved registry evidence for ${resource.id}`);
      }
    }
    lock.packages[""].dependencies = Object.fromEntries(Object.entries(manifest.dependencies)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    const lockText = `${JSON.stringify(lock, null, 2)}\n`;
    const lockHash = createHash("sha256").update(lockText).digest("hex");
    writeStateJson(context, "last-install-plan.json", {
      schemaVersion: 1,
      kind: "agentbrew-npm-lock-plan",
      resources: resources.map(({ id, name, version, integrity }) => ({ id, name, version, ...(integrity ? { integrity } : {}) })),
      packageLockSha256: lockHash,
      artifactVerification: "npm uses lock integrity for registry artifact retrieval; Agentbrew does not independently hash installed trees or verify the Pi host artifact",
    });
    writeStateJson(context, "last-package-lock.plan.json", lock);

    if (fs.readFileSync(path.join(context.npmDir, "package.json"), "utf8") !== manifestText
      || (fs.existsSync(lockFile) ? fs.readFileSync(lockFile, "utf8") : null) !== previousLockText) {
      throw new Error("npm manifest or package-lock changed while preparing the exact-version plan");
    }
    targetWriteStarted = true;
    writeJsonAtomic(lockFile, lock, context.agentDir);
    const installed = runProcess("npm", ["install", "--ignore-scripts", "--legacy-peer-deps"], {
      cwd: context.npmDir,
      env: context.env,
      timeout: 600_000,
    });
    assertProcessSuccess(installed);
    if (fs.readFileSync(path.join(context.npmDir, "package.json"), "utf8") !== manifestText) {
      throw new Error("npm changed the portable dependency manifest during locked installation");
    }
    const actualLock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (!isDeepStrictEqual(actualLock, lock)) {
      throw new Error("npm changed the reviewed package-lock content during locked installation");
    }
    for (const resource of resources) {
      const file = path.join(context.npmDir, "node_modules", resource.name, "package.json");
      const actual = JSON.parse(fs.readFileSync(file, "utf8"));
      if (actual.name !== resource.name || actual.version !== resource.version) {
        throw new Error(`installed package mismatch for ${resource.id}: expected ${resource.name}@${resource.version}, found ${actual.name ?? "unknown"}@${actual.version ?? "unknown"}`);
      }
      const entry = lockEntry(lock, resource.name);
      if (entry.version !== actual.version) throw new Error(`package-lock and installed version differ for ${resource.id}`);
    }
    return successfulStep("npm-install", label, "observed", `${resources.length} direct external package(s) locked exactly`);
  } catch (error) {
    return failedStep("npm-install", label, error, targetWriteStarted ? "unknown" : "none");
  } finally {
    if (stageDir && isInside(stageDir, context.stateDir) && path.basename(stageDir).startsWith(".npm-plan-")) {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  }
}
