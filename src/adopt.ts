import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import type { Context } from "./context.js";
import { validNpmConstraint } from "./npm-spec.js";
import { inspectHerdr } from "./providers/herdr.js";
import { HOST_PACKAGE, readPiManifest } from "./providers/pi.js";
import { redact } from "./process.js";
import { canUseTerminalMenu, showTerminalMenu } from "./terminal-menu.js";
import { createTerminalStyle } from "./terminal.js";
import type { CommandResult, InitResource } from "./types.js";

export interface AdoptIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
}

interface AdoptionProposal {
  schemaVersion: 1;
  kind: "agentbrew-layer";
  layer: "personal";
  resources: Record<string, unknown>;
}

function result(context: Context): CommandResult {
  return {
    schemaVersion: 1,
    command: "adopt",
    status: "success",
    target: { agentDir: context.agentDir },
    changes: "none",
    steps: [],
    differences: [],
    checks: [],
  };
}

function failure(context: Context, error: unknown, status: CommandResult["status"] = "failed"): CommandResult {
  return {
    ...result(context),
    status,
    error: redact(error instanceof Error ? error.message : String(error)),
  };
}

export function discoverAdoptionResources(context: Context): InitResource[] {
  const manifest = readPiManifest(context);
  const resources = Object.keys(manifest.dependencies)
    .filter((name) => name !== HOST_PACKAGE && !name.startsWith("@earendil-works/pi-"))
    .sort()
    .map((name) => ({
      id: `npm:${name}`,
      description: `Export ${name} with its current npm constraint`,
      sideEffect: "Creates a separate manual-policy proposal; does not change this resource",
      required: false,
    }));
  const herdr = inspectHerdr(context);
  if (herdr.available && herdr.integration !== "unknown") {
    resources.push({
      id: "herdr.pi-integration",
      description: "Export the existing herdr Pi integration as a named resource",
      sideEffect: "Creates a manual-policy proposal only; no integration is generated",
      required: false,
    });
  }
  return resources;
}

function createProposal(context: Context, selected: string[]): AdoptionProposal {
  const resources = discoverAdoptionResources(context);
  const available = new Set(resources.map((resource) => resource.id));
  const manifest = readPiManifest(context);
  const declarations: Record<string, unknown> = {};
  for (const id of [...new Set(selected)].sort()) {
    if (!available.has(id)) throw new Error(`resource is not available for adoption: ${id}`);
    if (id === "herdr.pi-integration") {
      declarations[id] = { update: "manual" };
      continue;
    }
    const name = id.slice(4);
    const spec = manifest.dependencies[name];
    if (typeof spec !== "string" || !validNpmConstraint(spec)) {
      throw new Error(`cannot infer a portable npm constraint for ${name}; keep it local or review its source manually`);
    }
    declarations[id] = { source: { type: "npm", spec }, update: "manual" };
  }
  return { schemaVersion: 1, kind: "agentbrew-layer", layer: "personal", resources: declarations };
}

export function writeAdoptionProposal(context: Context, selected: string[], output: string): CommandResult {
  try {
    if (selected.length === 0) throw new Error("select at least one resource explicitly");
    if (!output.trim()) throw new Error("adopt requires --output <new-file.json>");
    const proposal = createProposal(context, selected);
    const destination = path.resolve(output);
    fs.writeFileSync(destination, `${JSON.stringify(proposal, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return {
      ...result(context),
      data: { output: destination, resources: Object.keys(proposal.resources), proposalOnly: true },
    };
  } catch (error) {
    return failure(context, error, "not-executed");
  }
}

async function ask(rl: readline.Interface, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const finish = (value: string | null) => {
      rl.off("SIGINT", onSigint);
      resolve(value);
    };
    const onSigint = () => {
      rl.close();
      finish(null);
    };
    rl.once("SIGINT", onSigint);
    rl.question(prompt).then(finish, () => finish(null));
  });
}

export async function runInteractiveAdopt(context: Context, io: AdoptIO, output?: string): Promise<CommandResult> {
  let resources: InitResource[];
  try {
    resources = discoverAdoptionResources(context);
  } catch (error) {
    return failure(context, error);
  }
  if (resources.length === 0) return failure(context, "no portable resources are available for an adoption proposal", "not-executed");
  const visual = canUseTerminalMenu(io);
  const style = createTerminalStyle(io.output, io.env ?? process.env, visual);
  io.output.write(visual
    ? `\n${style.title("Agentbrew · adoption proposal")}\n${style.paint("Read-only detection; writes only a separate personal-layer JSON file.", "muted")}\n${style.rule()}\n`
    : `target: ${context.agentDir}\nadopt: creates a separate manual-policy proposal; no managed configuration or state is changed\n`);
  const rl = visual ? null : readline.createInterface({ input: io.input, output: io.output, terminal: false });
  try {
    let selected: string[] | null;
    if (visual) {
      selected = await showTerminalMenu(io, {
        title: "Select resources to export",
        items: resources.map((resource) => ({ value: resource.id, label: resource.id, description: resource.description, detail: resource.sideEffect })),
        initial: [],
        multiple: true,
        maxVisible: 6,
      }, style);
    } else {
      resources.forEach((resource, index) => io.output.write(`  ${index + 1}. ${resource.id}\n     ${resource.description}\n`));
      const answer = await ask(rl!, "resources (comma-separated, or q)> ");
      if (answer === null || answer.trim().toLowerCase() === "q") return failure(context, "adoption cancelled; no proposal was written", "cancelled");
      const indexes = answer.trim() === "" ? [] : answer.split(",").map((value) => Number(value.trim()) - 1);
      if (indexes.some((index) => !Number.isInteger(index) || !resources[index])) return failure(context, "invalid resource selection; no proposal was written", "cancelled");
      selected = indexes.map((index) => resources[index]!.id);
    }
    if (selected === null) return failure(context, "adoption cancelled; no proposal was written", "cancelled");
    if (selected.length === 0) return failure(context, "select at least one resource; no proposal was written", "not-executed");
    let destination: string | null | undefined = output;
    if (!destination) {
      if (visual) {
        destination = await new Promise<string | null>((resolve) => {
          const input = readline.createInterface({ input: io.input, output: io.output, terminal: false });
          input.question("new proposal file> ").then(resolve, () => resolve(null)).finally(() => input.close());
        });
      } else {
        destination = await ask(rl!, "new proposal file> ");
      }
    }
    if (!destination?.trim()) return failure(context, "an output file is required; no proposal was written", "cancelled");
    if (visual) {
      const answer = await showTerminalMenu(io, {
        title: `Write ${selected.length} resource(s) to ${destination}?`,
        items: [
          { value: "write", label: "Write proposal", description: "Create one new file; leave managed resources and local state untouched" },
          { value: "cancel", label: "Cancel", description: "Do not create a proposal" },
        ],
        initial: ["cancel"],
        maxVisible: 2,
      }, style);
      if (answer?.[0] !== "write") return failure(context, "adoption cancelled; no proposal was written", "cancelled");
    } else {
      const answer = await ask(rl!, `write ${selected.length} resource(s) to ${destination}? [y/N]> `);
      if (answer?.trim().toLowerCase() !== "y") return failure(context, "adoption cancelled; no proposal was written", "cancelled");
    }
    return writeAdoptionProposal(context, selected, destination);
  } catch (error) {
    return failure(context, error);
  } finally {
    rl?.close();
  }
}
