import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LayerName } from "./bundle.js";
import type { Context } from "./context.js";
import { writeStateJson } from "./state.js";

export interface GitSourceDescriptor {
  url: string;
  path: string;
  ref: "HEAD";
  commit: string;
}

export interface SourceRegistrationLayer {
  layer: LayerName;
  file: string;
  sha256: string;
  git?: GitSourceDescriptor;
}

export interface SourceRegistration {
  schemaVersion: 1 | 2;
  kind: "agentbrew-source-registration";
  target: { agentDir: string };
  layers: SourceRegistrationLayer[];
  inputHash: string;
}

const LAYER_ORDER: LayerName[] = ["public", "team", "personal", "machine"];
const MAX_SOURCE_STATE_BYTES = 64 * 1024;

function sourceFile(context: Context): string {
  return path.join(context.stateDir, "sources.json");
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${where} contains unknown field ${key}`);
  }
}

function hash(value: unknown, where: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${where} must be a SHA-256 hash`);
  return value;
}

function parseGit(value: unknown, where: string): SourceRegistrationLayer["git"] {
  if (!object(value)) throw new Error(`${where} must be an object`);
  keys(value, ["url", "path", "ref", "commit"], where);
  if (typeof value.url !== "string" || !value.url || /[\x00-\x20]/.test(value.url)) throw new Error(`${where}.url is invalid`);
  if (/^https?:\/\//.test(value.url)) {
    const url = new URL(value.url);
    if (url.username || url.password) throw new Error(`${where}.url must not contain credentials`);
  }
  if (typeof value.path !== "string" || !value.path || value.path.startsWith("/") || value.path.includes("\\")
    || value.path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${where}.path must be a safe relative repository path`);
  }
  if (value.ref !== "HEAD" || typeof value.commit !== "string" || !/^[0-9a-f]{40}$/.test(value.commit)) {
    throw new Error(`${where} requires HEAD and a full lowercase commit`);
  }
  return { url: value.url, path: value.path, ref: "HEAD", commit: value.commit };
}

function parseLayer(value: unknown, index: number, schemaVersion: 1 | 2): SourceRegistrationLayer {
  const where = `sources.json layers[${index}]`;
  if (!object(value)) throw new Error(`${where} must be an object`);
  keys(value, schemaVersion === 2 ? ["layer", "file", "sha256", "git"] : ["layer", "file", "sha256"], where);
  if (typeof value.layer !== "string" || !LAYER_ORDER.includes(value.layer as LayerName)) {
    throw new Error(`${where}.layer is invalid`);
  }
  const layer = value.layer as LayerName;
  if (typeof value.file !== "string" || !path.isAbsolute(value.file) || path.resolve(value.file) !== value.file) {
    throw new Error(`${where}.file must be a normalized absolute path`);
  }
  return {
    layer,
    file: value.file,
    sha256: hash(value.sha256, `${where}.sha256`),
    ...(value.git === undefined ? {} : { git: parseGit(value.git, `${where}.git`) }),
  };
}

function parseRegistration(context: Context, value: unknown): SourceRegistration {
  if (!object(value)) throw new Error("sources.json must contain an object");
  keys(value, ["schemaVersion", "kind", "target", "layers", "inputHash"], "sources.json");
  if ((value.schemaVersion !== 1 && value.schemaVersion !== 2) || value.kind !== "agentbrew-source-registration") {
    throw new Error("sources.json has an unsupported schemaVersion or kind");
  }
  const schemaVersion = value.schemaVersion;
  if (!object(value.target)) throw new Error("sources.json target must be an object");
  keys(value.target, ["agentDir"], "sources.json target");
  if (value.target.agentDir !== context.agentDir) throw new Error("sources.json belongs to a different Pi target");
  if (!Array.isArray(value.layers) || value.layers.length < 1 || value.layers.length > LAYER_ORDER.length) {
    throw new Error("sources.json requires one complete ordered layer list");
  }
  const layers = value.layers.map((entry, index) => parseLayer(entry, index, schemaVersion));
  let previous = -1;
  for (const { layer } of layers) {
    const current = LAYER_ORDER.indexOf(layer);
    if (current <= previous) throw new Error("sources.json layers must be unique and ordered public < team < personal < machine");
    previous = current;
  }
  return {
    schemaVersion,
    kind: "agentbrew-source-registration",
    target: { agentDir: context.agentDir },
    layers,
    inputHash: hash(value.inputHash, "sources.json inputHash"),
  };
}

export function readSourceRegistration(context: Context): SourceRegistration | null {
  const file = sourceFile(context);
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("sources.json must be a regular non-symlink file");
  if (stat.size > MAX_SOURCE_STATE_BYTES) throw new Error("sources.json exceeds the 64 KiB limit");
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`sources.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseRegistration(context, value);
}

export function writeSourceRegistration(context: Context, registration: SourceRegistration): void {
  writeStateJson(context, "sources.json", parseRegistration(context, registration));
}

export function removeSourceRegistration(context: Context): void {
  fs.unlinkSync(sourceFile(context));
}

export function sourceRegistrationFingerprint(context: Context): string {
  if (context.layerOrigin === "explicit") return "explicit";
  const file = sourceFile(context);
  const hash = createHash("sha256");
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return "invalid-source-file-type";
    hash.update(fs.readFileSync(file));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "none";
    return `unreadable:${code ?? "unknown"}`;
  }
  return hash.digest("hex");
}
