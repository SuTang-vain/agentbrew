interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseVersion(value: string): Version | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const parts = [match[1], match[2], match[3]].map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && (part.length > 1 && part.startsWith("0") || !Number.isSafeInteger(Number(part))))) return null;
  return { major: parts[0]!, minor: parts[1]!, patch: parts[2]!, prerelease };
}

export function validNpmConstraint(spec: string, fixed = false): boolean {
  const match = /^(\^|~)?(.+)$/.exec(spec);
  if (!match || (fixed && match[1])) return false;
  return parseVersion(match[2]!) !== null;
}

function compareCore(a: Version, b: Version): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

function compareVersion(a: Version, b: Version): number {
  const core = compareCore(a, b);
  if (core !== 0) return core;
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return Number(left) < Number(right) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

export function satisfiesNpmConstraint(version: string, spec: string): boolean {
  const actual = parseVersion(version);
  const match = /^(\^|~)?(.+)$/.exec(spec);
  const base = match ? parseVersion(match[2]!) : null;
  if (!actual || !match || !base) return false;
  if (actual.prerelease.length > 0 && (base.prerelease.length === 0 || compareCore(actual, base) !== 0)) return false;
  if (compareVersion(actual, base) < 0) return false;
  const operator = match[1];
  if (!operator) return compareVersion(actual, base) === 0;
  const upper: Version = operator === "~"
    ? { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [] }
    : base.major > 0
      ? { major: base.major + 1, minor: 0, patch: 0, prerelease: [] }
      : base.minor > 0
        ? { major: 0, minor: base.minor + 1, patch: 0, prerelease: [] }
        : { major: 0, minor: 0, patch: base.patch + 1, prerelease: [] };
  return compareCore(actual, upper) < 0;
}
