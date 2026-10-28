import readline from "node:readline";
import type { TerminalOutput, TerminalStyle } from "./terminal.js";

export interface TerminalInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

export interface TerminalMenuIO {
  input: TerminalInput;
  output: TerminalOutput;
  env?: NodeJS.ProcessEnv;
}

export interface TerminalMenuItem {
  value: string;
  label: string;
  description?: string;
  detail?: string;
  required?: boolean;
}

export interface TerminalMenuOptions {
  title: string;
  items: TerminalMenuItem[];
  multiple?: boolean;
  initial?: string[];
  maxVisible?: number;
}

export function canUseTerminalMenu(io: TerminalMenuIO): boolean {
  return io.input.isTTY === true
    && io.output.isTTY === true
    && typeof io.input.setRawMode === "function"
    && io.env?.TERM !== "dumb"
    && (io.output.columns || 80) >= 32;
}

function visibleRange(index: number, count: number, maximum: number): { start: number; end: number } {
  const start = Math.max(0, Math.min(index - Math.floor(maximum / 2), count - maximum));
  return { start, end: Math.min(count, start + maximum) };
}

export function renderMenuFrame(
  options: TerminalMenuOptions,
  index: number,
  selected: Set<string>,
  style: TerminalStyle,
): string[] {
  const multiple = options.multiple === true;
  const maximum = Math.max(1, Math.min(options.maxVisible ?? 5, options.items.length));
  const { start, end } = visibleRange(index, options.items.length, maximum);
  const lines = [style.bold(options.title)];
  for (let itemIndex = start; itemIndex < end; itemIndex++) {
    const item = options.items[itemIndex]!;
    const current = itemIndex === index;
    const cursor = current ? "› " : "  ";
    const checkbox = multiple ? `${selected.has(item.value) ? "[x]" : "[ ]"} ` : "";
    const required = item.required ? style.paint(" · required", "muted") : "";
    const label = `${cursor}${checkbox}${item.label}`;
    const available = Math.max(1, style.width - (required ? 11 : 0));
    const rendered = current ? style.title(style.truncate(label, available)) : style.truncate(label, available);
    lines.push(`${rendered}${required}`);
  }
  if (start > 0 || end < options.items.length) {
    lines.push(style.paint(`  ${index + 1}/${options.items.length} · centered selection`, "muted"));
  }
  const current = options.items[index];
  if (current?.description) lines.push(...style.wrap(current.description, "  "));
  if (current?.detail) lines.push(...style.wrap(current.detail, "  "));
  lines.push(style.paint(
    multiple
      ? "↑/↓ move · space toggle · a all · n none · enter continue · q cancel"
      : "↑/↓ move · enter select · q/esc cancel",
    "muted",
  ));
  return lines.map((line) => style.truncate(line));
}

export function showTerminalMenu(
  io: TerminalMenuIO,
  options: TerminalMenuOptions,
  style: TerminalStyle,
): Promise<string[] | null> {
  return new Promise((resolve, reject) => {
    if (options.items.length === 0) {
      resolve([]);
      return;
    }
    const multiple = options.multiple === true;
    const initialIndex = multiple ? 0 : Math.max(0, options.items.findIndex((item) => item.value === options.initial?.[0]));
    let index = initialIndex;
    const selected = new Set(options.initial ?? []);
    if (multiple) {
      for (const item of options.items) if (item.required) selected.add(item.value);
    }
    let previousLines = 0;
    let settled = false;
    const wasRaw = io.input.isRaw === true;
    readline.emitKeypressEvents(io.input);

    const clearFrame = () => {
      if (previousLines > 0) io.output.write(`\x1b[${previousLines}F\x1b[0J`);
    };
    const cleanup = () => {
      io.input.off("keypress", onKeypress);
      if (typeof io.input.setRawMode === "function") io.input.setRawMode(wasRaw);
      io.input.pause();
      io.output.write("\x1b[?25h");
    };
    const finish = (value: string[] | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      try {
        clearFrame();
        io.output.write("\x1b[?25h");
        if (error) {
          cleanup();
          reject(error);
          return;
        }
        const current = options.items[index];
        const summary = value === null
          ? style.paint(`${options.title}: cancelled`, "muted")
          : multiple
            ? `${options.title}: ${style.paint(`${value.length} selected`, "accent")}`
            : `${options.title}: ${style.paint(current?.label ?? value[0] ?? "", "accent")}`;
        io.output.write(`${style.truncate(summary)}\n`);
        cleanup();
        resolve(value);
      } catch (caught) {
        cleanup();
        reject(caught);
      }
    };
    const draw = () => {
      try {
        const lines = renderMenuFrame(options, index, selected, style);
        clearFrame();
        io.output.write(`${lines.join("\n")}\n`);
        previousLines = lines.length;
      } catch (error) {
        finish(null, error);
      }
    };
    const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean }) => {
      if (settled || !key) return;
      if ((key.ctrl && key.name === "c") || key.name === "escape" || key.name === "q") {
        finish(null);
        return;
      }
      if (key.name === "up") {
        index = (index + options.items.length - 1) % options.items.length;
      } else if (key.name === "down") {
        index = (index + 1) % options.items.length;
      } else if (multiple && key.name === "space") {
        const item = options.items[index]!;
        if (!item.required) {
          if (selected.has(item.value)) selected.delete(item.value);
          else selected.add(item.value);
        }
      } else if (multiple && key.name === "a") {
        for (const item of options.items) selected.add(item.value);
      } else if (multiple && key.name === "n") {
        selected.clear();
        for (const item of options.items) if (item.required) selected.add(item.value);
      } else if (key.name === "return" || key.name === "enter") {
        if (multiple) finish(options.items.filter((item) => selected.has(item.value)).map((item) => item.value));
        else finish([options.items[index]!.value]);
        return;
      } else {
        return;
      }
      draw();
    };

    try {
      io.output.write("\x1b[?25l");
      io.input.setRawMode!(true);
      io.input.on("keypress", onKeypress);
      io.input.resume();
      draw();
    } catch (error) {
      finish(null, error);
    }
  });
}
