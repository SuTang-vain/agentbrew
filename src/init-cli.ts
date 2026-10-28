import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { applyBundlePlan } from "./bundle-apply.js";
import { readBundlePlan } from "./bundle-plan.js";
import type { Context } from "./context.js";
import { applyInitPlan } from "./init-apply.js";
import {
  allowedInitModes,
  createInitPlan,
  evaluateEnvironment,
  initResult,
  readInitPlan,
  writeInitPlan,
  type EnvironmentEvaluation,
} from "./init.js";
import { redact } from "./process.js";
import { canUseTerminalMenu, showTerminalMenu } from "./terminal-menu.js";
import { createTerminalStyle, type TerminalStyle } from "./terminal.js";
import type { CommandResult, InitMode, InitPlan, StepResult } from "./types.js";

export interface InitIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
}

export interface InitOptions {
  expect?: string;
  mode?: string;
  resources?: string[];
  apply: boolean;
  planOut?: string;
}

const MODE_LABELS: Record<InitMode, string> = {
  observe: "Observe only; no files or local state are changed",
  adopt: "Adopt selected resources without automatic updates or convergence",
  repair: "Repair only selected generated links and integration",
  manage: "Manage only selected resources; normalize only selected host declarations",
  fresh: "Create the selected minimum structure in a proven-empty configuration root",
};

function write(io: InitIO, text: string): void {
  io.output.write(`${text}\n`);
}

export function renderEvaluation(context: Context, evaluation: EnvironmentEvaluation, verbose: boolean): string {
  const { assessment, differences, checks } = evaluation;
  const failed = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  const lines = [
    `target: ${context.agentDir}`,
    `classification: ${assessment.classification}`,
    `pi: ${assessment.host ? `${assessment.host.version} (${assessment.host.source})` : "no usable host found"}`,
    `configuration: ${assessment.manifest ? `${Object.keys(assessment.manifest.dependencies).length} npm dependency(ies)` : "no usable npm manifest"}`,
    `health: ${failed} failing check(s), ${warnings} warning(s), ${differences.length} difference(s)`,
    "detection only: no resources, state, locks, or selftest have been changed or executed",
  ];
  if (!assessment.host && assessment.classification === "empty") {
    lines.push("next: install Pi independently, then rerun init; no fresh configuration can be applied yet");
  } else {
    lines.push("next: choose Observe or an explicit selection; nothing is applied automatically");
  }
  if (assessment.issues.length > 0) lines.push(...assessment.issues.map((issue) => `issue: ${issue}`));
  if (verbose) {
    lines.push(...differences.map((difference) => `DIFF ${difference.resource} ${difference.kind}: ${difference.actual} -> ${difference.expected}`));
    lines.push(...checks.map((check) => `${check.status.toUpperCase()} ${check.resource}: ${check.message}`));
  } else if (differences.length > 0) {
    lines.push("use --verbose to show individual differences");
  }
  return lines.join("\n");
}

export function renderInitPlan(plan: InitPlan): string {
  return [
    `plan target: ${plan.target.agentDir}`,
    `plan classification: ${plan.classification}`,
    `plan mode: ${plan.mode}`,
    `selected resources: ${plan.resources.length > 0 ? plan.resources.join(", ") : "none"}`,
    ...plan.actions.map((action) => `planned action: ${action}`),
    "no host upgrade, third-party extension upgrade, selftest, reset, or unselected write is authorized",
  ].join("\n");
}

function visualRow(style: TerminalStyle, label: string, value: string, tone?: "accent" | "muted" | "success" | "warning" | "error"): string {
  return `${style.paint(style.padEnd(label, 14), "muted")}${tone ? style.paint(value, tone) : value}`;
}

export function renderVisualEvaluation(
  context: Context,
  evaluation: EnvironmentEvaluation,
  verbose: boolean,
  style: TerminalStyle,
): string {
  const { assessment, differences, checks } = evaluation;
  const failed = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  const statusTone = assessment.classification === "healthy" ? "success"
    : assessment.classification === "damaged" || assessment.classification === "unknown" ? "error"
      : assessment.classification === "repairable" ? "warning" : "accent";
  const statusText = assessment.classification === "repairable" ? "Repairable · existing configuration needs attention"
    : assessment.classification === "empty" ? "Empty · no usable npm configuration"
      : assessment.classification === "healthy" ? "Healthy · existing configuration"
        : `${assessment.classification} · review diagnostics before making changes`;
  const health = failed > 0
    ? `${differences.length} differences · ${failed} checks need attention`
    : warnings > 0 ? `No blocking failures · ${warnings} informational warning(s)` : "Healthy";
  const lines = [
    "",
    style.title("Agentbrew"),
    style.paint("Guided setup · inspect first, change only what you select", "muted"),
    style.rule(),
    visualRow(style, "Target", style.truncateMiddle(context.agentDir, style.width - 14)),
    visualRow(style, "Status", statusText, statusTone),
    visualRow(style, "Pi", assessment.host ? `${assessment.host.version} · ${assessment.host.source}` : "No usable host found", assessment.host ? undefined : "error"),
    visualRow(style, "Configuration", assessment.manifest ? `${Object.keys(assessment.manifest.dependencies).length} npm dependencies` : "No usable npm manifest"),
    visualRow(style, "Health", health, failed > 0 ? "warning" : "success"),
    visualRow(style, "Safety", "Read-only · no changes, lock, or selftest", "accent"),
  ];
  if (!assessment.host && assessment.classification === "empty") {
    lines.push(...style.wrap("Install Pi independently, then rerun init. Fresh install is blocked until a host is available.", "  "));
  }
  for (const issue of assessment.issues) lines.push(...style.wrap(`Note: ${issue}`, "  "));
  if (verbose) {
    lines.push("", style.bold("Differences and checks"));
    lines.push(...differences.map((difference) => style.truncate(`DIFF ${difference.resource} ${difference.kind}: ${difference.actual} -> ${difference.expected}`)));
    lines.push(...checks.map((check) => style.truncate(`${check.status.toUpperCase()} ${check.resource}: ${check.message}`)));
  } else if (differences.length > 0) {
    lines.push("", style.paint("Detailed differences are available with --verbose.", "muted"));
  }
  lines.push("");
  return lines.join("\n");
}

export function renderVisualInitPlan(plan: InitPlan, style: TerminalStyle): string {
  const actionLabels: Record<InitPlan["actions"][number], string> = {
    "record-ownership": "Record ownership only for resources that complete successfully",
    "repair-pi-links": "Repair generated Pi host and dependency links",
    "normalize-pi-dependencies": "Normalize selected portable host dependency declarations",
    "install-minimal-pi": "Create the minimal Pi npm structure without lifecycle scripts",
    "generate-herdr-integration": "Generate the native herdr Pi integration when needed",
  };
  const lines = [
    "",
    style.bold("Review your plan"),
    style.rule(),
    visualRow(style, "Mode", plan.mode, "accent"),
    visualRow(style, "Target", style.truncateMiddle(plan.target.agentDir, style.width - 14)),
    visualRow(style, "Host", plan.host ? `${plan.host.version} · ${plan.host.source}` : "none"),
    visualRow(style, "Resources", `${plan.resources.length} selected`),
    ...style.wrap(plan.resources.join(", "), "  "),
    "",
    style.bold("Selected actions"),
    ...plan.actions.map((action) => `  ${actionLabels[action]}`),
    ...style.wrap("Not authorized: host or third-party extension upgrades, selftest, reset, or unselected writes.", "  "),
    "",
    style.paint("Cancel is selected by default.", "muted"),
  ];
  return lines.map((line) => style.truncate(line)).join("\n");
}

function cancelled(context: Context, evaluation: EnvironmentEvaluation): CommandResult {
  const result = initResult(context, evaluation, "cancelled");
  result.error = "init cancelled before authorization; no changes were made";
  return result;
}

async function ask(rl: readline.Interface, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      rl.off("SIGINT", onSigint);
      resolve(value);
    };
    const onSigint = () => {
      rl.close();
      finish(null);
    };
    rl.once("SIGINT", onSigint);
    rl.question(prompt).then((answer) => finish(answer), () => finish(null));
  });
}

export async function runInteractiveInit(context: Context, io: InitIO, verbose: boolean): Promise<CommandResult> {
  const visual = canUseTerminalMenu(io);
  const style = createTerminalStyle(io.output, io.env ?? process.env, visual);
  const evaluation = evaluateEnvironment(context);
  write(io, visual ? renderVisualEvaluation(context, evaluation, verbose, style) : renderEvaluation(context, evaluation, verbose));
  const rl = visual ? null : readline.createInterface({ input: io.input, output: io.output, terminal: false });
  try {
    const modes = allowedInitModes(evaluation.assessment.classification);
    let mode: InitMode | undefined;
    if (visual) {
      const answer = await showTerminalMenu(io, {
        title: "Choose an action",
        items: modes.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1), description: MODE_LABELS[value] })),
        initial: [modes[0]!],
        maxVisible: 5,
      }, style);
      if (answer === null) return cancelled(context, evaluation);
      mode = answer[0] as InitMode | undefined;
    } else {
      write(io, "choose an action (default: 1, Observe):");
      modes.forEach((mode, index) => write(io, `  ${index + 1}. ${mode} — ${MODE_LABELS[mode]}`));
      write(io, "  q. cancel without changes");
      const modeAnswer = await ask(rl!, "action> ");
      if (modeAnswer === null || modeAnswer.trim().toLowerCase() === "q") return cancelled(context, evaluation);
      const modeIndex = modeAnswer.trim() === "" ? 0 : Number(modeAnswer) - 1;
      mode = Number.isInteger(modeIndex) ? modes[modeIndex] : undefined;
    }
    if (!mode) return cancelled(context, evaluation);
    if (mode === "observe") {
      const result = initResult(context, evaluation);
      result.data = { assessment: evaluation.assessment, mode };
      return result;
    }

    const resources = evaluation.assessment.resources;
    let selected: string[];
    if (visual) {
      const answer = await showTerminalMenu(io, {
        title: "Select resources",
        items: resources.map((resource) => ({
          value: resource.id,
          label: resource.id,
          description: resource.description,
          detail: `Side effect: ${resource.sideEffect}`,
          required: resource.required,
        })),
        initial: resources.filter((resource) => resource.required).map((resource) => resource.id),
        multiple: true,
        maxVisible: 5,
      }, style);
      if (answer === null) return cancelled(context, evaluation);
      selected = answer;
    } else {
      write(io, "select resources by number, comma-separated; 'a' selects all, empty selects only required items:");
      resources.forEach((resource, index) => write(io,
        `  ${index + 1}. ${resource.id}${resource.required ? " [required]" : " [optional]"}\n     ${resource.description}\n     side effect: ${resource.sideEffect}`,
      ));
      const resourceAnswer = await ask(rl!, "resources> ");
      if (resourceAnswer === null || resourceAnswer.trim().toLowerCase() === "q") return cancelled(context, evaluation);
      if (resourceAnswer.trim().toLowerCase() === "a") selected = resources.map((resource) => resource.id);
      else {
        const indexes = resourceAnswer.trim() === "" ? [] : resourceAnswer.split(",").map((value) => Number(value.trim()) - 1);
        if (indexes.some((index) => !Number.isInteger(index) || !resources[index])) return cancelled(context, evaluation);
        selected = resources.filter((resource, index) => resource.required || indexes.includes(index)).map((resource) => resource.id);
      }
    }

    let plan: InitPlan;
    try {
      plan = createInitPlan(context, evaluation, mode, selected);
    } catch (error) {
      const result = initResult(context, evaluation, "not-executed");
      result.error = redact(error instanceof Error ? error.message : String(error));
      return result;
    }
    if (visual) {
      write(io, renderVisualInitPlan(plan, style));
      const answer = await showTerminalMenu(io, {
        title: "Apply this plan?",
        items: [
          { value: "apply", label: "Apply selected plan", description: "Run only the reviewed actions, then verify selected resources" },
          { value: "cancel", label: "Cancel", description: "Return without writing configuration or local state" },
        ],
        initial: ["cancel"],
        maxVisible: 2,
      }, style);
      if (answer?.[0] !== "apply") return cancelled(context, evaluation);
    } else {
      write(io, renderInitPlan(plan));
      const confirmation = await ask(rl!, "apply this exact plan? [y/N]> ");
      if (confirmation?.trim().toLowerCase() !== "y") return cancelled(context, evaluation);
    }
    return applyInitPlan(context, plan, "init");
  } finally {
    rl?.close();
  }
}

export function runNonInteractiveInit(context: Context, options: InitOptions): CommandResult {
  const evaluation = evaluateEnvironment(context);
  const result = initResult(context, evaluation);
  if (!options.expect || !options.mode) {
    result.status = "not-executed";
    result.error = "non-interactive init requires explicit --expect and --mode; no resources were changed";
    return result;
  }
  if (options.expect !== evaluation.assessment.classification) {
    result.status = "not-executed";
    result.error = `expected ${options.expect}, found ${evaluation.assessment.classification}; review the new assessment`;
    return result;
  }
  if (options.mode !== "observe" && !options.resources?.length) {
    result.status = "not-executed";
    result.error = "non-interactive init requires repeated explicit --resource selections";
    return result;
  }

  let plan: InitPlan;
  try {
    plan = createInitPlan(context, evaluation, options.mode as InitMode, options.resources ?? []);
  } catch (error) {
    result.status = "not-executed";
    result.error = redact(error instanceof Error ? error.message : String(error));
    return result;
  }
  result.data = { assessment: evaluation.assessment,plan };
  result.steps = plan.actions.map((action): StepResult => ({ id: action, label: action, status: "planned", changes: "none" }));
  if (options.planOut) {
    try {
      const destination = path.resolve(options.planOut);
      writeInitPlan(destination, plan);
      result.data = { assessment: evaluation.assessment,planOut: destination };
    } catch (error) {
      result.status = "not-executed";
      result.error = redact(error instanceof Error ? error.message : String(error));
      return result;
    }
  }
  if (options.apply) return applyInitPlan(context, plan, "init");
  if (options.mode === "observe") {
    result.data = { assessment: evaluation.assessment,mode: "observe" };
    return result;
  }
  result.status = "not-executed";
  result.error = options.planOut
    ? "plan written only; authorize it separately with agentbrew apply --plan <file>"
    : "no --apply authorization was supplied; no resources were changed";
  return result;
}

export function applyFromFile(context: Context, file: string): CommandResult {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if ((value as { kind?: unknown })?.kind === "agentbrew-bundle-plan") {
      return applyBundlePlan(context, readBundlePlan(file));
    }
    return applyInitPlan(context, readInitPlan(file), "apply");
  } catch (error) {
    return {
      schemaVersion: 1,
      command: "apply",
      status: "not-executed",
      target: { agentDir: context.agentDir },
      changes: "none",
      steps: [],
      differences: [],
      checks: [],
      error: redact(error instanceof Error ? error.message : String(error)),
    };
  }
}
