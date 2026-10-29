import fs from "node:fs";
import { parseArgs } from "node:util";
import { runInteractiveAdopt, writeAdoptionProposal } from "./adopt.js";
import { bundlePlanCommand } from "./bundle-plan.js";
import { createContext } from "./context.js";
import { explainCommand } from "./explain.js";
import { applyFromFile, runInteractiveInit, runNonInteractiveInit } from "./init-cli.js";
import { diffCommand, doctorCommand, inspectCommand, updateCommand } from "./plan.js";
import { redact } from "./process.js";
import { releaseCreateCommand } from "./release-cli.js";
import { resolveCommand } from "./resolve-cli.js";
import { renderResult } from "./result-view.js";
import { sourceCommand, type SourceAction } from "./source-cli.js";
import { prepareContextSources, sourceInputError } from "./source-context.js";
import { canUseTerminalMenu } from "./terminal-menu.js";
import { createTerminalStyle } from "./terminal.js";
import { runTui } from "./tui.js";
import type { CommandResult, OverallStatus } from "./types.js";

const HELP = `Usage: agentbrew [options]
       agentbrew <inspect|diff|doctor|update|resolve|explain|adopt|apply> [options]
       agentbrew source [set|list|refresh|clear] [options]
       agentbrew release create --layer team=<file> --output <file> [options]

Local-first Pi and herdr environment inspection, selective initialization,
portable configuration layers, updates, and health checks.
Without a command, a capable interactive terminal opens the read-only workspace.

Commands:
  init          Assess the target, explain choices, and apply only selected resources
  inspect       Show the active Pi host and herdr integration state
  diff          Show configuration and host-link differences without changing them
  doctor        Check the current configuration and native integration health
  update        Update explicitly managed Pi/extensions and verify the result
  resolve       Resolve target host and compatible npm versions without changes
  explain       Explain effective resources from explicit or registered layers
  adopt         Create a separate personal-layer proposal; do not change resources
  apply         Apply a reviewed typed plan from --plan <file>
  source        Set, list, refresh, or clear this target's registered layer inputs
  release       Publish verified team resources as a new Bundle Release

Options:
  --agent-dir <path>  Pi configuration root (default: PI_AGENT_DIR or ~/.pi/agent)
  --state-dir <path>  Agentbrew local state root (default: per-target user state)
  --layer <kind=file> Add a public, team, personal, or machine configuration layer
  --git <kind=repo#path> Register a Git-backed layer (source set)
  --user <name>       Match a team exception for this target user
  --machine <name>    Match a team exception for this target machine
  --expect <class>    Confirm empty, healthy, repairable, damaged, or unknown (init)
  --mode <mode>       init mode, or manage for diff planning
  --resource <id>     Select a resource; repeat where supported
  --output <file>     Write a new adoption proposal or Release (adopt/release create)
  --host-range <range> Declare a non-exact Pi compatibility range (release create)
  --apply            Authorize the selected init plan (init only)
  --plan-out <file>   Write a new selected plan without applying it
  --plan <file>       Read the selected typed plan (apply only)
  --dry-run          Preview an update without changing resources or acquiring a lock
  --selftest         Explicitly trust and run npm run selftest (update/doctor/release create)
  --write            Enable u apply in the interactive workspace (TTY only)
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
        write: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        verbose: { type: "boolean", default: false },
        expect: { type: "string" },
        mode: { type: "string" },
        resource: { type: "string", multiple: true },
        layer: { type: "string", multiple: true },
        git: { type: "string", multiple: true },
        user: { type: "string" },
        machine: { type: "string" },
        output: { type: "string" },
        "host-range": { type: "string" },
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
    if (values.write && !interactive) {
      throw new Error("--write only enables the interactive workspace and requires a TTY");
    }
    if (positionals.length === 0 && !interactive) {
      io.output.write(HELP);
      return 0;
    }
    const initOrExecutionOption = values.expect || values.mode || values.resource || values.apply
      || values["plan-out"] || values.output || values.plan || values["dry-run"] || values.selftest || values.verbose || values["host-range"] || values.git;
    const useTui = positionals.length === 0 && interactive && !values.json && !initOrExecutionOption
      && canUseTerminalMenu({ ...io, env: io.env ?? process.env });
    if (values.write && !useTui) {
      throw new Error("--write only enables the interactive workspace; run agentbrew --write in a TTY without a subcommand or --json");
    }
    if (useTui) {
      const context = createContext({
        agentDir: values["agent-dir"],
        stateDir: values["state-dir"],
        layers: values.layer,
        user: values.user,
        machine: values.machine,
      }, io.env ?? process.env);
      return await runTui(context, io, {}, { write: values.write });
    }
    const command = positionals[0] ?? "init";
    const sourceAction = positionals[1] ?? "list";
    const releaseAction = positionals[1] ?? "create";
    const commands = ["init", "apply", "inspect", "diff", "doctor", "update", "resolve", "explain", "adopt", "source", "release"];
    if (!commands.includes(command) || (command === "source"
      ? positionals.length > 2 || !["set", "list", "clear", "refresh"].includes(sourceAction)
      : command === "release"
        ? positionals.length > 2 || releaseAction !== "create"
        : positionals.length > 1)) {
      throw new Error("expected a supported command, source [set|list|clear], or release create");
    }
    if (values["dry-run"] && command !== "update") throw new Error("--dry-run is only valid with update");
    if (values.selftest && !["update", "doctor", "release"].includes(command)) throw new Error("--selftest is only valid with update, doctor, or release create");
    if (values.verbose && !["init", "apply", "resolve"].includes(command)) throw new Error("--verbose is only valid with init, apply, or resolve");
    if (values.expect && command !== "init") throw new Error("--expect is only valid with init");
    if (values.apply && command !== "init") throw new Error("--apply is only valid with init");
    if (values.mode && !["init", "diff"].includes(command)) throw new Error("--mode is only valid with init or diff planning");
    if (values.resource && !["init", "diff", "resolve", "explain", "adopt"].includes(command)) throw new Error("--resource is not valid with this command");
    if (values["plan-out"] && !["init", "diff"].includes(command)) throw new Error("--plan-out is only valid with init or diff");
    if (values.output && !["adopt", "release"].includes(command)) throw new Error("--output is only valid with adopt or release create");
    if (values["host-range"] && command !== "release") throw new Error("--host-range is only valid with release create");
    if (values.layer && !["inspect", "diff", "doctor", "update", "resolve", "explain", "source", "release"].includes(command)) {
      throw new Error("--layer is supported by inspect, diff, doctor, update, resolve, explain, source set, and release create");
    }
    if (command === "source" && values.layer && sourceAction !== "set") throw new Error("--layer is only valid with source set");
    if (values.git && (command !== "source" || sourceAction !== "set")) throw new Error("--git is only valid with source set");
    if (values.plan && command !== "apply") throw new Error("--plan is only valid with apply");
    if (command === "apply" && !values.plan) throw new Error("apply requires --plan <file>");
    if (command === "release" && !values.output) throw new Error("release create requires --output <file>");

    const context = createContext({
      agentDir: values["agent-dir"],
      stateDir: values["state-dir"],
      dryRun: values["dry-run"],
      selftest: values.selftest,
      layers: values.layer,
      user: values.user,
      machine: values.machine,
    }, io.env ?? process.env);
    const sourceAware = ["inspect", "diff", "doctor", "update", "resolve", "explain"].includes(command);
    let sourceError: CommandResult | undefined;
    if (sourceAware && values.layer === undefined) {
      try {
        prepareContextSources(context);
      } catch (error) {
        sourceError = sourceInputError(context, command as CommandResult["command"], error);
      }
    }

    let result: CommandResult;
    if (sourceError) {
      result = sourceError;
    } else if (command === "init") {
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
    } else if (command === "resolve") {
      result = await resolveCommand(context, values.resource ?? []);
    } else if (command === "explain") {
      result = explainCommand(context, values.resource ?? []);
    } else if (command === "adopt") {
      const scripted = values.json || values.output || values.resource;
      result = interactive && !scripted
        ? await runInteractiveAdopt(context, io, values.output)
        : writeAdoptionProposal(context, values.resource ?? [], values.output ?? "");
    } else if (command === "release") {
      result = releaseCreateCommand(context, values.output!, values["host-range"]);
    } else if (command === "source") {
      result = sourceCommand(context, sourceAction as SourceAction, values.git ?? []);
    } else {
      result = await updateCommand(context);
    }
    if (sourceAware && context.layerOrigin !== "none") {
      result.data = { ...(result.data as object ?? {}), layerOrigin: context.layerOrigin };
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
