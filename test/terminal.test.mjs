import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createTerminalStyle, truncateMiddleText, visibleWidth, wrapText } from "../dist/terminal.js";
import { renderMenuFrame, showTerminalMenu } from "../dist/terminal-menu.js";

function output(columns = 60) {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = columns;
  return stream;
}

function rawInput() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.isRaw = false;
  stream.rawModes = [];
  stream.setRawMode = (mode) => {
    stream.rawModes.push(mode);
    stream.isRaw = mode;
  };
  return stream;
}

test("terminal width handles ANSI, CJK, wrapping, and middle truncation", () => {
  const style = createTerminalStyle(output(40), {});
  assert.equal(visibleWidth(style.paint("配置", "accent")), 4);
  assert.equal(visibleWidth("A配置B"), 6);
  const shortened = truncateMiddleText("/Users/example/a/very/long/配置/path/agent", 24);
  assert.ok(visibleWidth(shortened) <= 24);
  assert.match(shortened, /…/);
  for (const line of wrapText("alpha beta gamma 配置配置配置", 12)) assert.ok(visibleWidth(line) <= 12);
});

test("color honors NO_COLOR, dumb terminals, and non-TTY output", () => {
  assert.equal(createTerminalStyle(output(), {}).enabled, true);
  assert.equal(createTerminalStyle(output(), { NO_COLOR: "1" }).enabled, false);
  assert.equal(createTerminalStyle(output(), { TERM: "dumb" }).enabled, false);
  const plain = new PassThrough();
  assert.equal(createTerminalStyle(plain, {}).enabled, false);
});

test("menu frames use a bounded centered window and fit the terminal", () => {
  const style = createTerminalStyle(output(42), {});
  const items = Array.from({ length: 10 }, (_, index) => ({ value: `item-${index}`, label: `item-${index}`, description: "Current item description" }));
  const lines = renderMenuFrame({ title: "Resources", items, maxVisible: 5 }, 7, new Set(), style);
  assert.equal(lines.filter((line) => /› item-|  item-/.test(stripVTControlCharacters(line))).length, 5);
  assert.match(stripVTControlCharacters(lines.join("\n")), /8\/10/);
  assert.equal(lines.join("\n").includes("item-0\n"), false);
  assert.match(lines.join("\n"), /item-9/);
  for (const line of lines) assert.ok(visibleWidth(line) <= 42);
});

test("single selection supports arrows, Enter, and terminal restoration", async () => {
  const input = rawInput();
  const stream = output();
  let rendered = "";
  stream.on("data", (chunk) => { rendered += chunk.toString(); });
  const promise = showTerminalMenu({ input, output: stream }, {
    title: "Action",
    items: [{ value: "observe", label: "Observe" }, { value: "repair", label: "Repair" }, { value: "manage", label: "Manage" }],
    initial: ["observe"],
  }, createTerminalStyle(stream, {}));
  input.write("\x1b[B\x1b[B\r");
  assert.deepEqual(await promise, ["manage"]);
  assert.deepEqual(input.rawModes, [true, false]);
  assert.match(rendered, /\x1b\[\?25h/);
});

test("multi selection preserves required items and supports all/none shortcuts", async () => {
  const input = rawInput();
  const stream = output();
  const promise = showTerminalMenu({ input, output: stream }, {
    title: "Resources",
    items: [{ value: "base", label: "Base", required: true }, { value: "integration", label: "Integration" }],
    multiple: true,
    initial: [],
  }, createTerminalStyle(stream, {}));
  input.write(" n a\r");
  assert.deepEqual(await promise, ["base", "integration"]);
  assert.deepEqual(input.rawModes, [true, false]);
});

test("q and Ctrl+C cancel and restore the terminal", async () => {
  for (const key of ["q", "\x03"]) {
    const input = rawInput();
    const stream = output();
    const promise = showTerminalMenu({ input, output: stream }, {
      title: "Action",
      items: [{ value: "observe", label: "Observe" }],
    }, createTerminalStyle(stream, {}));
    input.write(key);
    assert.equal(await promise, null);
    assert.deepEqual(input.rawModes, [true, false]);
    assert.equal(input.isRaw, false);
  }
});

test("raw-mode startup failures restore the cursor and input mode", async () => {
  const input = rawInput();
  input.setRawMode = (mode) => {
    input.rawModes.push(mode);
    input.isRaw = mode;
    if (mode) throw new Error("simulated raw-mode failure");
  };
  const stream = output();
  let rendered = "";
  stream.on("data", (chunk) => { rendered += chunk.toString(); });
  const promise = showTerminalMenu({ input, output: stream }, {
    title: "Action",
    items: [{ value: "observe", label: "Observe" }],
  }, createTerminalStyle(stream, {}));
  await assert.rejects(promise, /simulated raw-mode failure/);
  assert.deepEqual(input.rawModes, [true, false]);
  assert.match(rendered, /\x1b\[\?25h/);
});
