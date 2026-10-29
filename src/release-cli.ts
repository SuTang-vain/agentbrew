import fs from "node:fs";
import path from "node:path";
import type { Context } from "./context.js";
import { loadBundle, packageForResource, type ResolvedBundle } from "./bundle.js";
import { doctorCommand } from "./plan.js";
import { redact } from "./process.js";
import { resolveHost } from "./providers/pi.js";
import { validateHostRange, validateReleaseIntegrity } from "./release.js";
import { successfulStep, type CommandResult, type HealthCheck } from "./types.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function result(context: Context): CommandResult {
  return {
    schemaVersion: 1,
    command: "release",
    status: "success",
    target: { agentDir: context.agentDir },
    changes: "none",
    steps: [],
    differences: [],
    checks: [],
  };
}

function readState(context: Context, name: string): Record<string, unknown> {
  const file = path.join(context.stateDir, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error(`${name} is missing, unsafe, or too large`);
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!object(value)) throw new Error(`${name} must contain an object`);
  return value;
}

function reportFor(context: Context, bundle: ResolvedBundle): Record<string, unknown> {
  const resolution = readState(context, "last-resolution.json");
  const last = readState(context, "last-result.json");
  if (resolution.schemaVersion !== 1 || resolution.kind !== "agentbrew-resolution" || resolution.sourceHash !== bundle.inputHash) {
    throw new Error("the latest resolution does not match the explicit team input");
  }
  if (!object(resolution.target) || resolution.target.agentDir !== context.agentDir || !object(resolution.report)) {
    throw new Error("the latest resolution belongs to a different target or has no report");
  }
  if (last.schemaVersion !== 1 || last.command !== "update" || last.status !== "success"
    || !object(last.target) || last.target.agentDir !== context.agentDir || !object(last.data)) {
    throw new Error("Release publication requires a successful resolved update on this target");
  }
  const data = last.data;
  if (data.nativeMode !== false || !object(data.bundle) || data.bundle.inputHash !== bundle.inputHash
    || JSON.stringify(data.resolution) !== JSON.stringify(resolution.report)) {
    throw new Error("the latest result and resolution do not describe the same team-only update");
  }
  if (bundle.sources.length !== 1 || bundle.sources[0]!.layer !== "team" || bundle.release) {
    throw new Error("Release publication requires one explicit ordinary team layer without personal or machine inputs");
  }
  const report = resolution.report;
  if (report.ready !== true || report.complete !== true || !object(report.host) || !Array.isArray(report.resources)
    || (Array.isArray(report.errors) && report.errors.length > 0)) {
    throw new Error("Release publication requires a complete, ready, and successful resolution");
  }
  if (resolveHost(context).version !== report.host.targetVersion) {
    throw new Error("the active Pi host no longer matches the verified update result");
  }
  return report;
}

function releaseResources(context: Context, bundle: ResolvedBundle, report: Record<string, unknown>): Record<string, unknown> {
  const resolutions = report.resources as Array<Record<string, unknown>>;
  const lockFile = path.join(context.npmDir, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  if (!object(lock.packages)) throw new Error("package-lock has no packages object");
  const resources: Record<string, unknown> = {};
  for (const [id, resource] of Object.entries(bundle.resources).sort(([left], [right]) => left.localeCompare(right))) {
    if (!id.startsWith("npm:")) {
      resources[id] = resource.declaration;
      continue;
    }
    const name = packageForResource(id);
    const resolution = resolutions.find((entry) => entry.id === id);
    if (!resolution || (resolution.action !== "keep" && resolution.action !== "update") || typeof resolution.targetVersion !== "string") {
      throw new Error(`${id} has no successfully resolved exact version for publication`);
    }
    const installed = JSON.parse(fs.readFileSync(path.join(context.npmDir, "node_modules", name, "package.json"), "utf8"));
    if (installed.name !== name || installed.version !== resolution.targetVersion) {
      throw new Error(`${id} no longer matches the verified installed version`);
    }
    const entry = lock.packages[`node_modules/${name}`];
    if (!object(entry) || entry.version !== installed.version) throw new Error(`${id} is absent from the reviewed package-lock`);
    if (resolution.integrity !== undefined && entry.integrity !== resolution.integrity) {
      throw new Error(`${id} integrity differs between resolution and package-lock`);
    }
    const integrity = validateReleaseIntegrity(resolution.integrity ?? entry.integrity, `${id} publication integrity`);
    resources[id] = {
      source: { type: "npm", spec: installed.version, integrity },
      update: "fixed",
    };
  }
  return resources;
}

export function releaseCreateCommand(context: Context, output: string, hostRange?: string): CommandResult {
  const result = releaseResult(context);
  let destination: string;
  let release: Record<string, unknown>;
  let runtimeLoad: "unknown" | "passed";
  try {
    if (context.layerOrigin !== "explicit" || context.layers.length !== 1) {
      throw new Error("release create requires one explicit --layer team=<file>; registered, personal, and machine sources are not exported");
    }
    const bundle = loadBundle(context.layers, context);
    if (!bundle) throw new Error("release create requires an explicit team layer");
    const report = reportFor(context, bundle);
    const resources = releaseResources(context, bundle, report);
    const health = doctorCommand(context);
    result.checks = health.checks;
    if (health.status !== "success") throw new Error(health.error ?? "current health evidence is not suitable for Release publication");
    runtimeLoad = context.selftest ? "passed" : "unknown";
    if (context.selftest && !health.checks.some((check: HealthCheck) => check.resource === "pi.selftest" && check.status === "pass")) {
      throw new Error("runtime loading was not proven by the explicitly requested selftest");
    }
    const compatible = hostRange === undefined ? undefined : validateHostRange(hostRange, "--host-range");
    destination = path.resolve(output);
    release = {
      schemaVersion: 1,
      kind: "agentbrew-release",
      layer: "team",
      release: `team-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}`,
      ...(compatible ? { host: { compatible } } : {}),
      resources,
      required: bundle.required,
      forbidden: bundle.forbidden,
      verification: { runtimeLoad },
    };
  } catch (error) {
    result.status = "not-executed";
    result.error = redact(error instanceof Error ? error.message : String(error));
    return result;
  }

  try {
    fs.writeFileSync(destination, `${JSON.stringify(release, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    result.status = "failed";
    result.error = redact(error instanceof Error ? error.message : String(error));
    return result;
  }
  result.changes = "observed";
  result.steps.push(successfulStep("release-create", "Publish portable evidence as a new team Release", "observed", "only the new output file was created"));
  result.data = {
    action: "create",
    output: destination,
    release: release.release,
    runtimeLoad,
    resources: Object.keys(release.resources as Record<string, unknown>),
    resourcesChanged: false,
    ...(runtimeLoad === "unknown" ? { warning: "Release contains static health evidence only; runtime extension loading remains unknown" } : {}),
  };
  return result;
}

function releaseResult(context: Context): CommandResult {
  return result(context);
}
