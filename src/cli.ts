import fs from "node:fs";
import { parseArgs } from "node:util";
import { runInteractiveAdopt, writeAdoptionProposal } from "./adopt.js";
import { bundlePlanCommand } from "./bundle-plan.js";
import { createContext } from "./context.js";
import { explainCommand } from "./explain.js";
import { applyFromFile, runInteractiveInit, runNonInteractiveInit } from "./init-cli.js";
import { diffCommand, doctorCommand, inspectCommand, updateCommand } from "./plan.js";
import { redact } from "./process.js";
import { canUseTerminalMenu } from "./terminal-menu.js";
import { createTerminalStyle, type TerminalStyle } from "./terminal.js";
import type { CommandResult, OverallStatus } from "./types.js";

const HELP = `Usage: agentbrew [init] [options]
       agentbrew <inspect|diff|doctor|update|explain|adopt|apply> [options]

Local-first Pi and herdr environment inspection, selective initialization,
portable configuration layers, updates, and health checks.

Commands:
  init          Assess the target, explain choices, and apply only selected resources
  inspect       Show the active Pi host and herdr integration state
  diff          Show configuration and host-link differences without changing them
  doctor        Check the current configuration and native integration health
  update        Update explicitly managed Pi/extensions and verify the result
  explain       Explain effective resources from explicit --layer inputs
  adopt         Create a separate personal-layer proposal; do not change resources
  apply         Apply a reviewed typed plan from --plan <file>

Options:
  --agent-dir <path>  Pi configuration root (default: PI_AGENT_DIR or ~/.pi/agent)
  --state-dir <path>  Agentbrew local state root (default: per-target user state)
  --layer <kind=file> Add a public, team, personal, or machine configuration layer
  --expect <class>    Confirm empty, healthy, repairable, damaged, or unknown (init)
  --mode <mode>       init mode, or manage for diff planning
  --resource <id>     Select a resource; repeat where supported
  --output <file>     Write a new adoption proposal (adopt only)
  --apply            Authorize the selected init plan (init only)
  --plan-out <file>   Write a new selected plan without applying it
  --plan <file>       Read the selected typed plan (apply only)
  --dry-run          Preview an update without changing resources or acquiring a lock
  --selftest         Explicitly trust and run npm run selftest (update/doctor only)
  --verbose          Show individual init/apply differences and checks
  --json             Print the versioned structured result; never prompts
  -h, --help         Show this help
  --version          Show the Agentbrew version
`;

interface CliIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  error: NodeJS.WritableStream;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
}

const processIO: CliIO = { input: process.stdin, output: process.stdout, error: process.stderr };

function exitCode(status: OverallStatus): number {
  if (status === "success") return 0;
  if (status === "partial") return 3;
  if (status === "unhealthy") return 4;
  if (status === "cancelled") return 5;
  if (status === "not-executed") return 6;
  return 1;
}

function renderResult(result: CommandResult, verbose: boolean, style?: TerminalStyle): string {
  const lines = [`target: ${result.target.agentDir}`];
  const data = result.data as any;
  if (result.command === "inspect" && data) {
    if (data.pi?.host) lines.push(`pi: ${data.pi.host.version} (${data.pi.host.source})`);
    if (data.herdr) {
      lines.push(data.herdr.available
        ? `herdr: ${data.herdr.version ?? "available"}; pi integration: ${data.herdr.integration}; plugins: ${data.herdr.plugins?.length ?? 0}`
        : `herdr: unavailable${data.herdr.error ? ` (${data.herdr.error})` : ""}`);
    }
  }
  if (data?.assessment) {
    const assessment = data.assessment;
    const failed = result.checks.filter((check) => check.status === "fail").length;
    const warnings = result.checks.filter((check) => check.status === "warn").length;
    lines.push(`classification: ${assessment.classification}`);
    lines.push(`pi: ${assessment.host ? `${assessment.host.version} (${assessment.host.source})` : "no usable host found"}`);
    lines.push(`health: ${failed} failing check(s), ${warnings} warning(s), ${result.differences.length} difference(s)`);
    if (assessment.issues?.length) lines.push(...assessment.issues.map((issue: string) => `issue: ${issue}`));
  }
  if (data?.planOut) lines.push(`plan: ${data.planOut}`);
  if (data?.output) lines.push(`proposal: ${data.output} (not an active configuration layer)`);
  if (data?.resources && result.command === "explain") {
    for (const resource of data.resources) {
      const declaration = resource.declaration ? ` ${JSON.stringify(resource.declaration)}` : "";
      lines.push(`${resource.id}: ${resource.state}; winner=${resource.layer}; required=${resource.required}${declaration}`);
      lines.push(`  history: ${resource.history.map((event: any) => `${event.layer}:${event.effect}`).join(" -> ")}`);
      if (resource.target) lines.push(`  target: ${resource.target}`);
    }
  }
  if (data?.bundle && result.command !== "explain") {
    lines.push(`bundle: ${data.bundle.resources.length} resource(s), ${data.bundle.removed.length} removal(s), ${data.bundle.required.length} required`);
  }
  if (data?.initializedResources) lines.push(`initialized: ${data.initializedResources.join(", ") || "none"}`);
  if (typeof data?.remainingDifferences === "number" && data.remainingDifferences > 0) {
    lines.push(`remaining differences: ${data.remainingDifferences} (unselected; use --verbose to expand)`);
  }
  const assessmentOnly = result.command === "init" && data?.assessment;
  if (!["init", "apply"].includes(result.command) || verbose) {
    for (const difference of result.differences) {
      lines.push(`DIFF ${difference.resource} ${difference.kind}: ${difference.actual} -> ${difference.expected}`);
    }
  } else if (assessmentOnly && result.differences.length > 0) {
    lines.push("use --verbose to show individual differences");
  }
  for (const step of result.steps) {
    const marker = step.status === "success" ? "OK" : step.status === "failed" ? "FAIL" : step.status === "skipped" ? "SKIP" : "PLAN";
    lines.push(`${marker} ${step.label}${step.message ? ` — ${step.message}` : ""}`);
  }
  if (!assessmentOnly || verbose) {
    for (const check of result.checks) lines.push(`${check.status.toUpperCase()} ${check.resource}: ${check.message}`);
  }
  if (result.error) lines.push(`error: ${result.error}`);
  lines.push(`result: ${result.status}; changes: ${result.changes}`);
  if (!style) return lines.join("\n");
  const statusTone = result.status === "success" ? "success" : result.status === "cancelled" || result.status === "not-executed" ? "warning" : "error";
  const rendered = lines.map((line) => {
    if (line.startsWith("PASS ") || line.startsWith("OK ")) return style.paint(line, "success");
    if (line.startsWith("WARN ")) return style.paint(line, "warning");
    if (line.startsWith("FAIL ") || line.startsWith("error:")) return style.paint(line, "error");
    if (line.startsWith("DIFF ") || line.startsWith("SKIP ") || line.startsWith("target:")) return style.paint(line, "muted");
    if (line.startsWith("PLAN ") || line.startsWith("initialized:")) return style.paint(line, "accent");
    if (line.startsWith("result:")) return style.paint(line, statusTone);
    return line;
  });
  return ["", style.title(`Agentbrew · ${result.command}`), style.rule(), ...rendered].join("\n");
}

function packageVersion(): string {
  const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return String(manifest.version);
}

export async function runCli(argv: string[], io: CliIO = processIO): Promise<number> {
  const interactive = io.interactive ?? Boolean((io.input as any).isTTY && (io.output as any).isTTY);
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        "agent-dir": { type: "string" },
        "state-dir": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        selftest: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        verbose: { type: "boolean", default: false },
        expect: { type: "string" },
        mode: { type: "string" },
        resource: { type: "string", multiple: true },
        layer: { type: "string", multiple: true },
        output: { type: "string" },
        apply: { type: "boolean", default: false },
        "plan-out": { type: "string" },
        plan: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", default: false },
      },
    });

    if (values.version) {
      io.output.write(`${packageVersion()}\n`);
      return 0;
    }
    if (values.help) {
      io.output.write(HELP);
      return 0;
    }
    if (positionals.length === 0 && !interactive) {
      io.output.write(HELP);
      return 0;
    }
    const command = positionals[0] ?? "init";
    if (positionals.length > 1 || !["init", "apply", "inspect", "diff", "doctor", "update", "explain", "adopt"].includes(command)) {
      throw new Error("expected one command: init, apply, inspect, diff, doctor, update, explain, or adopt");
    }
    if (values["dry-run"] && command !== "update") throw new Error("--dry-run is only valid with update");
    if (values.selftest && !["update", "doctor"].includes(command)) throw new Error("--selftest is only valid with update or doctor");
    if (values.verbose && !["init", "apply"].includes(command)) throw new Error("--verbose is only valid with init or apply");
    if (values.expect && command !== "init") throw new Error("--expect is only valid with init");
    if (values.apply && command !== "init") throw new Error("--apply is only valid with init");
    if (values.mode && !["init", "diff"].includes(command)) throw new Error("--mode is only valid with init or diff planning");
    if (values.resource && !["init", "diff", "explain", "adopt"].includes(command)) throw new Error("--resource is not valid with this command");
    if (values["plan-out"] && !["init", "diff"].includes(command)) throw new Error("--plan-out is only valid with init or diff");
    if (values.output && command !== "adopt") throw new Error("--output is only valid with adopt");
    if (values.layer && !["inspect", "diff", "doctor", "update", "explain"].includes(command)) {
      throw new Error("--layer is supported by inspect, diff, doctor, update, and explain; typed plans carry their own sources");
    }
    if (values.plan && command !== "apply") throw new Error("--plan is only valid with apply");
    if (command === "apply" && !values.plan) throw new Error("apply requires --plan <file>");

    const context = createContext({
      agentDir: values["agent-dir"],
      stateDir: values["state-dir"],
      dryRun: values["dry-run"],
      selftest: values.selftest,
      layers: values.layer,
    }, io.env ?? process.env);
    let result: CommandResult;
    if (command === "init") {
      const scripted = values.json || values.expect || values.mode || values.resource || values.apply || values["plan-out"];
      result = interactive && !scripted
        ? await runInteractiveInit(context, io, values.verbose)
        : runNonInteractiveInit(context, {
            expect: values.expect,
            mode: values.mode,
            resources: values.resource,
            apply: values.apply,
            planOut: values["plan-out"],
          });
    } else if (command === "apply") {
      result = applyFromFile(context, values.plan!);
    } else if (command === "inspect") {
      result = inspectCommand(context);
    } else if (command === "diff") {
      result = bundlePlanCommand(context, values.resource ?? [], values.mode, values["plan-out"]);
    } else if (command === "doctor") {
      result = doctorCommand(context);
    } else if (command === "explain") {
      result = explainCommand(context, values.resource ?? []);
    } else if (command === "adopt") {
      const scripted = values.json || values.output || values.resource;
      result = interactive && !scripted
        ? await runInteractiveAdopt(context, io, values.output)
        : writeAdoptionProposal(context, values.resource ?? [], values.output ?? "");
    } else {
      result = updateCommand(context);
    }

    const outputStream = values.json || result.status === "success" ? io.output : io.error;
    const style = !values.json && canUseTerminalMenu(io)
      ? createTerminalStyle(outputStream, io.env ?? process.env, true)
      : undefined;
    const rendered = values.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderResult(result, values.verbose, style)}\n`;
    outputStream.write(rendered);
    return exitCode(result.status);
  } catch (error) {
    io.error.write(`agentbrew: ${redact(error instanceof Error ? error.message : String(error))}\n`);
    io.error.write("Run agentbrew --help for usage.\n");
    return 2;
  }
}
