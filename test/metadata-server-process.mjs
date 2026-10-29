import fs from "node:fs";
import http from "node:http";
import { HOST_PACKAGE, PEERS } from "./helpers.mjs";

const options = JSON.parse(process.argv[2]);
const release = options.release ?? "1.5.0";
const hostDependencies = options.hostDependencies ?? Object.fromEntries(PEERS.map((name) => [name, release]));
const versions = options.versions ?? {
  "0.83.0": { peers: { [HOST_PACKAGE]: ">=1.2.0" } },
  "0.83.1": { peers: { [HOST_PACKAGE]: ">=1.5.0" } },
};
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (options.appendOnPackument && url.pathname === "/registry/pi-subagents") {
    fs.appendFileSync(options.appendOnPackument, "\n");
  }
  if (options.failure) {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "metadata unavailable" }));
    return;
  }
  if (url.pathname === "/release") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ version: release, packageName: HOST_PACKAGE }));
    return;
  }
  if (url.pathname === `/registry/${encodeURIComponent(HOST_PACKAGE)}/${release}`) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: HOST_PACKAGE, version: release, dependencies: hostDependencies, dist: { integrity: "sha512-host" } }));
    return;
  }
  if (url.pathname.startsWith("/registry/")) {
    const parts = url.pathname.split("/");
    const name = decodeURIComponent(parts[2]);
    if (parts.length === 3 && name === "pi-subagents") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name, versions: Object.fromEntries(Object.entries(versions).map(([version, value]) => [version, {
        name,
        version,
        peerDependencies: value.peers,
        dist: { integrity: value.integrity ?? `sha512-${version}` },
      }])) }));
      return;
    }
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`http://127.0.0.1:${server.address().port}\n`);
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
