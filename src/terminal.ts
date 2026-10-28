import { stripVTControlCharacters } from "node:util";

export interface TerminalOutput extends NodeJS.WritableStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

export type Tone = "accent" | "muted" | "success" | "warning" | "error";

export interface TerminalStyle {
  enabled: boolean;
  width: number;
  paint: (text: string, tone: Tone) => string;
  bold: (text: string) => string;
  title: (text: string) => string;
  rule: () => string;
  truncate: (text: string, width?: number) => string;
  truncateMiddle: (text: string, width?: number) => string;
  wrap: (text: string, indent?: string, width?: number) => string[];
  padEnd: (text: string, width: number) => string;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function clusters(text: string): string[] {
  return [...segmenter.segment(text)].map((entry) => entry.segment);
}

function codePointWidth(codePoint: number): number {
  if (
    codePoint >= 0x1100 && codePoint <= 0x115f
    || codePoint >= 0x2329 && codePoint <= 0x232a
    || codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f
    || codePoint >= 0xac00 && codePoint <= 0xd7a3
    || codePoint >= 0xf900 && codePoint <= 0xfaff
    || codePoint >= 0xfe10 && codePoint <= 0xfe19
    || codePoint >= 0xfe30 && codePoint <= 0xfe6f
    || codePoint >= 0xff00 && codePoint <= 0xff60
    || codePoint >= 0xffe0 && codePoint <= 0xffe6
    || codePoint >= 0x1f300 && codePoint <= 0x1f64f
    || codePoint >= 0x1f900 && codePoint <= 0x1f9ff
    || codePoint >= 0x20000 && codePoint <= 0x3fffd
  ) return 2;
  return 1;
}

function clusterWidth(cluster: string): number {
  if (/^\p{Control}+$/u.test(cluster)) return 0;
  if (/\p{Emoji_Presentation}|\u200d|\ufe0f|\p{Regional_Indicator}/u.test(cluster)) return 2;
  let width = 0;
  for (const character of cluster) {
    if (/\p{Mark}|\u200b/u.test(character)) continue;
    width += codePointWidth(character.codePointAt(0)!);
  }
  return width;
}

export function visibleWidth(text: string): number {
  return clusters(stripVTControlCharacters(text)).reduce((width, cluster) => width + clusterWidth(cluster), 0);
}

function takeWidth(text: string, width: number): string {
  if (width <= 0) return "";
  let result = "";
  let used = 0;
  for (const cluster of clusters(text)) {
    const next = clusterWidth(cluster);
    if (used + next > width) break;
    result += cluster;
    used += next;
  }
  return result;
}

function splitWidth(text: string, width: number): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (visibleWidth(remaining) > width) {
    const part = takeWidth(remaining, width);
    if (!part) break;
    parts.push(part);
    remaining = remaining.slice(part.length);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export function truncateText(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  if (width === 1) return "…";
  return `${takeWidth(text, width - 1)}…`;
}

export function truncateMiddleText(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  if (width <= 2) return truncateText(text, width);
  const leftWidth = Math.ceil((width - 1) / 2);
  const rightWidth = width - 1 - leftWidth;
  const reversed = clusters(text).reverse();
  let right = "";
  let used = 0;
  for (const cluster of reversed) {
    const next = clusterWidth(cluster);
    if (used + next > rightWidth) break;
    right = cluster + right;
    used += next;
  }
  return `${takeWidth(text, leftWidth)}…${right}`;
}

export function wrapText(text: string, width: number, indent = ""): string[] {
  const available = Math.max(1, width - visibleWidth(indent));
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [indent];
  const lines: string[] = [];
  let current = "";
  for (const word of normalized.split(" ")) {
    const candidate = current ? `${current} ${word}` : word;
    if (visibleWidth(candidate) <= available) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    const pieces = splitWidth(word, available);
    lines.push(...pieces.slice(0, -1));
    current = pieces.at(-1) ?? "";
  }
  if (current) lines.push(current);
  return lines.map((line) => `${indent}${line}`);
}

export function createTerminalStyle(
  stream: TerminalOutput,
  env: NodeJS.ProcessEnv = process.env,
  interactive = stream.isTTY === true,
): TerminalStyle {
  const enabled = interactive && stream.isTTY === true && env.NO_COLOR === undefined && env.TERM !== "dumb";
  const width = Math.max(20, Math.min(stream.columns || 80, 110));
  const codes: Record<Tone, number> = { accent: 36, muted: 90, success: 32, warning: 33, error: 31 };
  const paint = (text: string, tone: Tone) => enabled ? `\x1b[${codes[tone]}m${text}\x1b[0m` : text;
  return {
    enabled,
    width,
    paint,
    bold: (text) => enabled ? `\x1b[1m${text}\x1b[0m` : text,
    title: (text) => enabled ? `\x1b[1;36m${text}\x1b[0m` : text,
    rule: () => paint("─".repeat(width), "muted"),
    truncate: (text, maximum = width) => truncateText(text, maximum),
    truncateMiddle: (text, maximum = width) => truncateMiddleText(text, maximum),
    wrap: (text, indent = "", maximum = width) => wrapText(text, maximum, indent),
    padEnd: (text, maximum) => `${text}${" ".repeat(Math.max(0, maximum - visibleWidth(text)))}`,
  };
}
