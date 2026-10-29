import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const readyIndex = args.indexOf("--ready");
if (readyIndex < 0 || !args[readyIndex + 1]) throw new Error("--ready requires a file path");
const readyFile = path.resolve(args[readyIndex + 1]);
const host = "@earendil-works/pi-coding-agent";
const peers = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-codemode",
  "@earendil-works/pi-mcp",
  "@earendil-works/pi-telemetry",
  "@earendil-works/pi-tui",
];
const packages = {
  "pi-subagents": {
    "0.83.0": ">=1.2.0",
    "0.83.1": ">=1.5.0",
    "0.84.0": ">=1.5.0",
  },
};
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  response.setHeader("content-type", "application/json");
  if (pathname === "/release") {
    response.end(JSON.stringify({ version: "1.5.0", packageName: host }));
    return;
  }
  if (pathname === `/registry/${encodeURIComponent(host)}/1.5.0`) {
    response.end(JSON.stringify({
      name: host,
      version: "1.5.0",
      dependencies: Object.fromEntries(peers.map((name) => [name, "1.5.0"])),
      dist: { integrity: "sha512-sandbox-host" },
    }));
    return;
  }
  const match = /^\/registry\/([^/]+)$/.exec(pathname);
  const name = match ? decodeURIComponent(match[1]) : "";
  if (packages[name]) {
    response.end(JSON.stringify({
      name,
      versions: Object.fromEntries(Object.entries(packages[name]).map(([version, range]) => [version, {
        name,
        version,
        peerDependencies: { [host]: range },
        dist: { integrity: `sha512-sandbox-${version}` },
      }])),
    }));
    return;
  }
  response.writeHead(404);
  response.end(JSON.stringify({ error: "not found" }));
});
server.listen(0, "127.0.0.1", () => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(readyFile, `${JSON.stringify({ origin, pid: process.pid })}\n`, { mode: 0o600, flag: "wx" });
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
