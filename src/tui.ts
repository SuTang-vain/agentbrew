import { loadBundle } from "./bundle.js";
import { bundlePlanCommand } from "./bundle-plan.js";
import type { Context } from "./context.js";
import { evaluateEnvironment, type EnvironmentEvaluation } from "./init.js";
import { doctorCommand, updateCommand } from "./plan.js";
import { redact } from "./process.js";
import { sourceCommand } from "./source-cli.js";
import { prepareContextSources, sourceInputError } from "./source-context.js";
import { createTerminalStyle } from "./terminal.js";
import type { TerminalInput, TerminalMenuIO } from "./terminal-menu.js";
import { renderTuiFrame, TUI_MENU_ITEMS, type TuiModel, type TuiPage } from "./tui-view.js";
import type { CommandResult } from "./types.js";

export interface TuiIO extends TerminalMenuIO {
  input: TerminalInput;
  error?: NodeJS.WritableStream;
}

export interface TuiOperations {
  overview: (context: Context) => Promise<{ evaluation: EnvironmentEvaluation; sources: CommandResult }>;
  health: (context: Context) => Promise<CommandResult>;
  changes: (context: Context) => Promise<CommandResult>;
  update: (context: Context) => Promise<CommandResult>;
  sources: (context: Context) => Promise<CommandResult>;
}

function withLayerOrigin(result: CommandResult, context: Context): CommandResult {
  if (context.layerOrigin !== "none") {
    result.data = { ...(result.data as object ?? {}), layerOrigin: context.layerOrigin };
  }
  return result;
}

async function scopedCommand(
  context: Context,
  command: "doctor" | "diff" | "update",
  operation: (scoped: Context) => CommandResult | Promise<CommandResult>,
): Promise<CommandResult> {
  const scoped: Context = {
    ...context,
    layers: [...context.layers],
    dryRun: command === "update",
    selftest: false,
  };
  try {
    prepareContextSources(scoped);
    return withLayerOrigin(await operation(scoped), scoped);
  } catch (error) {
    return sourceInputError(scoped, command, error);
  }
}

function sourcesResult(context: Context): CommandResult {
  if (context.layerOrigin !== "explicit") return withLayerOrigin(sourceCommand(context, "list"), context);
  try {
    const bundle = loadBundle(context.layers);
    if (!bundle) throw new Error("explicit sources require at least one layer");
    return {
      schemaVersion: 1,
      command: "source",
      status: "success",
      target: { agentDir: context.agentDir },
      changes: "none",
      steps: [],
      differences: [],
      checks: [],
      data: {
        action: "list",
        resourcesChanged: false,
        registered: false,
        state: "none",
        layers: bundle.sources,
        layerOrigin: "explicit",
      },
    };
  } catch (error) {
    return sourceInputError(context, "source", error);
  }
}

const defaultOperations: TuiOperations = {
  overview: async (context) => ({
    evaluation: evaluateEnvironment(context),
    sources: sourcesResult(context),
  }),
  health: (context) => scopedCommand(context, "doctor", doctorCommand),
  changes: (context) => scopedCommand(context, "diff", (scoped) => bundlePlanCommand(scoped, [], undefined, undefined)),
  update: (context) => scopedCommand(context, "update", updateCommand),
  sources: async (context) => sourcesResult(context),
};

export function runTui(context: Context, io: TuiIO, overrides: Partial<TuiOperations> = {}): Promise<number> {
  const operations = { ...defaultOperations, ...overrides };
  const input = io.input;
  const output = io.output;
  const wasRaw = input.isRaw === true;
  const model: TuiModel = {
    target: context.agentDir,
    page: "overview",
    menuIndex: 0,
    busy: false,
    exitRequested: false,
    scroll: 0,
  };

  return new Promise((resolve) => {
    let started = false;
    let finished = false;
    let cleaned = false;
    let requestedExitCode = 0;
    let inputBuffer = "";
    let escapeTimer: NodeJS.Timeout | undefined;
    let ticker: NodeJS.Timeout | undefined;
    let lastFrame = "";

    const stopTicker = (): void => {
      if (ticker) clearInterval(ticker);
      ticker = undefined;
    };
    const startTicker = (): void => {
      stopTicker();
      ticker = setInterval(() => {
        if (finished || !model.busy) {
          stopTicker();
          return;
        }
        draw();
      }, 500);
    };

    const safeWrite = (stream: NodeJS.WritableStream, text: string): void => {
      try {
        stream.write(text);
      } catch {}
    };
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      input.off("data", onData);
      if (escapeTimer) clearTimeout(escapeTimer);
      stopTicker();
      input.off("end", onEnd);
      input.off("error", onInputError);
      output.off("resize", onResize);
      output.off("error", onOutputError);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      try {
        if (typeof input.setRawMode === "function") input.setRawMode(wasRaw);
      } catch {}
      input.pause();
      if (started) safeWrite(output, "\x1b[0J\x1b[?25h\x1b[?1049l");
    };
    const finish = (code: number, error?: unknown): void => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) {
        const message = redact(error instanceof Error ? error.message : String(error));
        safeWrite(io.error ?? output, `Agentbrew closed after an error · no resources changed\n${message}\n`);
      } else {
        safeWrite(output, "Agentbrew closed · no resources changed\n");
      }
      resolve(code);
    };
    const draw = (): void => {
      if (finished || !started) return;
      try {
        const style = createTerminalStyle(output, io.env ?? process.env, true);
        const frame = renderTuiFrame(model, style, Math.max(5, (output.rows || 24) - 1));
        model.scroll = frame.scroll;
        const text = `\x1b[H\x1b[0J${frame.lines.join("\n")}\n`;
        if (text === lastFrame) return;
        lastFrame = text;
        output.write(text);
      } catch (error) {
        finish(1, error);
      }
    };
    const live: Context = {
      ...context,
      progress: (message: string): void => {
        if (finished || !model.busy) return;
        model.notice = message;
        draw();
      },
    };
    const requestExit = (code: number): void => {
      if (finished) return;
      requestedExitCode = code;
      if (model.busy) {
        model.exitRequested = true;
        draw();
        return;
      }
      finish(code);
    };
    const openHelp = (): void => {
      if (model.page !== "help") model.returnPage = model.page;
      model.page = "help";
      model.scroll = 0;
      draw();
    };
    const activate = async (page: TuiPage): Promise<void> => {
      if (page === "help") return openHelp();
      if (finished || model.busy) return;
      model.page = page;
      model.scroll = 0;
      model.result = undefined;
      model.notice = page === "update" ? "Resolving a dry-run; no resources will be changed…" : "Reading local state…";
      model.busy = true;
      model.busySince = Date.now();
      startTicker();
      draw();
      try {
        if (page === "overview") {
          const overview = await operations.overview(live);
          model.evaluation = overview.evaluation;
          model.sources = overview.sources;
        } else if (page === "health") {
          model.result = await operations.health(live);
        } else if (page === "changes") {
          model.result = await operations.changes(live);
        } else if (page === "update") {
          model.result = await operations.update(live);
        } else if (page === "sources") {
          model.result = await operations.sources(live);
        }
      } catch (error) {
        finish(1, error);
        return;
      }
      if (finished) return;
      model.busy = false;
      model.busySince = undefined;
      model.notice = undefined;
      stopTicker();
      if (model.exitRequested) {
        finish(requestedExitCode);
        return;
      }
      draw();
    };
    const onKeypress = (text: string, key: { name?: string; ctrl?: boolean }): void => {
      if (finished || !key) return;
      if ((key.ctrl && key.name === "c") || key.name === "q") {
        requestExit(key.ctrl ? 130 : 0);
        return;
      }
      if (model.busy) return;
      if (key.name === "escape") {
        if (model.page === "help" && model.returnPage) {
          model.page = model.returnPage;
          model.returnPage = undefined;
          model.scroll = 0;
          draw();
          return;
        }
        if (model.page !== "overview") void activate("overview");
        return;
      }
      if (text === "?" && model.page !== "help") {
        openHelp();
        return;
      }
      if (/^[1-9]$/.test(text)) {
        const direct = Number(text);
        if (direct <= TUI_MENU_ITEMS.length - 1) {
          const target = TUI_MENU_ITEMS[direct - 1]!;
          model.menuIndex = direct - 1;
          if (target.id === "help") openHelp();
          else if (target.id !== "quit") void activate(target.id);
          return;
        }
      }
      if (key.name === "r") {
        void activate(model.page);
        return;
      }
      if (model.page === "overview") {
        if (key.name === "up") {
          model.menuIndex = (model.menuIndex + TUI_MENU_ITEMS.length - 1) % TUI_MENU_ITEMS.length;
          draw();
        } else if (key.name === "down") {
          model.menuIndex = (model.menuIndex + 1) % TUI_MENU_ITEMS.length;
          draw();
        } else if (key.name === "return" || key.name === "enter") {
          const selected = TUI_MENU_ITEMS[model.menuIndex]!;
          if (selected.id === "quit") finish(0);
          else if (selected.id === "help") openHelp();
          else void activate(selected.id);
        }
        return;
      }
      if (key.name === "up" || key.name === "down") {
        model.scroll = Math.max(0, model.scroll + (key.name === "up" ? -1 : 1));
        draw();
      }
    };
    const onData = (chunk: Buffer | string): void => {
      inputBuffer += chunk.toString();
      if (escapeTimer) {
        clearTimeout(escapeTimer);
        escapeTimer = undefined;
      }
      const arrows = ["\x1b[A", "\x1b[B", "\x1bOA", "\x1bOB"];
      while (inputBuffer.length > 0) {
        if (inputBuffer[0] !== "\x1b") {
          const character = inputBuffer[0]!;
          inputBuffer = inputBuffer.slice(1);
          if (character === "\x03") onKeypress("", { name: "c", ctrl: true });
          else if (character === "\r" || character === "\n") onKeypress("", { name: "enter" });
          else onKeypress(character, { name: character });
          continue;
        }
        const arrow = arrows.find((sequence) => inputBuffer.startsWith(sequence));
        if (arrow) {
          inputBuffer = inputBuffer.slice(arrow.length);
          onKeypress("", { name: arrow.endsWith("A") ? "up" : "down" });
          continue;
        }
        if (inputBuffer.length < 3 && arrows.some((sequence) => sequence.startsWith(inputBuffer))) break;
        inputBuffer = inputBuffer.slice(1);
        onKeypress("", { name: "escape" });
      }
      if (inputBuffer.startsWith("\x1b")) {
        escapeTimer = setTimeout(() => {
          inputBuffer = "";
          onKeypress("", { name: "escape" });
        }, 20);
      }
    };
    const onEnd = (): void => requestExit(0);
    const onResize = (): void => draw();
    const onInputError = (error: unknown): void => finish(1, error);
    const onOutputError = (error: unknown): void => finish(1, error);
    const onSigint = (): void => requestExit(130);
    const onSigterm = (): void => requestExit(143);

    try {
      started = true;
      output.write("\x1b[?1049h\x1b[?25l");
      input.setRawMode!(true);
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("error", onInputError);
      output.on("resize", onResize);
      output.once("error", onOutputError);
      process.once("SIGINT", onSigint);
      process.once("SIGTERM", onSigterm);
      input.resume();
      draw();
      void activate("overview");
    } catch (error) {
      finish(1, error);
    }
  });
}
