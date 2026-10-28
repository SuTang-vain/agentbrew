import path from "node:path";
import type { Context } from "./context.js";
import { bundleSummary, loadBundle, packageForResource, type ResolvedBundle, type ResolvedResource } from "./bundle.js";
import { redact } from "./process.js";
import type { CommandResult } from "./types.js";

export interface ResourceExplanation {
  id: string;
  state: "active" | "removed";
  layer: string;
  declaration?: unknown;
  history: Array<{ layer: string; effect: string }>;
  target?: string;
  required: boolean;
}

function targetFor(context: Context, id: string): string | undefined {
  if (id.startsWith("npm:")) return `${path.join(context.npmDir, "package.json")}#dependencies.${packageForResource(id)}`;
  if (id === "herdr.pi-integration") return path.join(context.agentDir, "extensions", "herdr-agent-state.ts");
  return undefined;
}

export function explainResources(context: Context, bundle: ResolvedBundle, selected: string[]): ResourceExplanation[] {
  for (const id of selected) {
    if (!bundle.resources[id] && !bundle.removed[id]) throw new Error(`resource is not present in the effective Bundle: ${id}`);
  }
  const active = Object.values(bundle.resources).map((resource: ResolvedResource): ResourceExplanation => ({
    id: resource.id,
    state: "active",
    layer: resource.layer,
    declaration: resource.declaration,
    history: resource.history,
    target: targetFor(context, resource.id),
    required: bundle.required.includes(resource.id),
  }));
  const removed = Object.values(bundle.removed).map((resource): ResourceExplanation => ({
    id: resource.id,
    state: "removed",
    layer: resource.layer,
    history: resource.history,
    target: targetFor(context, resource.id),
    required: false,
  }));
  return [...active, ...removed]
    .filter((resource) => selected.length === 0 || selected.includes(resource.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function explainCommand(context: Context, selected: string[]): CommandResult {
  const result: CommandResult = {
    schemaVersion: 1,
    command: "explain",
    status: "success",
    target: { agentDir: context.agentDir },
    changes: "none",
    steps: [],
    differences: [],
    checks: [],
  };
  try {
    const bundle = loadBundle(context.layers);
    if (!bundle) throw new Error("explain requires at least one explicit --layer");
    result.data = { bundle: bundleSummary(bundle), resources: explainResources(context, bundle, [...new Set(selected)]) };
  } catch (error) {
    result.status = "failed";
    result.error = redact(error instanceof Error ? error.message : String(error));
  }
  return result;
}
