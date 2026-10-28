import { spawnSync } from "node:child_process";

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
