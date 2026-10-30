import type { EnvironmentEvaluation } from "./init.js";
import { renderResult } from "./result-view.js";
import type { TargetInventory, TargetSummary } from "./targets.js";
import { visibleWidth, type TerminalStyle } from "./terminal.js";
import type { CommandResult } from "./types.js";
import { AGENTBREW_VERSION } from "./version.js";

export type TuiPage = "overview" | "targets" | "health" | "changes" | "update" | "sources" | "help" | "confirm" | "applied";

export interface TuiMenuItem {
  id: TuiPage | "quit";
  label: string;
  description: string;
}

export const TUI_MENU_ITEMS: TuiMenuItem[] = [
  { id: "overview", label: "Overview", description: "Local environment, health summary, and active sources" },
  { id: "targets", label: "Targets", description: "List local and SSH targets; check only the selected target" },
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
  targets?: TargetInventory;
  targetIndex?: number;
  result?: CommandResult;
  busy: boolean;
  busySince?: number;
  exitRequested: boolean;
  scroll: number;
  notice?: string;
  returnPage?: TuiPage;
  cachedAt?: number;
  writeEnabled?: boolean;
  showDetails?: boolean;
  pageSize?: number;
  confirm?: TuiConfirmation;
  confirmIndex?: number;
}

export interface RenderedTuiFrame {
  lines: string[];
  scroll: number;
  pageSize: number;
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

export function canToggleDetails(result?: CommandResult): boolean {
  if (!result) return false;
  if (result.checks.some((check) => check.status === "pass")) return true;
  const data = result.data as any;
  const resolution = result.command === "resolve" ? data : data?.resolution;
  return (resolution?.resources ?? []).some((resource: any) => resource.integrity || resource.peerEvidence?.length > 0);
}

function paintResultLine(line: string, style: TerminalStyle): string {
  const truncated = style.truncate(line);
  if (line.startsWith("PASS ") || line.startsWith("OK ")) return style.paint(truncated, "success");
  if (line.startsWith("WARN ")) return style.paint(truncated, "warning");
  if (line.startsWith("FAIL ") || line.startsWith("error:")) return style.paint(truncated, "error");
  if (line.startsWith("DIFF ") || line.startsWith("SKIP ") || line.startsWith("target:")) return style.paint(truncated, "muted");
  if (line.startsWith("PLAN ") || line.startsWith("RESOLVE ") || line.startsWith("differences:") || line.startsWith("sources:")) {
    return style.paint(truncated, "accent");
  }
  if (line.startsWith("result:") || line.startsWith("update result:") || line.startsWith("health:")) {
    const tone = line.includes("success") ? "success" : line.includes("cancelled") || line.includes("not-executed") ? "warning" : "error";
    return style.paint(truncated, tone);
  }
  if (line.startsWith("preview:")) {
    const tone = line.includes("up to date") || line.includes("ready") ? "success" : "warning";
    return style.paint(truncated, tone);
  }
  return truncated;
}

function wrappedResult(
  result: CommandResult,
  style: TerminalStyle,
  summary: string,
  detailed: boolean,
): { summary: string[]; details: string[] } {
  const details = renderResult(result, detailed)
    .split("\n")
    .filter((line) => !line.startsWith("result:") && !line.startsWith("target:"))
    .filter((line) => detailed || !line.startsWith("PASS "));
  const wrap = (lines: string[]): string[] => lines.flatMap((line) => {
    const wrapped = style.wrap(line);
    return wrapped.map((part, index) => paintResultLine(index === 0 ? part : `  ${part}`, style));
  });
  return { summary: wrap([summary]), details: wrap(details) };
}

function resultSummary(page: TuiPage, result: CommandResult): string {
  if (page === "update") return previewSummary(result);
  if (page === "health") {
    const failed = result.checks.filter((check) => check.status === "fail").length;
    const warnings = result.checks.filter((check) => check.status === "warn").length;
    const passed = result.checks.filter((check) => check.status === "pass").length;
    return `health: ${result.status} · ${failed} failed · ${warnings} warning(s) · ${passed} passed`;
  }
  if (page === "changes") {
    return result.status === "success"
      ? `differences: ${result.differences.length} found`
      : `differences: ${result.status} · ${result.differences.length} reported`;
  }
  if (page === "sources") {
    if (result.status !== "success") return `sources: ${result.status} · no writes`;
    const data = result.data as any;
    const layers = data?.registration?.layers ?? data?.layers ?? [];
    const origin = data?.layerOrigin === "explicit" ? "explicit" : data?.registered ? "registered" : "none";
    const state = data?.registered && data.state ? ` · ${data.state}` : "";
    const git = layers.filter((layer: any) => layer.git).length;
    return `sources: ${origin}${state} · ${layers.length} layer(s)${git ? ` · ${git} Git` : ""}`;
  }
  if (page === "applied") return `update result: ${result.status} · changes: ${result.changes}`;
  return `result: ${result.status}; changes: ${result.changes}`;
}

function previewSummary(result: CommandResult): string {
  const data = result.data as any;
  const unmanaged = Array.isArray(data?.unmanagedResources) ? data.unmanagedResources : [];
  if (result.status === "not-executed" && unmanaged.length > 0) {
    return `preview: blocked · ${unmanaged.length} resource(s) not managed · no writes`;
  }
  if (data?.nativeMode) return "preview: local checks only · upstream versions unknown · no writes";
  if (result.status !== "success") return `preview: ${result.status} · no writes`;
  const resolution = data?.resolution;
  const updates = (resolution?.host?.action === "update" ? 1 : 0)
    + (resolution?.resources ?? []).filter((resource: any) => resource.action === "update").length;
  if (updates > 0) return `preview: ready · ${updates} update(s) · no writes`;
  if (data?.npmRequired) return "preview: no version updates · repairs planned · no writes";
  return "preview: up to date · no writes";
}

function nativeGuidance(style: TerminalStyle, data: any): string[] {
  const lines = ["Native preview: versions are not resolved without registered sources."];
  if (data?.host) lines.push(`  host ${data.host.version} (${data.host.source}) · target version not predicted`);
  lines.push(
    "Register layers for a version-resolved plan:",
    "  agentbrew source set --layer personal=/absolute/personal.json",
    "Or draft a personal layer from the installed resources:",
    "  agentbrew adopt --output personal.proposed.json",
    "Native update: agentbrew update",
  );
  return lines.flatMap((line, index) => style.wrap(line).map((part) => index === 0 ? style.paint(part, "warning") : part));
}

function ownershipBlock(style: TerminalStyle, result: CommandResult, unmanaged: string[]): string[] {
  const listed = unmanaged.length <= 4 ? unmanaged.join(", ") : `${unmanaged.slice(0, 4).join(", ")} (+${unmanaged.length - 4} more)`;
  return [
    style.paint(previewSummary(result), "warning"),
    "Agentbrew does not update resources it does not manage.",
    "",
    "Authorize them once, then re-check:",
    "  agentbrew init        (choose Manage, then select all)",
    "",
    `unmanaged: ${listed}`,
  ];
}

function sourcesGuidance(style: TerminalStyle, data: any): string[] {
  const wrap = (lines: string[], tone: "muted" | "warning"): string[] => lines.flatMap(
    (line, index) => style.wrap(line).map((part) => index === 0 ? style.paint(part, tone) : part),
  );
  const layers = data?.registration?.layers ?? data?.layers ?? [];
  const git = layers.filter((layer: any) => layer.git).length;
  const gitGuidance = git > 0 ? [
    `${git} Git layer(s) use recorded commits; r only re-reads local state.`,
    "Advance Git sources explicitly (writes source state, not managed resources):",
    "  agentbrew source refresh",
  ] : [];
  if (data && data.registered !== false) return wrap(gitGuidance, "muted");
  const guidance = data?.layerOrigin === "explicit" ? [
    "These layers are active for this run only.",
    "Persist them for everyday commands:",
    "  agentbrew source set --layer …",
  ] : [
    "No per-target source binding is registered.",
    "Register the layers this machine uses:",
    "  agentbrew source set --layer personal=/absolute/personal.json",
    "Or draft a personal layer from the installed resources:",
    "  agentbrew adopt --output personal.proposed.json",
  ];
  return [...wrap(guidance, "warning"), ...wrap(gitGuidance, "muted")];
}

function targetInventorySummary(inventory?: TargetInventory): string {
  if (!inventory) return "not loaded";
  if (inventory.error) return "registry error";
  const targets = inventory.targets;
  const count = (state: TargetSummary["state"]): number => targets.filter((target) => target.state === state).length;
  const healthy = count("healthy");
  const attention = count("attention");
  const unknown = count("unknown");
  const issues = count("offline") + count("unavailable") + count("error");
  const checking = count("checking");
  return [
    `${targets.length} configured`,
    ...(healthy ? [`${healthy} healthy`] : []),
    ...(attention ? [`${attention} attention`] : []),
    ...(unknown ? [`${unknown} unknown`] : []),
    ...(checking ? [`${checking} checking`] : []),
    ...(issues ? [`${issues} issue(s)`] : []),
  ].join(" · ");
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
    `${style.paint("Targets     ", "muted")}${targetInventorySummary(model.targets)}${model.targets?.error ? ` · ${model.targets.error}` : ""}`,
    `${style.paint("Sources     ", "muted")}${sourceText}${model.sources?.error ? ` · ${model.sources.error}` : ""}`,
    `${style.paint("Safety      ", "muted")}${model.writeEnabled
      ? style.paint("Writes only after confirmation · no selftest", "warning")
      : style.paint("Read-only · no state, lock, update, or selftest", "accent")}`,
  ];
  if (model.notice) summary.unshift(style.paint(model.notice, "warning"));
  return summary;
}

function targetEvidence(target: TargetSummary): string {
  if (target.state === "unknown") return "not checked";
  if (target.state === "checking") return "read-only check in progress…";
  if (["offline", "unavailable", "error"].includes(target.state)) return target.errorKind ?? "check failed";
  return [
    `Pi ${target.pi ?? "unknown"}`,
    `herdr ${target.herdr ?? "unknown"}`,
    `${target.failures ?? 0} failed`,
    `${target.warnings ?? 0} warning(s)`,
    `${target.differences ?? 0} difference(s)`,
  ].join(" · ");
}

function targetsBody(model: TuiModel, style: TerminalStyle): string[] {
  const inventory = model.targets;
  const body = [
    style.paint(targetInventorySummary(inventory), "accent"),
    style.paint("Checks only · no remote updates · results last for this session", "muted"),
  ];
  if (model.notice) body.push(style.paint(model.notice, "warning"));
  if (inventory?.error) body.push(...style.wrap(`Registry error: ${inventory.error}`));
  body.push("");
  const selected = model.targetIndex ?? 0;
  for (const [index, target] of (inventory?.targets ?? []).entries()) {
    const current = index === selected;
    const label = `${current ? "›" : " "} ${style.padEnd(style.truncate(target.id, 16), 16)} ${target.connection.type} · ${target.state}`;
    body.push(current ? style.title(label) : label);
    const tone = target.state === "healthy" ? "success" : ["offline", "unavailable", "error"].includes(target.state) ? "error" : "muted";
    body.push(style.paint(`  ${targetEvidence(target)}${target.checkedAt ? ` · ${target.checkedAt.slice(11, 19)}` : ""}`, tone));
    if (current && model.showDetails) {
      const connection = target.connection.type === "ssh" ? target.connection.destination : "this machine";
      body.push(...style.wrap(`  connection: ${connection}`));
      if (target.classification) body.push(`  classification: ${target.classification} · integration: ${target.integration ?? "unknown"}`);
      if (target.checkedAt) body.push(`  checkedAt: ${target.checkedAt}`);
    }
  }
  return body;
}

const HELP_LINES = [
  "Navigation",
  "  ↑/↓         Move in the menu, scroll a result, or select a confirmation action",
  "  PgUp/PgDn   Scroll one viewport in a result or confirmation list",
  "  Home/End    Jump to the first/last menu item or result position",
  "  1–6         Jump to existing pages (Targets does not replace these shortcuts)",
  "  t           Open Targets and list configured local/SSH targets",
  "  Enter       Open the selected page or confirmation action",
  "  r           Refresh the local page, re-read Sources, or re-check a preview",
  "  r (Targets) Check only the selected target; never update it",
  "  v           Toggle passing checks and detailed resolution evidence",
  "  u           Apply the preview (only with --write, after confirmation)",
  "  Esc         Return to Overview, or to the page Help was opened from",
  "  ?           Open this help without discarding the current page",
  "  q           Quit after any active operation settles",
  "  Ctrl+C      Quit with the same terminal restoration",
  "",
  "Write operations remain explicit CLI commands:",
  "  agentbrew init",
  "  agentbrew update --dry-run",
  "  agentbrew update",
  "  agentbrew --write      # enable u apply in this workspace",
  "  agentbrew source set --layer personal=/absolute/path.json",
  "  agentbrew adopt --output personal.proposed.json",
  "  agentbrew source refresh  # advance Git commits; writes source state only",
  "  agentbrew release create --layer team=… --output …",
  "  agentbrew source clear",
  "",
  "Update preview may fetch release and npm metadata; it never writes.",
  "Sources r only re-reads registered commits; it does not fetch Git updates.",
  "Targets starts without SSH connections; r checks one selected target with",
  "agentbrew init --json on that target. Results are session-only and never",
  "authorize or execute a remote update, including with --write.",
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
    if (writing) return fitHints([`applying · ${elapsed}s`, "esc disabled", "q waits"], style.width, ["q waits"]);
    return fitHints([`read-only · ${elapsed}s`, "q exits when it settles"], style.width, ["q exits when it settles"]);
  }
  if (model.page === "confirm") {
    return fitHints(
      ["↑/↓ select", "PgUp/PgDn list", "enter choose", "esc back", "? help", "q quit"],
      style.width,
      ["PgUp/PgDn list", "esc back", "? help"],
    );
  }
  if (model.page === "targets") {
    return fitHints(
      ["↑/↓ select", "r check", model.showDetails ? "v summary" : "v details", "esc back", "? help", "q quit"],
      style.width,
      ["esc back", "? help"],
    );
  }
  const detailHint = model.showDetails ? "v summary" : "v details";
  const scrollHints = [
    "↑/↓ scroll",
    "PgUp/PgDn",
    ...(canToggleDetails(model.result) ? [detailHint] : []),
    "1-6 pages",
  ];
  const updateHints = model.writeEnabled && canApplyPreview(model.result)
    ? [...scrollHints, "u apply", "r re-check", "esc back", "? help", "q quit"]
    : [...scrollHints, "r re-check", "esc back", "? help", "q quit"];
  const refreshHint = model.page === "sources" ? "r re-read" : "r refresh";
  const hints = model.page === "overview"
    ? ["↑/↓ move", "1-6 pages", "enter open", "r refresh", "? help", "q quit"]
    : model.page === "help"
      ? ["↑/↓ scroll", "PgUp/PgDn", "1-6 pages", "esc back", "? help", "q quit"]
      : model.page === "update"
        ? updateHints
        : model.page === "applied"
          ? [...scrollHints, "r re-check", "esc back", "? help", "q quit"]
          : [...scrollHints, refreshHint, "esc back", "? help", "q quit"];
  const droppable = model.page === "overview"
    ? ["r refresh", "enter open", "1-6 pages"]
    : model.page === "update" || model.page === "applied"
      ? ["PgUp/PgDn", "r re-check", "esc back", "1-6 pages"]
      : model.page === "sources"
        ? ["PgUp/PgDn", "esc back", "1-6 pages", refreshHint]
        : ["PgUp/PgDn", refreshHint, "esc back", "1-6 pages"];
  return fitHints(hints, style.width, droppable);
}

function scrollableBody(
  body: string[],
  available: number,
  requested: number,
  style: TerminalStyle,
  confirmation = false,
): { lines: string[]; scroll: number; pageSize: number } {
  if (available <= 0) return { lines: [], scroll: 0, pageSize: 0 };
  const reserve = available > 1 && body.length > available ? 1 : 0;
  const pageSize = Math.max(1, available - reserve);
  const maxScroll = Math.max(0, body.length - pageSize);
  const scroll = Math.max(0, Math.min(requested, maxScroll));
  const lines = body.slice(scroll, scroll + pageSize);
  if (reserve) {
    const hint = confirmation ? "PgUp/PgDn scroll" : "↑/↓ scroll";
    lines.push(style.paint(`… ${scroll + 1}-${Math.min(body.length, scroll + pageSize)}/${body.length} lines · ${hint} …`, "muted"));
  }
  return { lines, scroll, pageSize };
}

export function renderTuiFrame(model: TuiModel, style: TerminalStyle, height: number): RenderedTuiFrame {
  const item = TUI_MENU_ITEMS[model.menuIndex] ?? TUI_MENU_ITEMS[0]!;
  const pageTitle = model.page === "confirm"
    ? "Apply update?"
    : model.page === "applied"
      ? "Update result"
      : TUI_MENU_ITEMS.find((entry) => entry.id === model.page)?.label;
  const title = model.page === "overview" ? `Agentbrew v${AGENTBREW_VERSION}` : `Agentbrew · ${pageTitle ?? model.page}`;
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
  let actions: string[] = [];
  let scroll = 0;
  let pageSize = bodyHeight;

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
    if (body.length < bodyHeight && item.description) {
      const description = item.id === "update" && model.writeEnabled
        ? "Resolve a dry-run; apply only after confirmation"
        : item.description;
      body.push(style.paint(`  ${description}`, "muted"));
    }
  } else if (model.page === "targets") {
    body = targetsBody(model, style);
  } else if (model.page === "confirm") {
    const confirm = model.confirm;
    const index = model.confirmIndex ?? 1;
    if (!confirm) {
      body = [style.paint("nothing to apply", "muted")];
    } else {
      const details = [
        `This writes to ${model.target} and cannot be rolled back automatically.`,
        "The update re-resolves metadata before changing anything.",
        "",
        ...(confirm.host ? [`  Host       ${confirm.host.from} → ${confirm.host.to}`] : []),
        ...confirm.packages.map((pkg) => `  npm        ${pkg.id.slice(4)} ${pkg.from} → ${pkg.to}`),
        ...(confirm.herdr ? ["  herdr      rebuild the Pi integration"] : []),
        "  selftest   not run (opt-in)",
      ];
      body = details.flatMap((line, index) => style.wrap(line, line.startsWith("  ") ? "  " : "")
        .map((part) => index === 0 ? style.paint(part, "warning") : part));
      actions = [
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
    const data = model.result.data as any;
    const unmanaged = Array.isArray(data?.unmanagedResources) ? data.unmanagedResources : [];
    if (preview && model.result.status === "not-executed" && unmanaged.length > 0) {
      body = ownershipBlock(style, model.result, unmanaged);
    } else {
      const rendered = wrappedResult(model.result, style, resultSummary(model.page, model.result), model.showDetails === true);
      const extras: string[] = [];
      if (preview && data?.nativeMode) extras.push("", ...nativeGuidance(style, data));
      if (model.page === "sources") {
        const guidance = sourcesGuidance(style, data);
        if (guidance.length > 0) extras.push("", ...guidance);
      }
      if (model.page === "applied"
        && model.result.steps.some((step) => step.status === "success" && ["pi-host", "pi-update", "npm-install"].includes(step.id))) {
        extras.push("", style.paint("Restart Pi to load the updated host and extensions.", "warning"));
      }
      body = [...rendered.summary, ...extras, ...rendered.details];
    }
    if (model.cachedAt) {
      const age = Math.max(0, Math.floor((Date.now() - model.cachedAt) / 1000));
      body = [style.paint(`cached ${age}s ago · ${preview ? "r re-checks" : "r refreshes"}`, "muted"), ...body];
    }
    if (!model.busy && model.notice) body = [style.paint(model.notice, "warning"), ...body];
  }

  if (model.page !== "overview") {
    const actionHeight = Math.min(actions.length, bodyHeight);
    const rendered = scrollableBody(body, bodyHeight - actionHeight, model.scroll, style, model.page === "confirm");
    body = [...rendered.lines, ...actions.slice(actions.length - actionHeight)];
    scroll = rendered.scroll;
    pageSize = rendered.pageSize;
  }
  // Pad to the reserved frame height so the footer sits on the same row on every
  // page instead of jumping when the body length changes.
  if (body.length < bodyHeight) body = [...body, ...Array.from({ length: bodyHeight - body.length }, () => "")];

  return {
    lines: [...header, ...body.slice(0, bodyHeight), ...footer].map((line) => style.truncate(line)),
    scroll,
    pageSize,
  };
}
