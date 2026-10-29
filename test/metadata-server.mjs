import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function metadataServer(t, options = {}) {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "metadata-server-process.mjs");
  const child = spawn(process.execPath, [script, JSON.stringify(options)], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const origin = await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) resolve(output.trim());
    });
    child.once("error", reject);
    child.once("exit", (status) => reject(new Error(`metadata server exited ${status}: ${stderr}`)));
  });
  t.after(() => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill("SIGTERM");
  }));
  return {
    env: {
      AGENTBREW_PI_RELEASE_URL: `${origin}/release`,
      AGENTBREW_NPM_REGISTRY_URL: `${origin}/registry`,
      AGENTBREW_PI_INSTALLER_URL: `${origin}/installer`,
    },
  };
}
