import { loadBundle } from "./bundle.js";
import type { Context } from "./context.js";
import { redact } from "./process.js";
import { readSourceRegistration } from "./source-state.js";
import { registrationLayers } from "./sources.js";
import type { CommandResult } from "./types.js";

export function prepareContextSources(context: Context): void {
  if (context.layerOrigin === "explicit") {
    loadBundle(context.layers);
    return;
  }
  context.layers = [];
  context.layerOrigin = "none";
  const registration = readSourceRegistration(context);
  if (!registration) return;
  context.layerOrigin = "registered";
  context.layers = registrationLayers(registration);
  loadBundle(context.layers);
}

export function sourceInputError(context: Context, command: CommandResult["command"], error: unknown): CommandResult {
  return {
    schemaVersion: 1,
    command,
    status: command === "update" ? "not-executed" : "failed",
    target: { agentDir: context.agentDir },
    changes: "none",
    steps: [],
    differences: [],
    checks: [],
    data: { layerOrigin: context.layerOrigin === "explicit" ? "explicit" : "registered" },
    error: redact(error instanceof Error ? error.message : String(error)),
  };
}
