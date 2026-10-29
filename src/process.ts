import { spawn, spawnSync } from "node:child_process";

export interface ProcessResult {
  command: string;
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}

export function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|secret|password|authorization)(\s*[:=]\s*)("?)[^\s,"]+("?)/gi, "$1$2[redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@");
}

export function formatCommand(command: string, args: string[]): string {
  const quote = (value: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value));
  return redact([command, ...args].map(quote).join(" "));
}

export function runProcess(command: string, args: string[], options: ProcessOptions = {}): ProcessResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });

  return {
    command,
    args: [...args],
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

export function assertProcessSuccess(result: ProcessResult): void {
  if (result.status === 0 && !result.error) return;
  const display = formatCommand(result.command, result.args);
  if (result.error) {
    throw new Error(`${display} could not run: ${redact(result.error.message)}`);
  }
  const detail = redact(result.stderr.trim() || result.stdout.trim());
  const suffix = detail ? `: ${detail.split("\n").slice(-4).join("\n")}` : "";
  const error = new Error(`${display} exited with status ${result.status ?? "unknown"}${suffix}`) as Error & { exitCode?: number };
  error.exitCode = result.status ?? 1;
  throw error;
}

export function runProcessAsync(command: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let failure: Error | undefined;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (status: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command, args: [...args], status, stdout, stderr, ...(error ?? failure ? { error: error ?? failure } : {}) });
    };
    const append = (stream: "stdout" | "stderr", chunk: string): void => {
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > 16 * 1024 * 1024) {
        failure = new Error(`${command} exceeded the 16 MiB output limit`);
        child.kill("SIGTERM");
      }
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => append("stdout", chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => append("stderr", chunk));
    child.once("error", (error) => finish(null, error));
    child.once("close", (status) => finish(status));
    const timer = setTimeout(() => {
      failure = new Error(`${command} timed out after ${options.timeout ?? 120_000} ms`);
      child.kill("SIGTERM");
    }, options.timeout ?? 120_000);
  });
}
