import fs from "node:fs";
import path from "node:path";

const version = process.env.AGENTBREW_SANDBOX_NEXT_VERSION ?? "1.5.0";
const host = "@earendil-works/pi-coding-agent";
const peers = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-codemode",
  "@earendil-works/pi-mcp",
  "@earendil-works/pi-telemetry",
  "@earendil-works/pi-tui",
];
for (const name of [host, ...peers]) {
  const dir = path.join(process.env.PI_AGENT_DIR, "install", "releases", version, "node_modules", name);
  const file = path.join(dir, "package.json");
  if (fs.existsSync(file)) continue;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(name === host
    ? { name, version, dependencies: Object.fromEntries(peers.map((peer) => [peer, version])) }
    : { name, version }));
}
