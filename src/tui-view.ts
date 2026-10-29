import type { EnvironmentEvaluation } from "./init.js";
import { renderResult } from "./result-view.js";
import { visibleWidth, type TerminalStyle } from "./terminal.js";
import type { CommandResult } from "./types.js";

export type TuiPage = "overview" | "health" | "changes" | "update" | "sources" | "help" | "confirm" | "applied";

export interface TuiMenuItem {
  id: TuiPage | "quit";
  label: string;
  description: string;
}

export const TUI_MENU_ITEMS: TuiMenuItem[] = [
  { id: "overview", label: "Overview", description: "Local environment, health summary, and active sources" },
  { id: "health", label: "Health", description: "Run static doctor checks; never run selftest implicitly" },
  { id: "changes", label: "Differences", description: "Inspect configuration and generated-link differences" },
  { id: "update", label: "Update preview", description: "Resolve a dry-run only; no lock, installation, or update" },
  { id: "sources", label: "Sources", description: "Show explicit or registered configuration layers" },
  { id: "help", label: "Help", description: "Keyboard controls and explicit write-command boundaries" },
  { id: "quit", label: "Quit", description: "Restore the terminal and leave Agentbrew" },
];

export interface TuiConfirmation {
  host?: { from: string; to: string };
  packages: Array<{ id: string; from: string; to: string }>;
  herdr: boolean;
}

export interface TuiModel {
  target: string;
  page: TuiPage;
  menuIndex: number;
  evaluation?: EnvironmentEvaluation;
  sources?: CommandResult;
  result?: CommandResult;
  busy: boolean;
  busySince?: number;
  exitRequested: boolean;
  scroll: number;
  notice?: string;
  returnPage?: TuiPage;
  cachedAt?: number;
  writeEnabled?: boolean;
  confirm?: TuiConfirmation;
  confirmIndex?: number;
}

export interface RenderedTuiFrame {
  lines: string[];
  scroll: number;
}

export function canApplyPreview(result?: CommandResult): boolean {
  if (!result || result.status !== "success") return false;
  const data = result.data as any;
  if (data?.nativeMode) return false;
  const resolution = data?.resolution;
  if (!resolution) return false;
  if (resolution.host?.action === "update") return true;
  return (resolution.resources ?? []).some((resource: any) => resource.action === "update");
}

function paintResultLine(line: string, style: TerminalStyle): string {
  const truncated = style.truncate(line);
  if (line.startsWith("PASS ") || line.startsWith("OK ")) return style.paint(truncated, "success");
  if (line.startsWith("WARN ")) return style.paint(truncated, "warning");
  if (line.startsWith("FAIL ") || line.startsWith("error:")) return style.paint(truncated, "error");
  if (line.startsWith("DIFF ") || line.startsWith("SKIP ") || line.startsWith("target:")) return style.paint(truncated, "muted");
  if (line.startsWith("PLAN ") || line.startsWith("RESOLVE ")) return style.paint(truncated, "accent");
  if (line.startsWith("result:")) {
    const tone = line.includes("success") ? "success" : line.includes("cancelled") || line.includes("not-executed") ? "warning" : "error";
    return style.paint(truncated, tone);
  }
  if (line.startsWith("preview:")) {
    const tone = line.includes("up to date") || line.includes("ready") ? "success" : "warning";
    return style.paint(truncated, tone);
  }
  return truncated;
}

function wrappedResult(result: CommandResult, style: TerminalStyle, summary = `result: ${result.status}; changes: ${result.changes}`): string[] {
  const details = renderResult(result, true)
    .split("\n")
    .filter((line) => !line.startsWith("result:") && !line.startsWith("target:"));
  return [summary, ...details].flatMap((line) => {
    const wrapped = style.wrap(line);
    return wrapped.map((part, index) => paintResultLine(index === 0 ? part : `  ${part}`, style));
  });
}

function previewSummary(result: CommandResult): string {
  const data = result.data as any;
  if (data?.nativeMode) return "preview: local checks only · upstream versions unknown · no writes";
  if (result.status !== "success") return `preview: ${result.status} · no writes`;
  const resolution = data?.resolution;
  const updates = (resolution?.host?.action === "update" ? 1 : 0)
    + (resolution?.resources ?? []).filter((resource: any) => resource.action === "update").length;
  return updates > 0
    ? `preview: ready · ${updates} update(s) · no writes`
    : "preview: up to date · no writes";
}

function nativeGuidance(style: TerminalStyle): string[] {
  return [
    style.paint("This target has no registered sources, so upstream versions cannot be resolved.", "warning"),
    "Register the layers this machine uses:",
    "  agentbrew source set --layer personal=/absolute/personal.json",
    "Or take ownership of existing resources first:",
    "  agentbrew init",
    "Native shortcut without version prediction: agentbrew update",
  ];
}

function overviewSummary(model: TuiModel, style: TerminalStyle): string[] {
  const evaluation = model.evaluation;
  if (!evaluation) return [style.paint(model.notice ?? "Assessing the local environment…", "muted")];
  const { assessment, checks, differences, herdr } = evaluation;
  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  const sourceData = model.sources?.data as any;
  const sourceText = model.sources?.status === "failed"
    ? "source error"
    : sourceData?.layerOrigin === "explicit"
      ? `explicit · ${sourceData.layers?.length ?? 0} layer(s)`
      : sourceData?.registered
        ? `registered · ${sourceData.state} · ${sourceData.layers?.length ?? 0} layer(s)`
        : "no registered layers";
  const classificationTone = assessment.classification === "healthy" ? "success"
    : assessment.classification === "repairable" ? "warning"
      : assessment.classification === "empty" ? "accent" : "error";
  const summary = [
    `${style.paint("Status      ", "muted")}${style.paint(assessment.classification, classificationTone)}`,
    `${style.paint("Pi          ", "muted")}${assessment.host ? `${assessment.host.version} · ${assessment.host.source}` : "no usable host"}`,
    `${style.paint("herdr       ", "muted")}${herdr.available ? `${herdr.version ?? "available"} · integration ${herdr.integration}` : "unavailable"}`,
    `${style.paint("Health      ", "muted")}${failures} failing · ${warnings} warning(s) · ${differences.length} difference(s)`,
    `${style.paint("Sources     ", "muted")}${sourceText}${model.sources?.error ? ` · ${model.sources.error}` : ""}`,
    `${style.paint("Safety      ", "muted")}${style.paint("Read-only · no state, lock, update, or selftest", "accent")}`,
  ];
  if (model.notice) summary.unshift(style.paint(model.notice, "warning"));
  return summary;
}

const HELP_LINES = [
  "Navigation",
  "  ↑/↓     Move in the menu or scroll a result page",
  "  1–6     Jump directly to a page",
  "  Enter   Open the selected page",
  "  r       Refresh the current page, or re-check updates on a preview",
  "  Esc     Return to Overview, or to the page Help was opened from",
  "  ?       Open this help without discarding the current page",
  "  q       Quit after any active read-only operation settles",
  "  Ctrl+C  Quit with the same terminal restoration",
  "",
  "Write operations remain explicit CLI commands:",
  "  agentbrew init",
  "  agentbrew update --dry-run",
  "  agentbrew update",
  "  agentbrew --write      # enable u apply in this workspace",
  "  agentbrew source set --layer personal=/absolute/path.json",
  "  agentbrew source list",
  "  agentbrew source clear",
  "",
  "Update preview may fetch release and npm metadata; it never writes.",
  "With --write, u asks for confirmation first: the update re-resolves,",
  "runs without cancellation, and reports when Pi must restart.",
  "If Sources reports an error, the binding is damaged: replace it with",
  "source set, or remove <stateDir>/sources.json by hand.",
  "",
  "Without --write this TUI never applies plans, installs packages, changes source bindings, runs selftest, or updates Agentbrew itself.",
];

function visibleRange(index: number, count: number, maximum: number): { start: number; end: number } {
  const start = Math.max(0, Math.min(index - Math.floor(maximum / 2), count - maximum));
  return { start, end: Math.min(count, start + maximum) };
}

function fitHints(hints: string[], width: number, droppable: string[]): string {
  let kept = [...hints];
  for (const label of droppable) {
    if (visibleWidth(kept.join(" · ")) <= width) break;
    kept = kept.filter((hint) => hint !== label);
  }
  return kept.join(" · ");
}

function footerText(model: TuiModel, style: TerminalStyle): string {
  if (model.busy) {
    const writing = model.page === "applied";
    if (model.exitRequested) return writing ? "Finishing the update before exit…" : "Finishing the read-only operation before exit…";
    const elapsed = model.busySince ? Math.max(0, Math.floor((Date.now() - model.busySince) / 1000)) : 0;
    return fitHints([`${writing ? "applying" : "read-only"} · ${elapsed}s`, "q exits when it settles"], style.width, ["q exits when it settles"]);
  }
  if (model.page === "confirm") {
    return fitHints(["↑/↓ select", "enter choose", "esc back", "? help", "q quit"], style.width, ["esc back", "? help"]);
  }
  const updateHints = model.writeEnabled && canApplyPreview(model.result)
    ? ["↑/↓ scroll", "1-6 pages", "u apply", "r re-check", "esc back", "? help", "q quit"]
    : ["↑/↓ scroll", "1-6 pages", "r re-check", "esc back", "? help", "q quit"];
  const hints = model.page === "overview"
    ? ["↑/↓ move", "1-6 pages", "enter open", "r refresh", "? help", "q quit"]
    : model.page === "update"
      ? updateHints
      : model.page === "applied"
        ? ["↑/↓ scroll", "1-6 pages", "r re-check", "esc back", "? help", "q quit"]
        : ["↑/↓ scroll", "1-6 pages", "r refresh", "esc back", "? help", "q quit"];
  const droppable = model.page === "overview"
    ? ["r refresh", "enter open", "1-6 pages"]
    : model.page === "update"
      ? ["r re-check", "esc back", "1-6 pages"]
      : model.page === "applied"
        ? ["r re-check", "esc back", "1-6 pages"]
        : ["r refresh", "esc back", "1-6 pages"];
  return fitHints(hints, style.width, droppable);
}

export function renderTuiFrame(model: TuiModel, style: TerminalStyle, height: number): RenderedTuiFrame {
  const item = TUI_MENU_ITEMS[model.menuIndex] ?? TUI_MENU_ITEMS[0]!;
  const pageTitle = model.page === "confirm"
    ? "Apply update?"
    : model.page === "applied"
      ? "Update result"
      : TUI_MENU_ITEMS.find((entry) => entry.id === model.page)?.label;
  const title = model.page === "overview" ? "Agentbrew" : `Agentbrew · ${pageTitle ?? model.page}`;
  const modeTag = model.writeEnabled ? style.paint("WRITE ENABLED", "warning") : style.paint("READ ONLY", "accent");
  const header = [
    `${style.title(title)}  ${modeTag}`,
    style.paint(style.truncateMiddle(`Target  ${model.target}`, style.width), "muted"),
    style.rule(),
  ];
  const footerTextValue = footerText(model, style);
  const footer = [style.rule(), style.paint(footerTextValue, "muted")];
  const bodyHeight = Math.max(0, height - header.length - footer.length);
  let body: string[] = [];
  let scroll = 0;

  if (model.page === "overview") {
    const summary = overviewSummary(model, style);
    const summaryCount = bodyHeight <= 1 ? 0 : Math.min(summary.length, Math.max(1, Math.floor(bodyHeight / 2)));
    body.push(...summary.slice(0, summaryCount));
    const menuSpace = bodyHeight - summaryCount;
    const windowed = menuSpace < TUI_MENU_ITEMS.length;
    const visibleCount = Math.max(1, Math.min(TUI_MENU_ITEMS.length, menuSpace - (windowed ? 1 : 0)));
    const { start, end } = visibleRange(model.menuIndex, TUI_MENU_ITEMS.length, visibleCount);
    for (let index = start; index < end; index++) {
      const entry = TUI_MENU_ITEMS[index]!;
      const label = `${index === model.menuIndex ? "›" : " "} ${entry.label}`;
      body.push(index === model.menuIndex ? style.title(label) : label);
    }
    if (body.length < bodyHeight && windowed && end > start) {
      body.push(style.paint(`  ${start + 1}–${end}/${TUI_MENU_ITEMS.length} pages`, "muted"));
    }
    if (body.length < bodyHeight && item.description) body.push(style.paint(`  ${item.description}`, "muted"));
  } else if (model.page === "confirm") {
    const confirm = model.confirm;
    const index = model.confirmIndex ?? 1;
    if (!confirm) {
      body = [style.paint("nothing to apply", "muted")];
    } else {
      body = [
        style.paint(`This writes to ${model.target} and cannot be rolled back automatically.`, "warning"),
        "The update re-resolves metadata before changing anything.",
        "",
        ...(confirm.host ? [`  Host       ${confirm.host.from} → ${confirm.host.to}`] : []),
        ...confirm.packages.map((pkg) => `  npm        ${pkg.id.slice(4)} ${pkg.from} → ${pkg.to}`),
        ...(confirm.herdr ? ["  herdr      rebuild the Pi integration"] : []),
        "  selftest   not run (opt-in)",
        "",
        `${index === 0 ? "›" : " "} Update now`,
        `${index === 1 ? "›" : " "} Cancel`,
      ];
    }
  } else if (model.page === "help") {
    body = HELP_LINES.flatMap((line) => style.wrap(line));
  } else if (model.busy || !model.result) {
    body = [style.paint(model.notice ?? "Loading read-only result…", "muted")];
  } else {
    const preview = model.page === "update";
    body = wrappedResult(model.result, style, preview ? previewSummary(model.result) : undefined);
    if (preview && (model.result.data as any)?.nativeMode) {
      body = [...nativeGuidance(style), "", ...body];
    }
    if (model.page === "applied"
      && model.result.steps.some((step) => step.status === "success" && ["pi-host", "pi-update", "npm-install"].includes(step.id))) {
      body = [style.paint("Restart Pi to load the updated host and extensions.", "warning"), "", ...body];
    }
    if (model.cachedAt) {
      const age = Math.max(0, Math.floor((Date.now() - model.cachedAt) / 1000));
      body = [style.paint(`cached ${age}s ago · ${preview ? "r re-checks" : "r refreshes"}`, "muted"), ...body];
    }
    if (!model.busy && model.notice) body = [style.paint(model.notice, "warning"), ...body];
  }

  if (model.page !== "overview") {
    const maxScroll = Math.max(0, body.length - bodyHeight);
    scroll = Math.max(0, Math.min(model.scroll, maxScroll));
    const visible = body.slice(scroll, scroll + bodyHeight);
    if (maxScroll > 0 && visible.length > 0) {
      visible[visible.length - 1] = style.paint(`… ${scroll + 1}-${Math.min(body.length, scroll + bodyHeight)}/${body.length} lines · ↑/↓ scroll …`, "muted");
    }
    body = visible;
  }
  // Pad to the reserved frame height so the footer sits on the same row on every
  // page instead of jumping when the body length changes.
  if (body.length < bodyHeight) body = [...body, ...Array.from({ length: bodyHeight - body.length }, () => "")];

  return {
    lines: [...header, ...body.slice(0, bodyHeight), ...footer].map((line) => style.truncate(line)),
    scroll,
  };
}
