import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_PACKAGE = "@earendil-works/pi-coding-agent";
export const PEERS = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-codemode",
  "@earendil-works/pi-mcp",
  "@earendil-works/pi-tui",
];

export const CLI = process.env.AGENTBREW_CLI ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/bin/agentbrew.js");

function writeExecutable(file, content) {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

export function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrew-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const agentDir = path.join(home, ".pi", "agent");
  const npmDir = path.join(agentDir, "npm");
  const stateDir = path.join(root, "state");
  const bin = path.join(root, "bin");
  const log = path.join(root, "commands.log");
  const herdrStatus = path.join(root, "herdr-status");
  fs.mkdirSync(npmDir, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(herdrStatus, "current");

  const dependencies = Object.fromEntries([
    ...PEERS.map((name) => [name, "1.4.0"]),
    [HOST_PACKAGE, "1.4.0"],
    ...(options.includeExternal === false ? [] : [["pi-subagents", "^0.83.0"]]),
  ]);
  fs.writeFileSync(path.join(npmDir, "package.json"), `${JSON.stringify({ name: "pi-extensions", private: true, dependencies }, null, 2)}\n`);

  function setHost(version, activate = false) {
    if (activate) {
      fs.mkdirSync(path.join(agentDir, "install"), { recursive: true });
      fs.writeFileSync(path.join(agentDir, "install", "current-version"), `${version}\n`);
    }
    const scope = path.join(agentDir, "install", "releases", version, "node_modules", "@earendil-works");
    for (const name of [HOST_PACKAGE, ...PEERS]) {
      const dir = path.join(scope, path.basename(name));
      const manifest = name === HOST_PACKAGE
        ? { name, version, dependencies: Object.fromEntries(PEERS.map((peer) => [peer, version])) }
        : { name, version };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    return path.join(scope, path.basename(HOST_PACKAGE));
  }
  setHost("1.4.0", true);

  writeExecutable(path.join(bin, "pi"), `#!/bin/sh
printf 'pi %s\\n' "$*" >> "$MOCK_LOG"
if [ "$MOCK_PI_FAIL" = "1" ]; then
  if [ -n "$MOCK_SECRET" ]; then printf 'token=%s\\n' "$MOCK_SECRET" >&2; fi
  exit 23
fi
if [ "$1" = "--version" ]; then
  if [ -n "$MOCK_PI_REPORTED_VERSION" ]; then printf '%s\\n' "$MOCK_PI_REPORTED_VERSION"; else cat "$PI_AGENT_DIR/install/current-version"; fi
  exit 0
fi
if [ "$1" = "update" ] && { [ "$2" = "--all" ] || [ "$2" = "--self" ]; }; then
  printf '%s\\n' "$MOCK_NEXT_VERSION" > "$PI_AGENT_DIR/install/current-version"
fi
`);

  if (options.realNpm !== true) {
    writeExecutable(path.join(bin, "npm"), `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$MOCK_LOG"
if [ "$1" = "root" ]; then exit 1; fi
if [ "$1" = "install" ]; then
  if [ "$MOCK_NPM_FAIL" = "1" ]; then exit 19; fi
  node -e '
    const fs = require("fs"), path = require("path");
    const npmDir = process.cwd();
    const args = process.argv.slice(2);
    const pkg = JSON.parse(fs.readFileSync(path.join(npmDir, "package.json")));
    const externalNames = Object.keys(pkg.dependencies).filter((name) => !name.startsWith("@earendil-works/"));
    if (args.includes("--package-lock-only")) {
      const packages = { "": { name: pkg.name, dependencies: pkg.dependencies } };
      for (const name of externalNames) {
        const version = pkg.dependencies[name];
        const integrity = process.env.MOCK_NPM_WRONG_INTEGRITY === "1" ? "sha512-wrong" : "sha512-" + version;
        packages["node_modules/" + name] = { version, resolved: "https://registry.npmjs.org/" + name + "/-/" + version + ".tgz", integrity };
      }
      fs.writeFileSync(path.join(npmDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }, null, 2) + "\\n");
      process.exit(0);
    }
    function hostLinks() {
      for (const [name, spec] of Object.entries(pkg.dependencies)) {
        if (!name.startsWith("@earendil-works/") || !spec.startsWith("file:")) continue;
        const target = path.resolve(npmDir, spec.slice(5));
        const dest = path.join(npmDir, "node_modules", name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.rmSync(dest, { recursive: true, force: true });
        fs.symlinkSync(target, dest, "dir");
      }
    }
    function external(name, version) {
      const dest = path.join(npmDir, "node_modules", name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, "package.json"), JSON.stringify({
        name,
        version: process.env.MOCK_NPM_WRONG_VERSION === "1" ? "0.0.0" : version,
        peerDependencies: { "@earendil-works/pi-coding-agent": ">=1.2.0" },
      }));
    }
    hostLinks();
    const lockFile = path.join(npmDir, "package-lock.json");
    const lock = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, "utf8")) : null;
    if (lock) {
      lock.packages[""].dependencies = Object.fromEntries(Object.entries(lock.packages[""].dependencies).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
      fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\\n");
    }
    if (lock && process.env.MOCK_NPM_REORDER_LOCK === "1") {
      // Simulate npm normalizing the root dependency object order during install.
      lock.packages[""].dependencies = Object.fromEntries(Object.entries(lock.packages[""].dependencies).reverse());
      fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\\n");
    }
    if (args.includes("--no-save")) {
      for (const spec of args.slice(1).filter((value) => !value.startsWith("-"))) {
        const at = spec.lastIndexOf("@");
        external(spec.slice(0, at), spec.slice(at + 1));
      }
    } else {
      for (const name of externalNames) {
        external(name, lock?.packages?.["node_modules/" + name]?.version ?? pkg.dependencies[name].replace(/^[~^]/, ""));
      }
    }
    if (process.env.MOCK_NPM_REWRITE_MANIFEST === "1") {
      pkg.dependencies["pi-subagents"] = "99.0.0";
      fs.writeFileSync(path.join(npmDir, "package.json"), JSON.stringify(pkg));
    }
    if (process.env.MOCK_NPM_BREAK_HOST_LINK === "1") {
      const link = path.join(npmDir, "node_modules", "@earendil-works", "pi-coding-agent");
      fs.rmSync(link, { recursive: true, force: true });
      fs.mkdirSync(link, { recursive: true });
    }
    if (process.env.MOCK_NPM_REORDER_LOCK === "1") {
      const current = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      current.packages[""].dependencies = Object.fromEntries(Object.entries(current.packages[""].dependencies).sort(([a], [b]) => a.localeCompare(b)));
      fs.writeFileSync(lockFile, JSON.stringify(current, null, 2) + "\\n");
    }
    if (process.env.MOCK_NPM_REWRITE_LOCK === "1") fs.writeFileSync(lockFile, "changed\\n");
  ' "$@"
fi
if [ "$1" = "run" ] && [ "$2" = "selftest" ] && [ "$MOCK_SELFTEST_FAIL" = "1" ]; then exit 31; fi
`);
  }

  writeExecutable(path.join(bin, "herdr"), `#!/bin/sh
printf 'herdr %s\\n' "$*" >> "$MOCK_LOG"
if [ "$MOCK_HERDR_MISSING" = "1" ]; then exit 127; fi
if [ "$1" = "--version" ]; then printf 'herdr 0.9.5\\n'; exit 0; fi
if [ "$1" = "integration" ] && [ "$2" = "status" ]; then
  printf 'pi: %s (v9)\\n' "$(cat "$MOCK_HERDR_STATUS_FILE")"
  exit 0
fi
if [ "$1" = "integration" ] && [ "$2" = "install" ] && [ "$3" = "pi" ]; then
  if [ "$MOCK_HERDR_FAIL" = "1" ]; then exit 17; fi
  printf 'current\\n' > "$MOCK_HERDR_STATUS_FILE"
  mkdir -p "$PI_AGENT_DIR/extensions"
  printf 'generated\\n' > "$PI_AGENT_DIR/extensions/herdr-agent-state.ts"
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  if [ "$MOCK_HERDR_BAD_JSON" = "1" ]; then printf 'not json\\n'; else printf '{"result":{"plugins":[]}}\\n'; fi
  exit 0
fi
exit 2
`);

  function env(extraEnv = {}) {
    return {
      ...process.env,
      HOME: home,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      PI_AGENT_DIR: agentDir,
      AGENTBREW_STATE_DIR: stateDir,
      MOCK_LOG: log,
      MOCK_NEXT_VERSION: "1.5.0",
      MOCK_HERDR_STATUS_FILE: herdrStatus,
      ...extraEnv,
    };
  }

  function run(args = [], extraEnv = {}) {
    return spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env: env(extraEnv),
    });
  }

  function commands() {
    if (!fs.existsSync(log)) return [];
    const content = fs.readFileSync(log, "utf8").trim();
    return content ? content.split("\n") : [];
  }

  return { root, home, agentDir, npmDir, stateDir, bin, log, herdrStatus, setHost, env, run, commands };
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
