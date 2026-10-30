import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "./context.js";
import { evaluateEnvironment, type EnvironmentEvaluation } from "./init.js";
import { redact, runProcessAsync } from "./process.js";
import type { CommandResult, Difference, EnvironmentClass, HealthCheck } from "./types.js";

export type TargetConnection = { type: "local" } | { type: "ssh"; destination: string };
export type TargetState = "unknown" | "checking" | "healthy" | "attention" | "offline" | "unavailable" | "error";
export type TargetErrorKind = "transport" | "agentbrew-unavailable" | "remote-check" | "protocol" | "local";

export interface TargetDescriptor {
  id: string;
  connection: TargetConnection;
}

export interface TargetSummary extends TargetDescriptor {
  state: TargetState;
  classification?: EnvironmentClass;
  pi?: string;
  herdr?: string;
  integration?: string;
  failures?: number;
  warnings?: number;
  differences?: number;
  checkedAt?: string;
  errorKind?: TargetErrorKind;
}

export interface TargetInventory {
  targets: TargetSummary[];
  error?: string;
}

const CLASSES: EnvironmentClass[] = ["empty", "healthy", "repairable", "damaged", "unknown"];
const MAX_TARGETS = 64;
const MAX_REGISTRY_BYTES = 64 * 1024;
const MAX_REMOTE_RESULT_BYTES = 1024 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${where} contains unknown field ${key}`);
  }
}

export function localTarget(): TargetDescriptor {
  return { id: "local", connection: { type: "local" } };
}

export function targetsFile(context: Context): string {
  const override = context.env.AGENTBREW_TARGETS_FILE?.trim();
  if (override) return path.resolve(override);
  const home = context.env.HOME?.trim() ? path.resolve(context.env.HOME) : os.homedir();
  const config = context.env.XDG_CONFIG_HOME?.trim() ? path.resolve(context.env.XDG_CONFIG_HOME) : path.join(home, ".config");
  return path.join(config, "agentbrew", "targets.json");
}

function alias(value: unknown, where: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) || value === "local") {
    throw new Error(`${where} must be a safe, non-reserved target alias`);
  }
  return value;
}

function destination(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length > 255 || !/^[A-Za-z0-9._~@%:\[\]-]+$/.test(value) || value.startsWith("-")) {
    throw new Error(`${where} must be one safe SSH destination`);
  }
  const parts = value.split("@");
  if (parts.length > 2 || parts.some((part) => !part)) throw new Error(`${where} has an invalid user/host form`);
  const host = parts.at(-1)!;
  if (host.includes(":") && !/^\[[0-9A-Fa-f:.]+\]$/.test(host)) {
    throw new Error(`${where} must use an SSH config alias for custom ports or connection options`);
  }
  return value;
}

function remote(value: unknown, index: number): TargetDescriptor {
  const where = `targets.json targets[${index}]`;
  if (!object(value)) throw new Error(`${where} must be an object`);
  keys(value, ["id", "connection"], where);
  const id = alias(value.id, `${where}.id`);
  if (!object(value.connection)) throw new Error(`${where}.connection must be an object`);
  keys(value.connection, ["type", "destination"], `${where}.connection`);
  if (value.connection.type !== "ssh") throw new Error(`${where}.connection.type must be ssh`);
  return {
    id,
    connection: { type: "ssh", destination: destination(value.connection.destination, `${where}.connection.destination`) },
  };
}

export function unknownTarget(descriptor: TargetDescriptor): TargetSummary {
  return { ...descriptor, state: "unknown" };
}

export function loadTargets(context: Context): TargetDescriptor[] {
  const file = targetsFile(context);
  const descriptors = [localTarget()];
  if (!fs.existsSync(file)) return descriptors;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("targets.json must be a regular non-symlink file");
  if (stat.size > MAX_REGISTRY_BYTES) throw new Error("targets.json exceeds the 64 KiB limit");
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`targets.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!object(value)) throw new Error("targets.json must contain an object");
  keys(value, ["schemaVersion", "kind", "targets"], "targets.json");
  if (value.schemaVersion !== 1 || value.kind !== "agentbrew-targets" || !Array.isArray(value.targets)) {
    throw new Error("targets.json has an unsupported schemaVersion, kind, or targets list");
  }
  if (value.targets.length > MAX_TARGETS) throw new Error(`targets.json exceeds the ${MAX_TARGETS} target limit`);
  const ids = new Set<string>();
  for (const [index, entry] of value.targets.entries()) {
    const descriptor = remote(entry, index);
    if (ids.has(descriptor.id)) throw new Error(`targets.json contains duplicate target ${descriptor.id}`);
    ids.add(descriptor.id);
    descriptors.push(descriptor);
  }
  return descriptors;
}

export function targetInventory(context: Context): TargetInventory {
  try {
    return { targets: loadTargets(context).map(unknownTarget) };
  } catch (error) {
    return {
      targets: [unknownTarget(localTarget())],
      error: redact(error instanceof Error ? error.message : String(error)),
    };
  }
}

function checkedAt(): string {
  return new Date().toISOString();
}

export function targetSummaryFromEvaluation(descriptor: TargetDescriptor, evaluation: EnvironmentEvaluation): TargetSummary {
  const failures = evaluation.checks.filter((check) => check.status === "fail").length;
  const warnings = evaluation.checks.filter((check) => check.status === "warn").length;
  return {
    ...descriptor,
    state: evaluation.assessment.classification === "healthy" && failures === 0 ? "healthy" : "attention",
    classification: evaluation.assessment.classification,
    ...(evaluation.assessment.host ? { pi: evaluation.assessment.host.version } : {}),
    herdr: evaluation.herdr.available ? evaluation.herdr.version ?? "available" : "unavailable",
    integration: evaluation.herdr.integration,
    failures,
    warnings,
    differences: evaluation.differences.length,
    checkedAt: checkedAt(),
  };
}

function targetFailure(descriptor: TargetDescriptor, state: TargetState, errorKind: TargetErrorKind): TargetSummary {
  return { ...descriptor, state, errorKind, checkedAt: checkedAt() };
}

function healthChecks(value: unknown): HealthCheck[] {
  if (!Array.isArray(value)) throw new Error("remote checks must be an array");
  return value.map((entry) => {
    if (!object(entry) || typeof entry.resource !== "string" || typeof entry.message !== "string"
      || !["pass", "warn", "fail"].includes(String(entry.status))) {
      throw new Error("remote check has an invalid shape");
    }
    return { resource: entry.resource, status: entry.status as HealthCheck["status"], message: entry.message };
  });
}

function differences(value: unknown): Difference[] {
  if (!Array.isArray(value)) throw new Error("remote differences must be an array");
  return value.map((entry) => {
    if (!object(entry) || ["resource", "kind", "expected", "actual"].some((key) => typeof entry[key] !== "string")) {
      throw new Error("remote difference has an invalid shape");
    }
    return { resource: String(entry.resource), kind: String(entry.kind), expected: String(entry.expected), actual: String(entry.actual) };
  });
}

function remoteSummary(descriptor: TargetDescriptor, value: unknown): TargetSummary {
  if (!object(value) || value.schemaVersion !== 1 || value.command !== "init" || !object(value.data)) {
    throw new Error("remote result is not an Agentbrew init assessment");
  }
  const assessment = value.data.assessment;
  const herdr = value.data.herdr;
  if (!object(assessment) || !CLASSES.includes(assessment.classification as EnvironmentClass)) {
    throw new Error("remote assessment has no valid classification");
  }
  if (assessment.host !== null && (!object(assessment.host) || typeof assessment.host.version !== "string")) {
    throw new Error("remote assessment has an invalid host");
  }
  if (!object(herdr) || typeof herdr.available !== "boolean" || typeof herdr.integration !== "string"
    || !["current", "outdated", "not-installed", "unknown"].includes(herdr.integration)
    || (herdr.version !== undefined && typeof herdr.version !== "string")) {
    throw new Error("remote assessment has invalid herdr evidence");
  }
  const evaluation: EnvironmentEvaluation = {
    assessment: {
      classification: assessment.classification as EnvironmentClass,
      host: assessment.host === null ? null : { version: String((assessment.host as Record<string, unknown>).version) },
    } as EnvironmentEvaluation["assessment"],
    checks: healthChecks(value.checks),
    differences: differences(value.differences),
    herdr: {
      available: herdr.available,
      integration: herdr.integration as "current" | "outdated" | "not-installed" | "unknown",
      plugins: [],
      ...(typeof herdr.version === "string" ? { version: herdr.version } : {}),
    },
  };
  return targetSummaryFromEvaluation(descriptor, evaluation);
}

export async function checkTarget(context: Context, descriptor: TargetDescriptor): Promise<TargetSummary> {
  if (descriptor.connection.type === "local") {
    try {
      return targetSummaryFromEvaluation(descriptor, evaluateEnvironment(context));
    } catch {
      return targetFailure(descriptor, "error", "local");
    }
  }
  const result = await runProcessAsync("ssh", [
    "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "--", descriptor.connection.destination,
    "agentbrew", "init", "--json",
  ], {
    env: { ...context.env, SSH_ASKPASS_REQUIRE: "never" },
    timeout: 20_000,
    signal: context.signal,
  });
  if (result.error?.name === "AbortError") throw result.error;
  if (result.error || result.status === 255) return targetFailure(descriptor, "offline", "transport");
  if (result.status === 127) return targetFailure(descriptor, "unavailable", "agentbrew-unavailable");
  if (result.status !== 0 && result.status !== 6) return targetFailure(descriptor, "unavailable", "remote-check");
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_REMOTE_RESULT_BYTES) return targetFailure(descriptor, "error", "protocol");
  try {
    return remoteSummary(descriptor, JSON.parse(result.stdout));
  } catch {
    return targetFailure(descriptor, "error", "protocol");
  }
}

export async function checkTargetId(context: Context, id: string): Promise<TargetSummary> {
  const descriptor = loadTargets(context).find((target) => target.id === id);
  if (!descriptor) throw new Error(`unknown target ${id}`);
  return checkTarget(context, descriptor);
}

function targetResult(context: Context, action: "list" | "check"): CommandResult {
  return {
    schemaVersion: 1,
    command: "target",
    status: "success",
    target: { agentDir: context.agentDir },
    changes: "none",
    steps: [],
    differences: [],
    checks: [],
    data: { action },
  };
}

export async function targetCommand(context: Context, action: "list" | "check", id?: string): Promise<CommandResult> {
  const result = targetResult(context, action);
  try {
    if (action === "list") {
      result.data = { action, targets: loadTargets(context).map(unknownTarget) };
      return result;
    }
    if (!id) throw new Error("target check requires an explicit target id");
    const summary = await checkTargetId(context, id);
    result.data = { action, summary };
    if (summary.state === "attention") result.status = "unhealthy";
    if (["offline", "unavailable", "error"].includes(summary.state)) {
      result.status = "failed";
      result.error = `${summary.id}: ${summary.errorKind ?? "check failed"}`;
    }
    return result;
  } catch (error) {
    result.status = "failed";
    result.error = redact(error instanceof Error ? error.message : String(error));
    return result;
  }
}
