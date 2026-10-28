import fs from "node:fs";
import path from "node:path";
import type { Context } from "./context.js";
import { writeStateJson } from "./state.js";
import type { Ownership } from "./types.js";

export interface OwnershipState {
  schemaVersion: 1;
  resources: Record<string, Ownership>;
}

const OWNERSHIPS = new Set<Ownership>(["observe", "adopt", "manage", "generate"]);

export function readOwnership(context: Context): OwnershipState | null {
  const file = path.join(context.stateDir, "ownership.json");
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value?.schemaVersion !== 1 || !value.resources || typeof value.resources !== "object" || Array.isArray(value.resources)) {
    throw new Error(`${file} is not a valid Agentbrew ownership state`);
  }
  for (const [resource, ownership] of Object.entries(value.resources)) {
    if (!resource || !OWNERSHIPS.has(ownership as Ownership)) throw new Error(`${file} contains invalid resource ownership`);
  }
  return value as OwnershipState;
}

export function writeOwnership(context: Context, resources: Record<string, Ownership>): void {
  writeStateJson(context, "ownership.json", { schemaVersion: 1, resources } satisfies OwnershipState);
}

export function isManaged(ownership: Ownership | undefined): boolean {
  return ownership === "manage" || ownership === "generate";
}
