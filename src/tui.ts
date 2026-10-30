import { loadBundle } from "./bundle.js";
import { bundlePlanCommand } from "./bundle-plan.js";
import type { Context } from "./context.js";
import { evaluateEnvironment, type EnvironmentEvaluation } from "./init.js";
import { readOwnership } from "./ownership.js";
import { doctorCommand, updateCommand } from "./plan.js";
import { redact } from "./process.js";
import { resolvedUpdateFingerprint } from "./providers/pi.js";
import { sourceCommand } from "./source-cli.js";
import { prepareContextSources, sourceInputError } from "./source-context.js";
import {
  checkTarget as checkTargetOperation,
  targetInventory,
  targetSummaryFromEvaluation,
  type TargetDescriptor,
  type TargetInventory,
  type TargetSummary,
} from "./targets.js";
import { createTerminalStyle } from "./terminal.js";
import type { TerminalInput, TerminalMenuIO } from "./terminal-menu.js";
import { renderTuiFrame, canApplyPreview, canToggleDetails, TUI_MENU_ITEMS, type TuiConfirmation, type TuiModel, type TuiPage } from "./tui-view.js";
import type { CommandResult } from "./types.js";

export interface TuiIO extends TerminalMenuIO {
  input: TerminalInput;
  error?: NodeJS.WritableStream;
}

export interface TuiOperations {
  overview: (context: Context) => Promise<{ evaluation: EnvironmentEvaluation; sources: CommandResult; targets: TargetInventory }>;
  targets: (context: Context) => Promise<TargetInventory>;
  checkTarget: (context: Context, target: TargetDescriptor) => Promise<TargetSummary>;
  health: (context: Context) => Promise<CommandResult>;
  changes: (context: Context) => Promise<CommandResult>;
  update: (context: Context) => Promise<CommandResult>;
  apply: (context: Context) => Promise<CommandResult>;
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
  options: { dryRun: boolean },
): Promise<CommandResult> {
  const scoped: Context = {
    ...context,
    layers: [...context.layers],
    dryRun: options.dryRun,
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
    const bundle = loadBundle(context.layers, context);
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

function updateCacheKey(base: Context): string | null {
  const probe: Context = { ...base, layers: [...base.layers] };
  try {
    prepareContextSources(probe);
  } catch {
    return null;
  }
  if (probe.layers.length === 0) return null;
  try {
    const bundle = loadBundle(probe.layers, probe);
    if (!bundle) return null;
    const ownership = readOwnership(probe);
    return `${bundle.inputHash}:${resolvedUpdateFingerprint(probe, bundle)}:${JSON.stringify(ownership?.resources ?? null)}`;
  } catch {
    return null;
  }
}

function mergeTargets(
  inventory: TargetInventory,
  previous?: TargetInventory,
  evaluation?: EnvironmentEvaluation,
): TargetInventory {
  const prior = new Map(previous?.targets.map((target) => [target.id, target]) ?? []);
  return {
    ...inventory,
    targets: inventory.targets.map((target) => {
      if (target.id === "local" && evaluation) return targetSummaryFromEvaluation(target, evaluation);
      const previousTarget = prior.get(target.id);
      return previousTarget && JSON.stringify(previousTarget.connection) === JSON.stringify(target.connection) ? previousTarget : target;
    }),
  };
}

const defaultOperations: TuiOperations = {
  overview: async (context) => {
    const evaluation = evaluateEnvironment(context);
    return { evaluation, sources: sourcesResult(context), targets: targetInventory(context) };
  },
  targets: async (context) => targetInventory(context),
  checkTarget: (context, target) => checkTargetOperation(context, target),
  health: (context) => scopedCommand(context, "doctor", doctorCommand, { dryRun: false }),
  changes: (context) => scopedCommand(context, "diff", (scoped) => bundlePlanCommand(scoped, [], undefined, undefined), { dryRun: false }),
  update: (context) => scopedCommand(context, "update", updateCommand, { dryRun: true }),
  apply: (context) => scopedCommand(context, "update", updateCommand, { dryRun: false }),
  sources: async (context) => sourcesResult(context),
};

function confirmationFrom(result: CommandResult): TuiConfirmation | null {
  const data = result.data as any;
  const resolution = data?.resolution;
  if (!resolution || data?.nativeMode) return null;
  const packages = (resolution.resources ?? [])
    .filter((resource: any) => resource.action === "update")
    .map((resource: any) => ({ id: String(resource.id), from: String(resource.currentVersion ?? "missing"), to: String(resource.targetVersion ?? "unknown") }));
  const host = resolution.host?.action === "update"
    ? { from: String(resolution.host.currentVersion), to: String(resolution.host.targetVersion) }
    : undefined;
  const herdr = result.steps.some((step) => step.id === "herdr-integration" && step.status === "planned");
  if (!host && packages.length === 0) return null;
  return { ...(host ? { host } : {}), packages, herdr };
}

export function runTui(context: Context, io: TuiIO, overrides: Partial<TuiOperations> = {}, options: { write?: boolean } = {}): Promise<number> {
  const operations = { ...defaultOperations, ...overrides };
  const input = io.input;
  const output = io.output;
  const wasRaw = input.isRaw === true;
  const model: TuiModel = {
    target: context.agentDir,
    page: "overview",
    menuIndex: 0,
    targetIndex: 0,
    busy: false,
    exitRequested: false,
    scroll: 0,
    writeEnabled: options.write === true,
    showDetails: false,
  };

  return new Promise((resolve) => {
    let started = false;
    let finished = false;
    let cleaned = false;
    let requestedExitCode = 0;
    let inputBuffer = "";
    let escapeTimer: NodeJS.Timeout | undefined;
    let ticker: NodeJS.Timeout | undefined;
    let controller: AbortController | undefined;
    let lastFrame = "";
    let wroteTarget = false;
    let previewCache: { key: string; result: CommandResult; at: number } | undefined;

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
        const outcome = wroteTarget ? "the update may have changed resources" : "no resources changed";
        safeWrite(io.error ?? output, `Agentbrew closed after an error · ${outcome}\n${message}\n`);
      } else {
        const outcome = wroteTarget ? `last update: ${model.result?.status ?? "unknown"}` : "no resources changed";
        safeWrite(output, `Agentbrew closed · ${outcome}\n`);
      }
      resolve(code);
    };
    const draw = (): void => {
      if (finished || !started) return;
      try {
        const style = createTerminalStyle(output, io.env ?? process.env, true);
        const frame = renderTuiFrame(model, style, Math.max(5, (output.rows || 24) - 1));
        model.scroll = frame.scroll;
        model.pageSize = frame.pageSize;
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
    const openConfirm = (): void => {
      if (!model.writeEnabled || model.page !== "update" || model.busy) return;
      if (!canApplyPreview(model.result)) return;
      const confirmation = confirmationFrom(model.result!);
      if (!confirmation) return;
      model.confirm = confirmation;
      model.confirmIndex = 1;
      model.page = "confirm";
      model.scroll = 0;
      draw();
    };
    const restore = (previous: { page: TuiPage; result?: CommandResult; evaluation?: EnvironmentEvaluation; sources?: CommandResult; targets?: TargetInventory; targetIndex?: number; scroll: number; cachedAt?: number; showDetails?: boolean }): void => {
      model.page = previous.page;
      model.result = previous.result;
      model.evaluation = previous.evaluation;
      model.sources = previous.sources;
      model.targets = previous.targets;
      model.targetIndex = previous.targetIndex;
      model.scroll = previous.scroll;
      model.cachedAt = previous.cachedAt;
      model.showDetails = previous.showDetails;
      model.busy = false;
      model.busySince = undefined;
      model.notice = "read-only request cancelled";
      stopTicker();
      if (model.exitRequested) {
        finish(requestedExitCode);
        return;
      }
      draw();
    };
    const activate = async (page: TuiPage, options: { refresh?: boolean; cancellable?: boolean } = {}): Promise<void> => {
      if (page === "help") return openHelp();
      if (finished || model.busy) return;
      const cacheKey = page === "update" ? updateCacheKey(live) : null;
      if (page === "update" && !options.refresh && cacheKey && previewCache?.key === cacheKey) {
        model.page = "update";
        model.scroll = 0;
        model.result = previewCache.result;
        model.cachedAt = previewCache.at;
        model.showDetails = false;
        model.notice = undefined;
        draw();
        return;
      }
      const previous = {
        page: model.page,
        result: model.result,
        evaluation: model.evaluation,
        sources: model.sources,
        targets: model.targets,
        targetIndex: model.targetIndex,
        scroll: model.scroll,
        cachedAt: model.cachedAt,
        showDetails: model.showDetails,
      };
      const cancellation = options.cancellable === false ? undefined : new AbortController();
      if (cancellation) {
        controller = cancellation;
        live.signal = cancellation.signal;
      }
      model.page = page;
      model.scroll = 0;
      model.result = undefined;
      model.cachedAt = undefined;
      model.showDetails = false;
      model.notice = page === "applied"
        ? "Applying the update; this writes to the target and cannot be cancelled…"
        : page === "update" ? "Resolving a dry-run; no resources will be changed…" : "Reading local state…";
      model.busy = true;
      model.busySince = Date.now();
      startTicker();
      draw();
      try {
        if (page === "overview") {
          const overview = await operations.overview(live);
          model.evaluation = overview.evaluation;
          model.sources = overview.sources;
          model.targets = mergeTargets(overview.targets, model.targets, overview.evaluation);
        } else if (page === "targets") {
          const targets = await operations.targets(live);
          model.targets = mergeTargets(targets, model.targets);
          model.targetIndex = Math.max(0, Math.min(model.targetIndex ?? 0, model.targets.targets.length - 1));
          model.scroll = (model.targetIndex ?? 0) * 2;
        } else if (page === "health") {
          model.result = await operations.health(live);
        } else if (page === "changes") {
          model.result = await operations.changes(live);
        } else if (page === "update") {
          model.result = await operations.update(live);
        } else if (page === "applied") {
          wroteTarget = true;
          model.result = await operations.apply(live);
        } else if (page === "sources") {
          model.result = await operations.sources(live);
        }
      } catch (error) {
        controller = undefined;
        live.signal = undefined;
        if (cancellation?.signal.aborted) return restore(previous);
        finish(1, error);
        return;
      }
      controller = undefined;
      live.signal = undefined;
      if (cancellation?.signal.aborted) return restore(previous);
      if (finished) return;
      if (page === "update" && cacheKey && model.result?.status === "success") {
        previewCache = { key: cacheKey, result: model.result, at: Date.now() };
      }
      if (page === "applied") {
        previewCache = undefined;
        model.cachedAt = undefined;
      }
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
    const checkSelectedTarget = async (): Promise<void> => {
      if (finished || model.busy || model.page !== "targets" || !model.targets) return;
      if (model.targets.error) return activate("targets", { refresh: true });
      const selected = model.targets.targets[model.targetIndex ?? 0];
      if (!selected) return;
      const previous = {
        page: model.page,
        result: model.result,
        evaluation: model.evaluation,
        sources: model.sources,
        targets: model.targets,
        targetIndex: model.targetIndex,
        scroll: model.scroll,
        cachedAt: model.cachedAt,
        showDetails: model.showDetails,
      };
      const cancellation = new AbortController();
      controller = cancellation;
      live.signal = cancellation.signal;
      model.targets = {
        ...model.targets,
        targets: model.targets.targets.map((target) => target.id === selected.id
          ? { ...target, state: "checking" as const, checkedAt: undefined, errorKind: undefined }
          : target),
      };
      model.notice = `Checking ${selected.id} only · read-only · no remote update…`;
      model.busy = true;
      model.busySince = Date.now();
      startTicker();
      draw();
      let summary: TargetSummary;
      try {
        const refreshed = await operations.targets(live);
        const current = mergeTargets(refreshed, model.targets);
        const latest = current.targets.find((target) => target.id === selected.id);
        if (!latest || JSON.stringify(latest.connection) !== JSON.stringify(selected.connection)) {
          controller = undefined;
          live.signal = undefined;
          model.targets = current;
          model.busy = false;
          model.busySince = undefined;
          model.notice = "Target registry changed; review the selection before checking";
          stopTicker();
          if (model.exitRequested) {
            finish(requestedExitCode);
            return;
          }
          draw();
          return;
        }
        model.targets = current;
        summary = await operations.checkTarget(live, latest);
      } catch (error) {
        controller = undefined;
        live.signal = undefined;
        if (cancellation.signal.aborted) return restore(previous);
        finish(1, error);
        return;
      }
      controller = undefined;
      live.signal = undefined;
      if (cancellation.signal.aborted) return restore(previous);
      if (finished) return;
      model.targets = {
        ...model.targets,
        targets: model.targets.targets.map((target) => target.id === summary.id ? summary : target),
      };
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
    const scrollResult = (name?: string): boolean => {
      const pageSize = Math.max(1, model.pageSize ?? 1);
      if (name === "home") model.scroll = 0;
      else if (name === "end") model.scroll = Number.MAX_SAFE_INTEGER;
      else if (name === "pageup" || name === "pagedown") {
        model.scroll = Math.max(0, model.scroll + (name === "pageup" ? -pageSize : pageSize));
      } else return false;
      draw();
      return true;
    };
    const onKeypress = (text: string, key: { name?: string; ctrl?: boolean }): void => {
      if (finished || !key) return;
      if ((key.ctrl && key.name === "c") || key.name === "q") {
        requestExit(key.ctrl ? 130 : 0);
        return;
      }
      if (model.busy) {
        if (key.name === "escape" && controller) {
          const error = new Error("read-only request cancelled");
          error.name = "AbortError";
          controller.abort(error);
        }
        return;
      }
      if (key.name === "escape") {
        if (model.page === "confirm") {
          model.confirm = undefined;
          model.page = "update";
          model.scroll = 0;
          draw();
          return;
        }
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
      if (model.page === "confirm") {
        if (scrollResult(key.name)) return;
        if (key.name === "up" || key.name === "down") {
          model.confirmIndex = (model.confirmIndex ?? 1) === 0 ? 1 : 0;
          draw();
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          if ((model.confirmIndex ?? 1) === 0) {
            model.confirm = undefined;
            void activate("applied", { cancellable: false });
          } else {
            model.confirm = undefined;
            model.page = "update";
            model.scroll = 0;
            draw();
          }
        }
        return;
      }
      if (key.name === "u" && model.page === "update") {
        openConfirm();
        return;
      }
      if (key.name === "t") {
        model.menuIndex = TUI_MENU_ITEMS.findIndex((item) => item.id === "targets");
        if (model.page !== "targets") void activate("targets");
        return;
      }
      if (key.name === "v" && (model.page === "targets" || (canToggleDetails(model.result)
        && ["health", "changes", "update", "sources", "applied"].includes(model.page)))) {
        model.showDetails = !model.showDetails;
        draw();
        return;
      }
      if (/^[1-9]$/.test(text)) {
        const direct = Number(text);
        const pages: TuiPage[] = ["overview", "health", "changes", "update", "sources", "help"];
        const page = pages[direct - 1];
        if (page) {
          model.menuIndex = TUI_MENU_ITEMS.findIndex((item) => item.id === page);
          if (page === "help") openHelp();
          else void activate(page);
          return;
        }
      }
      if (key.name === "r") {
        if (model.page === "targets") void checkSelectedTarget();
        else if (model.page === "applied") void activate("update", { refresh: true });
        else void activate(model.page, { refresh: true });
        return;
      }
      if (model.page === "overview") {
        if (key.name === "home" || key.name === "end") {
          model.menuIndex = key.name === "home" ? 0 : TUI_MENU_ITEMS.length - 1;
          draw();
        } else if (key.name === "up") {
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
      if (model.page === "targets") {
        if (["up", "down", "home", "end"].includes(key.name ?? "")) {
          const count = model.targets?.targets.length ?? 0;
          if (count > 0) {
            const current = model.targetIndex ?? 0;
            model.targetIndex = key.name === "home" ? 0 : key.name === "end" ? count - 1 : (current + (key.name === "up" ? count - 1 : 1)) % count;
            model.scroll = model.targetIndex * 2;
            draw();
          }
        } else if (key.name === "pageup" || key.name === "pagedown") scrollResult(key.name);
        return;
      }
      if (scrollResult(key.name)) return;
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
      const sequences = [
        ["\x1b[A", "up"], ["\x1bOA", "up"], ["\x1b[B", "down"], ["\x1bOB", "down"],
        ["\x1b[5~", "pageup"], ["\x1b[6~", "pagedown"],
        ["\x1b[H", "home"], ["\x1bOH", "home"], ["\x1b[1~", "home"], ["\x1b[7~", "home"],
        ["\x1b[F", "end"], ["\x1bOF", "end"], ["\x1b[4~", "end"], ["\x1b[8~", "end"],
      ] as const;
      while (inputBuffer.length > 0) {
        if (inputBuffer[0] !== "\x1b") {
          const character = inputBuffer[0]!;
          inputBuffer = inputBuffer.slice(1);
          if (character === "\x03") onKeypress("", { name: "c", ctrl: true });
          else if (character === "\r" || character === "\n") onKeypress("", { name: "enter" });
          else onKeypress(character, { name: character });
          continue;
        }
        const sequence = sequences.find(([value]) => inputBuffer.startsWith(value));
        if (sequence) {
          inputBuffer = inputBuffer.slice(sequence[0].length);
          onKeypress("", { name: sequence[1] });
          continue;
        }
        if (sequences.some(([value]) => value.startsWith(inputBuffer))) break;
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
