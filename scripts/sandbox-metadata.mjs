import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const readyIndex = args.indexOf("--ready");
if (readyIndex < 0 || !args[readyIndex + 1]) throw new Error("--ready requires a file path");
const readyFile = path.resolve(args[readyIndex + 1]);
const scenario = process.env.AGENTBREW_SCENARIO ?? "bundle";
const host = "@earendil-works/pi-coding-agent";
const installer = "@earendil-works/pi-coding-agent-install";
const peers = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-codemode",
  "@earendil-works/pi-mcp",
  "@earendil-works/pi-telemetry",
  "@earendil-works/pi-tui",
];
const internal = [host, ...peers];
const packages = {
  "pi-subagents": {
    "0.83.0": ">=1.2.0",
    "0.83.1": ">=1.5.0",
    "0.84.0": ">=1.5.0",
  },
};
const releaseIntegrity = `sha512-${Buffer.alloc(64, 12).toString("base64")}`;

function integrity(name, version) {
  return `sha512-${Buffer.alloc(64, name.length + version.length).toString("base64")}`;
}

function tarball(request, name, version) {
  return `http://${request.headers.host}/tarballs/${encodeURIComponent(name)}/${version}.tgz`;
}

function installerLock(request) {
  const packages = {
    "": { name: installer, version: "1.5.0", dependencies: { [host]: "1.5.0" } },
  };
  for (const name of internal) packages[`node_modules/${name}`] = { version: "1.5.0", resolved: tarball(request, name, "1.5.0") };
  return { lockfileVersion: 3, packages };
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  response.setHeader("content-type", "application/json");
  if (pathname === "/release") {
    response.end(JSON.stringify({ version: "1.5.0", packageName: host }));
    return;
  }
  if (pathname === "/installer/1.5.0/package.json") {
    response.end(JSON.stringify({
      name: scenario === "artifact-failure" ? "invalid-installer" : installer,
      version: "1.5.0",
      dependencies: { [host]: "1.5.0" },
    }));
    return;
  }
  if (pathname === "/installer/1.5.0/package-lock.json") {
    response.end(JSON.stringify(installerLock(request)));
    return;
  }
  const exact = /^\/registry\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (exact) {
    const name = decodeURIComponent(exact[1]);
    const version = exact[2];
    if (internal.includes(name) && version === "1.5.0") {
      response.end(JSON.stringify({
        name,
        version,
        ...(name === host ? { dependencies: Object.fromEntries(peers.map((peer) => [peer, version])) } : {}),
        dist: { integrity: integrity(name, version), tarball: tarball(request, name, version) },
      }));
      return;
    }
    if (name === "pi-subagents" && packages[name][version]) {
      response.end(JSON.stringify({
        name,
        version,
        peerDependencies: { [host]: packages[name][version] },
        dist: { integrity: version === "0.84.0" ? releaseIntegrity : `sha512-sandbox-${version}` },
      }));
      return;
    }
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
        dist: { integrity: version === "0.84.0" ? releaseIntegrity : `sha512-sandbox-${version}` },
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
