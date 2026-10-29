import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertInside, isInside, type Context } from "../context.js";
import { assertProcessSuccess, formatCommand, runProcess, runProcessAsync } from "../process.js";
import type { ResolvedBundle } from "../bundle.js";
import { satisfiesPeerRange } from "../npm-spec.js";
import { sourceRegistrationFingerprint } from "../source-state.js";
import {
  failedStep,
  successfulStep,
  type ChangeState,
  type Difference,
  type HealthCheck,
  type StepResult,
} from "../types.js";

export const HOST_PACKAGE = "@earendil-works/pi-coding-agent";

export interface HostInfo {
  dir: string;
  version: string;
  source: "managed" | "path" | "npm-global";
}

export interface PiInspection {
  host: HostInfo;
  hostDependencies: string[];
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function validVersion(version: unknown): version is string {
  return typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
}

function hostAt(dir: string, source: HostInfo["source"]): HostInfo | null {
  try {
    const manifest = readJson(path.join(dir, "package.json"));
    if (manifest.name !== HOST_PACKAGE || !validVersion(manifest.version)) return null;
    return { dir: path.resolve(dir), version: manifest.version, source };
  } catch {
    return null;
  }
}

function managedHosts(context: Context): HostInfo[] {
  const defaultRoot = path.join(os.homedir(), ".pi", "agent");
  const roots = context.agentDirExplicit ? [context.agentDir] : [context.agentDir, defaultRoot];
  const hosts: HostInfo[] = [];
  for (const root of new Set(roots)) {
    try {
      const version = fs.readFileSync(path.join(root, "install", "current-version"), "utf8").trim();
      if (!validVersion(version)) continue;
      const host = hostAt(
        path.join(root, "install", "releases", version, "node_modules", HOST_PACKAGE),
        "managed",
      );
      if (host) hosts.push(host);
    } catch {
      // Try the next host layout.
    }
  }
  return hosts;
}

function hostFromExecutable(context: Context, executable: string): HostInfo | null {
  try {
    if (isInside(executable, context.npmDir)) return null;
    const real = fs.realpathSync(executable);
    if (isInside(real, context.npmDir)) return null;
    let dir = path.dirname(real);
    while (true) {
      const host = hostAt(dir, "path");
      if (host) return host;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

function pathHosts(context: Context): HostInfo[] {
  const hosts: HostInfo[] = [];
  for (const entry of (context.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const host = hostFromExecutable(context, path.join(entry, "pi"));
    if (host) hosts.push(host);
  }
  return hosts;
}

function globalNpmHost(context: Context): HostInfo | null {
  const result = runProcess("npm", ["root", "-g"], { env: context.env, timeout: 30_000 });
  if (result.status !== 0) return null;
  return hostAt(path.join(result.stdout.trim(), HOST_PACKAGE), "npm-global");
}

export function resolveHost(context: Context): HostInfo {
  const host = managedHosts(context)[0] ?? pathHosts(context)[0] ?? globalNpmHost(context);
  if (!host) {
    throw new Error(`cannot locate the active ${HOST_PACKAGE} package; checked managed installs, PATH, and npm root -g`);
  }
  return host;
}

function manifestPath(context: Context): string {
  return path.join(context.npmDir, "package.json");
}

function readManifest(context: Context): { dependencies: Record<string, string>; [key: string]: unknown } {
  const manifest = readJson(manifestPath(context));
  if (!manifest || typeof manifest !== "object" || !manifest.dependencies || typeof manifest.dependencies !== "object") {
    throw new Error(`${manifestPath(context)} must contain a dependencies object`);
  }
  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    if (typeof spec !== "string") throw new Error(`dependency ${name} must have a string specifier`);
  }
  return manifest;
}

function hostDependencyNames(context: Context): string[] {
  const manifest = readManifest(context);
  return Object.keys(manifest.dependencies).filter((name) => {
    if (!name.startsWith("@earendil-works/pi-") || name === HOST_PACKAGE) return false;
    if (!/^@earendil-works\/pi-[a-z0-9][a-z0-9._-]*$/.test(name)) {
      throw new Error(`unsafe host dependency name: ${name}`);
    }
    return true;
  });
}

function hostDependencyTarget(host: HostInfo, name: string): string {
  const target = path.join(path.dirname(host.dir), path.basename(name));
  assertInside(target, path.dirname(host.dir));
  let manifest: any;
  try {
    manifest = readJson(path.join(target, "package.json"));
  } catch {
    throw new Error(`host dependency ${name} is not available beside the active host`);
  }
  if (manifest.name !== name) {
    throw new Error(`host dependency at ${target} has unexpected package name ${manifest.name}`);
  }
  return target;
}

function hostLink(context: Context): string {
  return path.join(context.npmDir, "host-link");
}

function peerLink(context: Context, name: string): string {
  return path.join(context.npmDir, "host-deps", path.basename(name));
}

function expectedSpecs(context: Context): Record<string, string> {
  const specs: Record<string, string> = { [HOST_PACKAGE]: "file:host-link" };
  for (const name of hostDependencyNames(context)) {
    specs[name] = `file:host-deps/${path.basename(name)}`;
  }
  return specs;
}

export function inspectPi(context: Context): PiInspection {
  return { host: resolveHost(context), hostDependencies: hostDependencyNames(context) };
}

function linkDescription(link: string): string {
  try {
    const stat = fs.lstatSync(link);
    if (!stat.isSymbolicLink()) return "not a symlink";
    return fs.readlinkSync(link);
  } catch {
    return "missing";
  }
}

function linkMatches(link: string, target: string): boolean {
  try {
    const stat = fs.lstatSync(link);
    if (!stat.isSymbolicLink()) return false;
    return fs.realpathSync(link) === fs.realpathSync(target);
  } catch {
    return false;
  }
}

export function diffPi(context: Context): Difference[] {
  const { host } = inspectPi(context);
  const manifest = readManifest(context);
  const differences: Difference[] = [];
  const specs = expectedSpecs(context);
  for (const [name, expected] of Object.entries(specs)) {
    const actual = manifest.dependencies[name] ?? "missing";
    if (actual !== expected) {
      differences.push({ resource: name, kind: "dependency-spec", expected, actual });
    }
  }

  const expectedHostLink = hostLink(context);
  if (!linkMatches(expectedHostLink, host.dir)) {
    differences.push({ resource: HOST_PACKAGE, kind: "host-link", expected: host.dir, actual: linkDescription(expectedHostLink) });
  }
  for (const name of hostDependencyNames(context)) {
    const link = peerLink(context, name);
    const target = hostDependencyTarget(host, name);
    if (!linkMatches(link, target)) {
      differences.push({ resource: name, kind: "host-dependency-link", expected: target, actual: linkDescription(link) });
    }
  }
  return differences;
}

function assertReplaceableLink(link: string): void {
  try {
    const stat = fs.lstatSync(link);
    if (!stat.isSymbolicLink()) throw new Error(`${link} exists and is not a symlink; refusing to replace it`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function assertSafeWritePath(file: string, root: string): void {
  assertInside(file, root);
  if (!fs.existsSync(root)) return;
  const realRoot = fs.realpathSync(root);
  let ancestor = path.dirname(file);
  while (!fs.existsSync(ancestor) && ancestor !== root) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (!isInside(fs.realpathSync(ancestor), realRoot)) {
    throw new Error(`refusing to write through a directory link outside ${root}`);
  }
}

function ensureLink(context: Context, link: string, target: string, dryRun: boolean): ChangeState {
  assertSafeWritePath(link, context.agentDir);
  if (linkMatches(link, target)) return "none";
  assertReplaceableLink(link);
  if (dryRun) return "observed";

  fs.mkdirSync(path.dirname(link), { recursive: true });
  assertSafeWritePath(link, context.agentDir);
  const temporary = path.join(path.dirname(link), `.agentbrew-link-${process.pid}-${randomUUID()}`);
  try {
    fs.symlinkSync(target, temporary, "dir");
    fs.renameSync(temporary, link);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return "observed";
}

function writeManifest(context: Context, manifest: { dependencies: Record<string, string>; [key: string]: unknown }): void {
  assertSafeWritePath(manifestPath(context), context.agentDir);
  const temporary = `${manifestPath(context)}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(temporary, manifestPath(context));
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function writeManifestIfNeeded(context: Context, selectedNames?: Set<string>): ChangeState {
  const manifest = readManifest(context);
  const specs = expectedSpecs(context);
  let changed = false;
  for (const [name, spec] of Object.entries(specs)) {
    if (selectedNames && !selectedNames.has(name)) continue;
    if (manifest.dependencies[name] === spec) continue;
    manifest.dependencies[name] = spec;
    changed = true;
  }
  if (!changed) return "none";
  if (context.dryRun) return "observed";
  writeManifest(context, manifest);
  return "observed";
}

export function setSelectedNpmDependencies(
  context: Context,
  selections: Array<{ name: string; spec: string | null }>,
): StepResult {
  const label = "Apply only selected Bundle npm declarations";
  try {
    const manifest = readManifest(context);
    let changed = false;
    for (const selection of selections) {
      if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(selection.name)
        || selection.name === HOST_PACKAGE
        || selection.name.startsWith("@earendil-works/pi-")) {
        throw new Error(`unsafe or machine-local npm package in Bundle action: ${selection.name}`);
      }
      if (selection.spec === null) {
        if (!(selection.name in manifest.dependencies)) throw new Error(`cannot repeat an already completed removal: ${selection.name}`);
        delete manifest.dependencies[selection.name];
      } else {
        if (manifest.dependencies[selection.name] === selection.spec) throw new Error(`declaration is already converged: ${selection.name}`);
        manifest.dependencies[selection.name] = selection.spec;
      }
      changed = true;
    }
    if (changed && !context.dryRun) writeManifest(context, manifest);
    return successfulStep("bundle-npm-declarations", label, changed ? "observed" : "none", `${selections.length} selected package(s)`);
  } catch (error) {
    return failedStep("bundle-npm-declarations", label, error, "none");
  }
}

function reconcileLinks(context: Context, host: HostInfo): StepResult {
  const label = "Repair host links and portable dependency declarations";
  try {
    assertReplaceableLink(hostLink(context));
    for (const name of hostDependencyNames(context)) assertReplaceableLink(peerLink(context, name));

    let changed = false;
    if (!context.dryRun) fs.mkdirSync(context.npmDir, { recursive: true });
    const hostChange = ensureLink(context, hostLink(context), host.dir, context.dryRun);
    changed ||= hostChange === "observed";
    for (const name of hostDependencyNames(context)) {
      const change = ensureLink(context, peerLink(context, name), hostDependencyTarget(host, name), context.dryRun);
      changed ||= change === "observed";
    }
    const manifestChange = writeManifestIfNeeded(context);
    changed ||= manifestChange === "observed";
    return successfulStep("pi-links", label, changed ? "observed" : "none", `host ${host.version}`);
  } catch (error) {
    return failedStep("pi-links", label, error);
  }
}

function verifyInstalledLinks(context: Context, host: HostInfo): void {
  const manifest = readManifest(context);
  const specs = expectedSpecs(context);
  for (const [name, expected] of Object.entries(specs)) {
    if (manifest.dependencies[name] !== expected) throw new Error(`npm changed the portable specifier for ${name}`);
  }
  if (!linkMatches(hostLink(context), host.dir)) throw new Error("host-link does not resolve to the active host");
  const installedHost = path.join(context.npmDir, "node_modules", HOST_PACKAGE);
  if (!linkMatches(installedHost, host.dir)) throw new Error(`npm did not link ${HOST_PACKAGE} to the active host`);
  for (const name of hostDependencyNames(context)) {
    const target = hostDependencyTarget(host, name);
    if (!linkMatches(peerLink(context, name), target)) throw new Error(`host dependency link is incorrect for ${name}`);
    const installed = path.join(context.npmDir, "node_modules", name);
    if (!linkMatches(installed, target)) throw new Error(`npm did not link ${name} to the active host dependency`);
  }
}

function installDependencies(context: Context, host: HostInfo): StepResult {
  const label = "Install npm dependencies against the active host";
  try {
    if (!context.dryRun) {
      const result = runProcess("npm", ["install", "--legacy-peer-deps"], {
        cwd: context.npmDir,
        env: context.env,
        timeout: 600_000,
      });
      assertProcessSuccess(result);
      verifyInstalledLinks(context, host);
    }
    return successfulStep("npm-install", label, context.dryRun ? "none" : "unknown");
  } catch (error) {
    return failedStep("npm-install", label, error);
  }
}

export function installSelectedBundleDependencies(context: Context): StepResult {
  const label = "Install selected Bundle npm dependencies without lifecycle scripts";
  try {
    const host = resolveHost(context);
    const result = runProcess("npm", ["install", "--ignore-scripts", "--legacy-peer-deps"], {
      cwd: context.npmDir,
      env: context.env,
      timeout: 600_000,
    });
    assertProcessSuccess(result);
    verifyInstalledLinks(context, host);
    return successfulStep("bundle-npm-install", label, "unknown");
  } catch (error) {
    return failedStep("bundle-npm-install", label, error);
  }
}

export function preflightPi(context: Context): PiInspection {
  const inspection = inspectPi(context);
  assertReplaceableLink(hostLink(context));
  for (const name of inspection.hostDependencies) {
    assertReplaceableLink(peerLink(context, name));
    hostDependencyTarget(inspection.host, name);
  }
  return inspection;
}

export function updatePiHost(context: Context): StepResult {
  const label = "Update Pi and configured extensions with the native updater";
  try {
    const result = runProcess("pi", ["update", "--all"], {
      cwd: context.agentDir,
      env: context.env,
      timeout: 600_000,
    });
    assertProcessSuccess(result);
    const host = resolveHost(context);
    return successfulStep("pi-update", label, "unknown", `active host ${host.version}`);
  } catch (error) {
    return failedStep("pi-update", label, error);
  }
}

export function reconcilePi(context: Context): StepResult[] {
  let host: HostInfo;
  try {
    host = resolveHost(context);
  } catch (error) {
    return [failedStep("pi-links", "Resolve the active host after update", error)];
  }
  const links = reconcileLinks(context, host);
  if (links.status === "failed") return [links];
  return [links, installDependencies(context, host)];
}

export function verifyPiHost(context: Context, targetVersion: string): HostInfo {
  const host = resolveHost(context);
  if (host.version !== targetVersion) {
    throw new Error(`active Pi host is ${host.version}, but the resolved plan requires ${targetVersion}; extension execution is blocked`);
  }
  const result = runProcess("pi", ["--version"], { cwd: context.agentDir, env: context.env, timeout: 30_000 });
  assertProcessSuccess(result);
  const actual = result.stdout.trim().replace(/^pi\s+/, "");
  if (actual !== targetVersion) throw new Error(`pi --version reports ${actual || "an empty version"}, expected ${targetVersion}`);
  return host;
}

export async function updatePiHostTo(context: Context, targetVersion: string, installerBase: string): Promise<StepResult> {
  const label = `Update only the Pi host to the resolved version ${targetVersion}`;
  try {
    if (resolveHost(context).source !== "managed") throw new Error("only managed Pi installations support resolved host updates");
    const result = await runProcessAsync("pi", ["update", "--self"], {
      cwd: context.agentDir,
      env: { ...context.env, PI_INSTALLER_API_BASE: installerBase },
      timeout: 600_000,
    });
    assertProcessSuccess(result);
    verifyPiHost(context, targetVersion);
    return successfulStep("pi-host", label, "observed", `active host ${targetVersion}; extensions were not updated by Pi`);
  } catch (error) {
    return failedStep("pi-host", label, error);
  }
}

export function resolvedUpdateFingerprint(context: Context, bundle: ResolvedBundle): string {
  const hash = createHash("sha256");
  hash.update(piFingerprint(context));
  hash.update(`\0source-registration\0${sourceRegistrationFingerprint(context)}\0`);
  const lockFile = path.join(context.npmDir, "package-lock.json");
  hash.update("\0package-lock\0");
  hash.update(fs.existsSync(lockFile) ? fs.readFileSync(lockFile) : Buffer.from("<missing>"));
  for (const id of Object.keys(bundle.resources).sort()) {
    if (!id.startsWith("npm:")) continue;
    hash.update(`\0${id}\0`);
    try {
      hash.update(fs.readFileSync(path.join(context.npmDir, "node_modules", id.slice(4), "package.json")));
    } catch {
      hash.update("<missing>");
    }
  }
  return hash.digest("hex");
}

export function reconcileResolvedPi(
  context: Context,
  host: HostInfo,
  expectedDependencies: Record<string, string>,
): StepResult[] {
  const label = "Reconcile machine-local dependencies derived from the resolved host";
  try {
    const names = freshHostDependencies(host).sort();
    const expectedNames = Object.keys(expectedDependencies).sort();
    if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
      throw new Error(`target host dependency set differs from registry metadata: actual ${names.join(", ") || "none"}; expected ${expectedNames.join(", ") || "none"}`);
    }
    for (const [name, range] of Object.entries(expectedDependencies)) {
      const installed = readJson(path.join(hostDependencyTarget(host, name), "package.json"));
      if (!validVersion(installed.version) || satisfiesPeerRange(installed.version, range) !== true) {
        throw new Error(`host dependency ${name}@${String(installed.version)} does not satisfy the resolved ${range}`);
      }
    }
    const manifest = readManifest(context);
    const dependencies = Object.fromEntries(Object.entries(manifest.dependencies)
      .filter(([name]) => name === HOST_PACKAGE || !name.startsWith("@earendil-works/pi-")));
    dependencies[HOST_PACKAGE] = "file:host-link";
    for (const name of names) dependencies[name] = `file:host-deps/${path.basename(name)}`;
    const changed = JSON.stringify(manifest.dependencies) !== JSON.stringify(dependencies);
    if (changed) {
      manifest.dependencies = dependencies;
      writeManifest(context, manifest);
    }
    const declarations = successfulStep("pi-host-deps", label, changed ? "observed" : "none", `${names.length} target host dependency(ies)`);
    const links = reconcileLinks(context, host);
    if (links.status === "failed") return [declarations, links];
    return [declarations, links, repairPiGeneratedLinks(context, host)];
  } catch (error) {
    return [failedStep("pi-host-deps", label, error)];
  }
}

export function verifyPiInstallation(context: Context): void {
  verifyInstalledLinks(context, resolveHost(context));
}

export function piInstallationMatches(context: Context): boolean {
  try {
    verifyPiInstallation(context);
    return true;
  } catch {
    return false;
  }
}

export function doctorPi(context: Context): HealthCheck[] {
  const checks: HealthCheck[] = [];
  try {
    const inspection = inspectPi(context);
    checks.push({ resource: HOST_PACKAGE, status: "pass", message: `host ${inspection.host.version} (${inspection.host.source})` });
    const differences = diffPi(context);
    if (differences.length === 0) {
      checks.push({ resource: "pi.configuration", status: "pass", message: "portable declarations and host links are consistent" });
    } else {
      for (const difference of differences) {
        checks.push({ resource: difference.resource, status: "fail", message: `${difference.kind}: expected ${difference.expected}, found ${difference.actual}` });
      }
    }
    try {
      verifyInstalledLinks(context, inspection.host);
      checks.push({ resource: "pi.node-modules", status: "pass", message: "host packages resolve to the active installation" });
    } catch (error) {
      checks.push({ resource: "pi.node-modules", status: "fail", message: error instanceof Error ? error.message : String(error) });
    }
  } catch (error) {
    checks.push({ resource: HOST_PACKAGE, status: "fail", message: error instanceof Error ? error.message : String(error) });
  }
  if (!context.selftest) {
    checks.push({ resource: "pi.runtime-load", status: "warn", message: "extension loading is unknown unless --selftest is explicitly enabled" });
  }
  return checks;
}

export function piFingerprint(context: Context): string {
  const inspection = inspectPi(context);
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(manifestPath(context)));
  hash.update(`${inspection.host.dir}\0${inspection.host.version}\0`);
  for (const link of [hostLink(context), ...inspection.hostDependencies.map((name) => peerLink(context, name))]) {
    hash.update(`${link}\0${linkDescription(link)}\0`);
  }
  return hash.digest("hex");
}

export function snapshotPi(context: Context): unknown {
  const inspection = inspectPi(context);
  const links: Record<string, string> = { [hostLink(context)]: linkDescription(hostLink(context)) };
  for (const name of inspection.hostDependencies) links[peerLink(context, name)] = linkDescription(peerLink(context, name));
  const lockFile = path.join(context.npmDir, "package-lock.json");
  return {
    capturedAt: new Date().toISOString(),
    host: inspection.host,
    manifest: readManifest(context),
    packageLockText: fs.existsSync(lockFile) ? fs.readFileSync(lockFile, "utf8") : null,
    links,
  };
}

export function runSelftest(context: Context): StepResult {
  const label = "Run the explicitly trusted Pi configuration selftest";
  try {
    const result = runProcess("npm", ["run", "selftest"], {
      cwd: context.npmDir,
      env: context.env,
      timeout: 600_000,
    });
    assertProcessSuccess(result);
    return successfulStep("selftest", label, "none");
  } catch (error) {
    return failedStep("selftest", label, error, "none");
  }
}

export function describePiPlan(context: Context): string[] {
  const { host } = inspectPi(context);
  return [
    `current host: ${host.version} (${host.source})`,
    formatCommand("pi", ["update", "--all"]),
    "re-resolve the active host and repair host links",
    formatCommand("npm", ["install", "--legacy-peer-deps"]),
  ];
}

export function readPiManifest(context: Context): { dependencies: Record<string, string>; [key: string]: unknown } {
  return readManifest(context);
}

export function piManifestFile(context: Context): string {
  return manifestPath(context);
}

export function piHostDependencyNames(context: Context): string[] {
  return hostDependencyNames(context);
}

export function describePiLinks(context: Context, names: string[]): Array<{ path: string; state: string }> {
  return [
    hostLink(context),
    ...names.map((name) => peerLink(context, name)),
    path.join(context.npmDir, "node_modules", HOST_PACKAGE),
    ...names.map((name) => path.join(context.npmDir, "node_modules", name)),
  ].map((link) => ({ path: link, state: linkDescription(link) }));
}

export function verifyPiGeneratedLinks(context: Context, host: HostInfo, names: string[]): void {
  if (!linkMatches(hostLink(context), host.dir)) throw new Error("host-link does not resolve to the active host");
  const installedHost = path.join(context.npmDir, "node_modules", HOST_PACKAGE);
  if (!linkMatches(installedHost, host.dir)) throw new Error(`generated host package link is incorrect for ${HOST_PACKAGE}`);
  for (const name of names) {
    const target = hostDependencyTarget(host, name);
    if (!linkMatches(peerLink(context, name), target)) throw new Error(`host dependency link is incorrect for ${name}`);
    const installed = path.join(context.npmDir, "node_modules", name);
    if (!linkMatches(installed, target)) throw new Error(`generated host dependency link is incorrect for ${name}`);
  }
}

export function repairPiGeneratedLinks(context: Context, host: HostInfo): StepResult {
  const label = "Repair generated Pi host links only";
  let names: string[];
  try {
    names = hostDependencyNames(context);
    const links = [
      hostLink(context),
      ...names.map((name) => peerLink(context, name)),
      path.join(context.npmDir, "node_modules", HOST_PACKAGE),
      ...names.map((name) => path.join(context.npmDir, "node_modules", name)),
    ];
    for (const link of links) {
      assertSafeWritePath(link, context.agentDir);
      assertReplaceableLink(link);
    }
    for (const name of names) hostDependencyTarget(host, name);
  } catch (error) {
    return failedStep("pi-generated-links", label, error, "none");
  }
  try {
    fs.mkdirSync(context.npmDir, { recursive: true });
    let changed = false;
    let change = ensureLink(context, hostLink(context), host.dir, false);
    changed ||= change === "observed";
    change = ensureLink(context, path.join(context.npmDir, "node_modules", HOST_PACKAGE), host.dir, false);
    changed ||= change === "observed";
    for (const name of names) {
      const target = hostDependencyTarget(host, name);
      change = ensureLink(context, peerLink(context, name), target, false);
      changed ||= change === "observed";
      change = ensureLink(context, path.join(context.npmDir, "node_modules", name), target, false);
      changed ||= change === "observed";
    }
    verifyPiGeneratedLinks(context, host, names);
    return successfulStep("pi-generated-links", label, changed ? "observed" : "none", `host ${host.version}`);
  } catch (error) {
    return failedStep("pi-generated-links", label, error);
  }
}

export function normalizeSelectedPiDependencies(context: Context, selectedNames: Set<string>): StepResult {
  const label = "Normalize selected portable Pi dependency declarations";
  try {
    const allowed = new Set([HOST_PACKAGE, ...hostDependencyNames(context)]);
    for (const name of selectedNames) {
      if (!allowed.has(name)) throw new Error(`only direct Pi host dependencies can be normalized: ${name}`);
    }
    const changes = writeManifestIfNeeded(context, selectedNames);
    return successfulStep("pi-dependency-spec", label, changes, `${selectedNames.size} selected package(s)`);
  } catch (error) {
    return failedStep("pi-dependency-spec", label, error);
  }
}

function freshHostDependencies(host: HostInfo): string[] {
  const manifest = readJson(path.join(host.dir, "package.json"));
  const dependencies = manifest.dependencies && typeof manifest.dependencies === "object" ? manifest.dependencies : {};
  const names = Object.keys(dependencies).filter((name) => name.startsWith("@earendil-works/pi-") && name !== HOST_PACKAGE);
  for (const name of names) {
    if (!/^@earendil-works\/pi-[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`unsafe host dependency name: ${name}`);
    hostDependencyTarget(host, name);
  }
  return names.sort();
}

export function installMinimalPi(context: Context, host: HostInfo): StepResult[] {
  const baseLabel = "Create the minimal Pi npm manifest";
  let names: string[];
  try {
    if (fs.existsSync(manifestPath(context))) throw new Error("Fresh install requires a missing npm manifest");
    if (fs.existsSync(context.npmDir)) {
      const stat = fs.lstatSync(context.npmDir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(context.npmDir).length > 0) {
        throw new Error("Fresh install requires an empty, non-symlink npm directory");
      }
    }
    names = freshHostDependencies(host);
    fs.mkdirSync(context.npmDir, { recursive: true });
    assertSafeWritePath(manifestPath(context), context.agentDir);
    const dependencies = Object.fromEntries([
      [HOST_PACKAGE, "file:host-link"],
      ...names.map((name) => [name, `file:host-deps/${path.basename(name)}`]),
    ]);
    const temporary = `${manifestPath(context)}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ name: "agentbrew-pi-extensions", private: true, dependencies }, null, 2)}\n`, { flag: "wx" });
      fs.renameSync(temporary, manifestPath(context));
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  } catch (error) {
    return [failedStep("pi-base", baseLabel, error)];
  }

  const steps = [successfulStep("pi-base", baseLabel, "observed", `${names.length} host dependency(ies)`), repairPiGeneratedLinks(context, host)];
  if (steps.some((step) => step.status === "failed")) return steps;
  const label = "Install the minimal Pi dependency links without lifecycle scripts";
  try {
    const result = runProcess("npm", ["install", "--ignore-scripts", "--legacy-peer-deps"], {
      cwd: context.npmDir,
      env: context.env,
      timeout: 600_000,
    });
    assertProcessSuccess(result);
    verifyInstalledLinks(context, host);
    steps.push(successfulStep("npm-install-minimal", label, "unknown"));
  } catch (error) {
    steps.push(failedStep("npm-install-minimal", label, error));
  }
  return steps;
}

export function checkPiGeneratedLinks(context: Context): HealthCheck {
  try {
    const host = resolveHost(context);
    const names = hostDependencyNames(context);
    verifyPiGeneratedLinks(context, host, names);
    return { resource: "pi.host-links", status: "pass", message: "generated host and dependency links resolve to the active host" };
  } catch (error) {
    return { resource: "pi.host-links", status: "fail", message: error instanceof Error ? error.message : String(error) };
  }
}

export function snapshotPiForInit(context: Context): unknown {
  let host: HostInfo | null = null;
  let names: string[] = [];
  let manifestText: string | null = null;
  try {
    host = resolveHost(context);
  } catch {
    host = null;
  }
  try {
    manifestText = fs.readFileSync(manifestPath(context), "utf8");
    names = hostDependencyNames(context);
  } catch {
    manifestText = null;
  }
  return {
    capturedAt: new Date().toISOString(),
    host,
    manifestText,
    links: describePiLinks(context, names),
  };
}
