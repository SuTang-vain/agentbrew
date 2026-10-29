import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repo, ".sandbox");
if (root !== path.join(repo, ".sandbox")) throw new Error("unsafe sandbox path");
const args = process.argv.slice(2);
const scenarioIndex = args.indexOf("--scenario");
const scenario = scenarioIndex === -1 ? "existing" : args[scenarioIndex + 1];
if (!["existing", "empty", "healthy", "broken", "no-host", "bundle"].includes(scenario)) {
  throw new Error(`unknown sandbox scenario: ${scenario}`);
}
if (fs.existsSync(root) && (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink())) {
  throw new Error("sandbox root must be a real directory");
}

const home = path.join(root, "home");
if (fs.existsSync(home) && (!fs.lstatSync(home).isDirectory() || fs.lstatSync(home).isSymbolicLink())) {
  throw new Error("sandbox HOME must be a real directory");
}
fs.mkdirSync(home, { recursive: true });
for (const entry of fs.readdirSync(root)) {
  if (entry !== "home") fs.rmSync(path.join(root, entry), { recursive: true, force: true });
}
for (const entry of fs.readdirSync(home)) fs.rmSync(path.join(home, entry), { recursive: true, force: true });

const agent = path.join(home, ".pi", "agent");
const npmDir = path.join(agent, "npm");
const bin = path.join(root, "bin");
const hostPackage = "@earendil-works/pi-coding-agent";
const peers = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-codemode",
  "@earendil-works/pi-mcp",
  "@earendil-works/pi-telemetry",
  "@earendil-works/pi-tui",
];

function write(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

function executable(file, content) {
  write(file, content, 0o755);
}

function addHost(version) {
  const scope = path.join(agent, "install", "releases", version, "node_modules", "@earendil-works");
  for (const name of [hostPackage, ...peers]) {
    const manifest = name === hostPackage
      ? { name, version, description: "Sandbox Pi host", dependencies: Object.fromEntries(peers.map((peer) => [peer, version])) }
      : { name, version, description: `Sandbox package ${name}` };
    write(path.join(scope, path.basename(name), "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

if (scenario !== "no-host") {
  addHost("1.4.0");
  addHost("1.5.0");
  write(path.join(agent, "install", "current-version"), "1.4.0\n");
}
write(path.join(root, "herdr-status"), "outdated\n");
write(path.join(root, "commands.log"), "");
write(path.join(root, "scenario"), `${scenario}\n`);

const dependencies = Object.fromEntries([
  ...peers.map((name) => [name, "1.4.0"]),
  [hostPackage, "1.4.0"],
  ["pi-subagents", "^0.83.0"],
]);
if (scenario !== "empty" && scenario !== "no-host") {
  write(
    path.join(npmDir, "package.json"),
    scenario === "broken" ? "{\n" : `${JSON.stringify({ name: "agentbrew-sandbox-extensions", private: true, dependencies }, null, 2)}\n`,
  );
}

executable(path.join(bin, "agentbrew"), `#!/bin/sh
exec node ${JSON.stringify(path.join(repo, "dist", "bin", "agentbrew.js"))} "$@"
`);

executable(path.join(bin, "pi"), `#!/bin/sh
printf 'pi %s\\n' "$*" >> "$AGENTBREW_SANDBOX/commands.log"
if [ "$MOCK_PI_FAIL" = "1" ]; then
  printf 'Sandbox Pi failure requested\\n' >&2
  exit 23
fi
if [ "$1" = "--version" ]; then
  cat "$PI_AGENT_DIR/install/current-version"
  exit 0
fi
if [ "$1" = "update" ] && [ "$2" = "--all" ]; then
  printf '1.5.0\\n' > "$PI_AGENT_DIR/install/current-version"
  printf 'Sandbox Pi and extensions updated to 1.5.0\\n'
  exit 0
fi
if [ "$1" = "update" ] && [ "$2" = "--self" ]; then
  printf '1.5.0\\n' > "$PI_AGENT_DIR/install/current-version"
  printf 'Sandbox Pi host updated to 1.5.0; extensions unchanged\\n'
  exit 0
fi
printf 'sandbox pi only supports --version, update --all, and update --self\\n' >&2
exit 2
`);

executable(path.join(bin, "npm"), `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$AGENTBREW_SANDBOX/commands.log"
if [ "$1" = "root" ]; then exit 1; fi
if [ "$1" = "install" ]; then
  if [ "$MOCK_NPM_FAIL" = "1" ]; then exit 19; fi
  node -e '
    const fs = require("fs"), path = require("path");
    const npmDir = process.cwd();
    const args = process.argv.slice(2);
    const pkg = JSON.parse(fs.readFileSync(path.join(npmDir, "package.json")));
    const externalNames = Object.keys(pkg.dependencies).filter((name) => !name.startsWith("@earendil-works/"));
    const lockFile = path.join(npmDir, "package-lock.json");
    function lockData(dependencies, versions) {
      const packages = { "": { name: pkg.name, dependencies } };
      for (const name of externalNames) {
        const version = versions[name];
        packages["node_modules/" + name] = { version, integrity: "sha512-sandbox-" + version };
      }
      return { lockfileVersion: 3, packages };
    }
    if (args.includes("--package-lock-only")) {
      const versions = Object.fromEntries(externalNames.map((name) => [name, pkg.dependencies[name]]));
      fs.writeFileSync(lockFile, JSON.stringify(lockData(pkg.dependencies, versions), null, 2) + "\\n");
      process.exit(0);
    }
    const hadLock = fs.existsSync(lockFile);
    const lock = hadLock ? JSON.parse(fs.readFileSync(lockFile, "utf8")) : null;
    function external(name, version) {
      const dest = path.join(npmDir, "node_modules", name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, "package.json"), JSON.stringify({
        name,
        version,
        peerDependencies: { "@earendil-works/pi-coding-agent": ">=1.2.0" },
      }));
    }
    for (const [name, spec] of Object.entries(pkg.dependencies)) {
      if (name.startsWith("@earendil-works/") && spec.startsWith("file:")) {
        const target = path.resolve(npmDir, spec.slice(5));
        const dest = path.join(npmDir, "node_modules", name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.rmSync(dest, { recursive: true, force: true });
        fs.symlinkSync(target, dest, "dir");
      } else if (!name.startsWith("@earendil-works/")) {
        external(name, lock?.packages?.["node_modules/" + name]?.version ?? spec.replace(/^[~^]/, ""));
      }
    }
    if (!hadLock) {
      const versions = Object.fromEntries(externalNames.map((name) => [name, pkg.dependencies[name].replace(/^[~^]/, "")]));
      fs.writeFileSync(lockFile, JSON.stringify(lockData(pkg.dependencies, versions), null, 2) + "\\n");
    }
  ' "$@"
  printf 'Sandbox npm dependencies linked\\n'
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "selftest" ]; then
  printf 'Sandbox selftest passed\\n'
  exit 0
fi
printf 'sandbox npm only supports install, root, and run selftest\\n' >&2
exit 2
`);

executable(path.join(bin, "herdr"), `#!/bin/sh
printf 'herdr %s\\n' "$*" >> "$AGENTBREW_SANDBOX/commands.log"
if [ "$1" = "--version" ]; then
  printf 'herdr 0.9.5\\n'
  exit 0
fi
if [ "$1" = "integration" ] && [ "$2" = "status" ]; then
  printf 'pi: %s (v9) (%s)\\n' "$(cat "$AGENTBREW_SANDBOX/herdr-status")" "$PI_AGENT_DIR/extensions/herdr-agent-state.ts"
  exit 0
fi
if [ "$1" = "integration" ] && [ "$2" = "install" ] && [ "$3" = "pi" ]; then
  printf 'current\\n' > "$AGENTBREW_SANDBOX/herdr-status"
  mkdir -p "$PI_AGENT_DIR/extensions"
  printf '// Sandbox-generated integration\\n' > "$PI_AGENT_DIR/extensions/herdr-agent-state.ts"
  printf 'Sandbox herdr integration installed\\n'
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "list" ] && [ "$3" = "--json" ]; then
  printf '{"result":{"plugins":[{"plugin_id":"sandbox.example","name":"Sandbox Example Plugin","enabled":true,"version":"1.0.0"}]}}\\n'
  exit 0
fi
printf 'unsupported sandbox herdr command\\n' >&2
exit 2
`);

if (scenario === "healthy" || scenario === "bundle") {
  const env = {
    ...process.env,
    AGENTBREW_SANDBOX: root,
    AGENTBREW_STATE_DIR: path.join(root, "state"),
    HOME: home,
    PI_AGENT_DIR: agent,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  const result = spawnSync(process.execPath, [path.join(repo, "dist", "bin", "agentbrew.js"), "update"], { env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`cannot initialize healthy sandbox: ${result.stderr || result.stdout}`);
  if (scenario === "bundle") {
    write(path.join(agent, "install", "current-version"), "1.4.0\n");
    const repaired = spawnSync(process.execPath, [
      path.join(repo, "dist", "bin", "agentbrew.js"),
      "init", "--expect", "repairable", "--mode", "repair", "--resource", "pi.host-links", "--apply",
    ], { env, encoding: "utf8" });
    if (repaired.status !== 0) throw new Error(`cannot prepare the bundle host-update scenario: ${repaired.stderr || repaired.stdout}`);
  }
  write(path.join(root, "commands.log"), "");
}

if (scenario === "bundle") {
  write(path.join(root, "layers", "public.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "agentbrew-layer",
    layer: "public",
    resources: { "npm:pi-subagents": { source: { type: "npm", spec: "^0.83.0" }, update: "compatible" } },
  }, null, 2)}\n`);
  write(path.join(root, "layers", "team.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "agentbrew-layer",
    layer: "team",
    resources: {},
    forbidden: ["npm:example-forbidden"],
  }, null, 2)}\n`);
  write(path.join(root, "layers", "personal.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "agentbrew-layer",
    layer: "personal",
    resources: { "npm:pi-subagents": { source: { type: "npm", spec: "^0.84.0" }, update: "compatible" } },
    override: ["npm:pi-subagents"],
  }, null, 2)}\n`);
  write(path.join(root, "state", "ownership.json"), `${JSON.stringify({
    schemaVersion: 1,
    resources: {
      "pi.host": "manage",
      "pi.host-links": "manage",
      "herdr.pi-integration": "generate",
      ...Object.fromEntries([...peers, "pi-subagents"].map((name) => [`npm:${name}`, "manage"])),
    },
  }, null, 2)}\n`, 0o600);
}

console.log(root);
