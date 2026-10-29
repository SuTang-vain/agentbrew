import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ContextOptions } from "./types.js";

export interface Context {
  agentDir: string;
  npmDir: string;
  stateDir: string;
  agentDirExplicit: boolean;
  dryRun: boolean;
  selftest: boolean;
  layers: string[];
  layerOrigin: "explicit" | "registered" | "none";
  env: NodeJS.ProcessEnv;
}

export function createContext(options: ContextOptions = {}, env: NodeJS.ProcessEnv = process.env): Context {
  const home = env.HOME?.trim() ? path.resolve(env.HOME) : os.homedir();
  const configuredAgentDir = options.agentDir?.trim() || env.PI_AGENT_DIR?.trim();
  const agentDirExplicit = Boolean(configuredAgentDir);
  const agentDir = path.resolve(configuredAgentDir || path.join(home, ".pi", "agent"));
  const stateOverride = options.stateDir?.trim() || env.AGENTBREW_STATE_DIR?.trim();
  const targetKey = createHash("sha256").update(agentDir).digest("hex").slice(0, 16);
  const stateDir = path.resolve(
    stateOverride || path.join(home, ".local", "state", "agentbrew", targetKey),
  );

  return {
    agentDir,
    npmDir: path.join(agentDir, "npm"),
    stateDir,
    agentDirExplicit,
    dryRun: options.dryRun ?? false,
    selftest: options.selftest ?? false,
    layers: [...(options.layers ?? [])],
    layerOrigin: options.layers?.length ? "explicit" : "none",
    env,
  };
}

export function isInside(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

export function assertInside(candidate: string, root: string): void {
  if (!isInside(candidate, root)) {
    throw new Error(`refusing to access a path outside ${root}`);
  }
}
