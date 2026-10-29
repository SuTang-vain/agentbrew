import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadBundle, parseLayerArguments, LAYERS, type LayerName, type ResolvedBundle } from "./bundle.js";
import type { Context } from "./context.js";
import { assertProcessSuccess, runProcess } from "./process.js";
import type { SourceRegistration, SourceRegistrationLayer } from "./source-state.js";

export interface GitSourceInput {
  layer: LayerName;
  url: string;
  path: string;
}

function repository(value: string): string {
  if (path.isAbsolute(value)) return value;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._~/-]+$/.test(value)) return value;
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "ssh:") throw new Error("Git sources require HTTPS, SSH, or an absolute local repository path");
  if (url.password || (url.protocol === "https:" && url.username)) throw new Error("Git source URLs must not contain credentials");
  return value;
}

function repositoryPath(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Git layer path must be a safe relative repository path");
  }
  return value;
}

export function parseGitInputs(inputs: string[]): GitSourceInput[] {
  const seen = new Set<LayerName>();
  return inputs.map((input) => {
    const separator = input.indexOf("=");
    const fragment = input.lastIndexOf("#");
    const layer = input.slice(0, separator) as LayerName;
    if (separator < 1 || fragment <= separator || !LAYERS.includes(layer) || seen.has(layer)) {
      throw new Error(`--git requires unique public|team|personal|machine=<repository>#<path>: ${input}`);
    }
    seen.add(layer);
    return { layer, url: repository(input.slice(separator + 1, fragment)), path: repositoryPath(input.slice(fragment + 1)) };
  });
}

function cacheFile(context: Context, layer: LayerName, commit: string): string {
  return path.join(context.stateDir, "sources", "cache", `${layer}-${commit}.json`);
}

function writeCache(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, "utf8");
    if (createHash("sha256").update(current).digest("hex") !== createHash("sha256").update(content).digest("hex")) {
      throw new Error(`immutable Git cache content differs for ${file}`);
    }
    return;
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function fetchLayer(context: Context, input: GitSourceInput): SourceRegistrationLayer {
  if (context.env.PI_OFFLINE) throw new Error(`cannot refresh ${input.layer} Git source while PI_OFFLINE is enabled`);
  const temporary = path.join(context.stateDir, `.git-source-${process.pid}-${randomUUID()}`);
  const checkout = path.join(temporary, "repository");
  try {
    fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
    assertProcessSuccess(runProcess("git", [
      "clone", "--quiet", "--no-checkout", "--no-tags", "--depth", "1", "--filter=blob:none",
      "--origin", "agentbrew", input.url, checkout,
    ], { env: { ...context.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 120_000 }));
    const commitResult = runProcess("git", ["-C", checkout, "rev-parse", "HEAD^{commit}"], { env: context.env, timeout: 30_000 });
    assertProcessSuccess(commitResult);
    const commit = commitResult.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Git source did not resolve to a full commit");
    const object = `${commit}:${input.path}`;
    const type = runProcess("git", ["-C", checkout, "cat-file", "-t", object], { env: context.env, timeout: 30_000 });
    assertProcessSuccess(type);
    if (type.stdout.trim() !== "blob") throw new Error(`${input.path} is not a Git blob`);
    const content = runProcess("git", ["-C", checkout, "show", object], { env: context.env, timeout: 30_000 });
    assertProcessSuccess(content);
    if (Buffer.byteLength(content.stdout, "utf8") > 1024 * 1024) throw new Error(`${input.path} exceeds the 1 MiB layer limit`);
    const file = cacheFile(context, input.layer, commit);
    writeCache(file, content.stdout);
    return {
      layer: input.layer,
      file,
      sha256: createHash("sha256").update(content.stdout).digest("hex"),
      git: { url: input.url, path: input.path, ref: "HEAD", commit },
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function buildRegistration(context: Context, layers: SourceRegistrationLayer[]): { registration: SourceRegistration; bundle: ResolvedBundle } {
  const ordered = [...layers].sort((left, right) => LAYERS.indexOf(left.layer) - LAYERS.indexOf(right.layer));
  const bundle = loadBundle(ordered.map(({ layer, file }) => `${layer}=${file}`), context);
  if (!bundle) throw new Error("source registration requires at least one layer");
  return {
    registration: {
      schemaVersion: ordered.some((layer) => layer.git) ? 2 : 1,
      kind: "agentbrew-source-registration",
      target: { agentDir: context.agentDir },
      layers: ordered,
      inputHash: bundle.inputHash,
    },
    bundle,
  };
}

export function createGitRegistration(context: Context, inputs: string[]): { registration: SourceRegistration; bundle: ResolvedBundle } {
  const git = parseGitInputs(inputs);
  const local = parseLayerArguments(context.layers).map(({ layer }) => layer);
  for (const { layer } of git) {
    if (local.includes(layer)) throw new Error(`${layer} cannot be provided by both --layer and --git`);
  }
  const localLayers = buildRegistrationFromLocals(context);
  const gitLayers = git.map((input) => fetchLayer(context, input));
  return buildRegistration(context, [...localLayers, ...gitLayers]);
}

function buildRegistrationFromLocals(context: Context): SourceRegistrationLayer[] {
  if (context.layers.length === 0) return [];
  const bundle = loadBundle(context.layers, context);
  if (!bundle) return [];
  return bundle.sources.map(({ layer, file, sha256 }) => ({ layer, file, sha256 }));
}

export function validateGitRegistration(context: Context, registration: SourceRegistration): { registration: SourceRegistration; bundle: ResolvedBundle } {
  return buildRegistration(context, registration.layers);
}

export function refreshGitRegistration(context: Context, registration: SourceRegistration): {
  registration: SourceRegistration;
  bundle: ResolvedBundle;
  changes: Array<{ layer: LayerName; from: string; to: string }>;
} {
  const changes: Array<{ layer: LayerName; from: string; to: string }> = [];
  const layers = registration.layers.map((layer) => {
    if (!layer.git) return layer;
    const refreshed = fetchLayer(context, { layer: layer.layer, url: layer.git.url, path: layer.git.path });
    if (refreshed.git!.commit !== layer.git.commit) changes.push({ layer: layer.layer, from: layer.git.commit, to: refreshed.git!.commit });
    return refreshed;
  });
  const built = buildRegistration(context, layers);
  return { ...built, changes };
}
