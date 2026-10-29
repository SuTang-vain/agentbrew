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
const internalNames = [HOST_PACKAGE, ...PEERS];
const installerName = "@earendil-works/pi-coding-agent-install";

function integrity(name, version) {
  return `sha512-${Buffer.alloc(64, name.length + version.length).toString("base64")}`;
}

function tarball(request, name, version) {
  return `http://${request.headers.host}/tarballs/${encodeURIComponent(name)}/${version}.tgz`;
}

function installerLock(request) {
  const packages = {
    "": { name: installerName, version: release, dependencies: { [HOST_PACKAGE]: release } },
  };
  for (const name of internalNames) {
    packages[`node_modules/${name}`] = { version: release, resolved: tarball(request, name, release) };
  }
  return { lockfileVersion: 3, packages };
}

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
  if (url.pathname === `/installer/${release}/package.json`) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(options.installerManifest ?? { name: installerName, version: release, dependencies: { [HOST_PACKAGE]: release } }));
    return;
  }
  if (url.pathname === `/installer/${release}/package-lock.json`) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(options.installerLock ?? installerLock(request)));
    return;
  }
  if (url.pathname.startsWith("/registry/")) {
    const parts = url.pathname.split("/");
    const name = decodeURIComponent(parts[2]);
    if (parts.length === 4 && internalNames.includes(name) && parts[3] === release) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        name,
        version: release,
        ...(name === HOST_PACKAGE ? { dependencies: hostDependencies } : {}),
        dist: { integrity: integrity(name, release), tarball: tarball(request, name, release) },
      }));
      return;
    }
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
    if (parts.length === 4 && name === "pi-subagents" && versions[parts[3]]) {
      const value = versions[parts[3]];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        name,
        version: parts[3],
        peerDependencies: value.peers,
        dist: { integrity: value.integrity ?? `sha512-${parts[3]}` },
      }));
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
