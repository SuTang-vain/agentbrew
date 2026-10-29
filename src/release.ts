import { satisfiesPeerRange, validNpmConstraint } from "./npm-spec.js";

export interface BundleSubject {
  user?: string;
  machine?: string;
}

export interface TeamException {
  resource: string;
  users?: string[];
  machines?: string[];
  allow: "override";
  expiresAt?: string;
}

export interface ReleaseMetadata {
  name: string;
  hostCompatible?: string;
  runtimeLoad?: "unknown" | "passed";
  exceptions: TeamException[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${where} contains unknown field ${key}`);
  }
}

function strings(value: unknown, field: string, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${where}.${field} must be a non-empty string array`);
  if (new Set(value).size !== value.length) throw new Error(`${where}.${field} contains duplicates`);
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0 || entry.length > 128 || /[\x00-\x1f\x7f]/.test(entry)) {
      throw new Error(`${where}.${field} contains an invalid subject`);
    }
    return entry;
  });
}

function exception(value: unknown, index: number, where: string): TeamException {
  const location = `${where}.exceptions[${index}]`;
  if (!object(value)) throw new Error(`${location} must be an object`);
  keys(value, ["resource", "users", "machines", "allow", "expiresAt"], location);
  if (typeof value.resource !== "string" || !value.resource) throw new Error(`${location}.resource is required`);
  if (value.allow !== "override") throw new Error(`${location}.allow must be override`);
  if (value.users === undefined && value.machines === undefined) throw new Error(`${location} requires users or machines`);
  const result: TeamException = {
    resource: value.resource,
    ...(value.users === undefined ? {} : { users: strings(value.users, "users", location) }),
    ...(value.machines === undefined ? {} : { machines: strings(value.machines, "machines", location) }),
    allow: "override",
  };
  if (value.expiresAt !== undefined) {
    if (typeof value.expiresAt !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.expiresAt)
      || !Number.isFinite(Date.parse(value.expiresAt))) {
      throw new Error(`${location}.expiresAt must be an RFC 3339 timestamp`);
    }
    result.expiresAt = value.expiresAt;
  }
  return result;
}

export function validateHostRange(value: unknown, where = "release host.compatible"): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a non-empty compatibility range`);
  const range = value.trim();
  const exactBranch = range.split("||").some((branch) => {
    const trimmed = branch.trim();
    return validNpmConstraint(trimmed, true) || /^=\d/.test(trimmed);
  });
  if (exactBranch || satisfiesPeerRange("1.0.0", range) === null) {
    throw new Error(`${where} must be a supported non-exact host range`);
  }
  return range;
}

export function validateReleaseIntegrity(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.startsWith("sha512-")) throw new Error(`${where} must be a sha512 integrity value`);
  const encoded = value.slice(7);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || Buffer.from(encoded, "base64").length !== 64) {
    throw new Error(`${where} must contain a valid SHA-512 digest`);
  }
  return value;
}

export function parseReleaseMetadata(value: Record<string, unknown>, where: string): ReleaseMetadata {
  if (typeof value.release !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.release)) {
    throw new Error(`${where}.release must be a safe release identifier`);
  }
  if (value.host !== undefined) {
    if (!object(value.host)) throw new Error(`${where}.host must be an object`);
    keys(value.host, ["compatible"], `${where}.host`);
  }
  if (value.exceptions !== undefined && !Array.isArray(value.exceptions)) throw new Error(`${where}.exceptions must be an array`);
  if (value.verification !== undefined) {
    if (!object(value.verification)) throw new Error(`${where}.verification must be an object`);
    keys(value.verification, ["runtimeLoad"], `${where}.verification`);
    if (value.verification.runtimeLoad !== "unknown" && value.verification.runtimeLoad !== "passed") {
      throw new Error(`${where}.verification.runtimeLoad must be unknown or passed`);
    }
  }
  return {
    name: value.release,
    ...(value.host === undefined ? {} : { hostCompatible: validateHostRange(value.host.compatible, `${where}.host.compatible`) }),
    ...(value.verification ? { runtimeLoad: value.verification.runtimeLoad as "unknown" | "passed" } : {}),
    exceptions: (value.exceptions ?? []).map((entry, index) => exception(entry, index, where)),
  };
}

export function exceptionState(entry: TeamException, subject: BundleSubject, now = Date.now()): "applied" | "expired" | "subject-mismatch" {
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= now) return "expired";
  if (entry.users && (!subject.user || !entry.users.includes(subject.user))) return "subject-mismatch";
  if (entry.machines && (!subject.machine || !entry.machines.includes(subject.machine))) return "subject-mismatch";
  return "applied";
}

export function exceptionExplanation(entry: TeamException, subject: BundleSubject): Record<string, unknown> {
  return { ...entry, state: exceptionState(entry, subject) };
}
