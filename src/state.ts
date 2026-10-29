import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context } from "./context.js";

function lockPath(context: Context): string {
  return path.join(context.stateDir, "operation.lock");
}

export function withOperationLock<T>(context: Context, operation: () => T): T {
  fs.mkdirSync(context.stateDir, { recursive: true, mode: 0o700 });
  const file = lockPath(context);
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`another Agentbrew operation holds ${file}; verify it has stopped before removing a stale lock`);
    }
    throw error;
  }

  const cleanup = (): void => {
    fs.closeSync(descriptor);
    try {
      fs.unlinkSync(file);
    } catch {
      // The next run will stop rather than risk concurrent writes.
    }
  };
  let result: T;
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    result = operation();
  } catch (error) {
    cleanup();
    throw error;
  }
  if (result && (typeof result === "object" || typeof result === "function") && typeof (result as any).then === "function") {
    return Promise.resolve(result).finally(cleanup) as unknown as T;
  }
  cleanup();
  return result;
}

export function writeStateJson(context: Context, name: string, value: unknown): void {
  if (context.dryRun) return;
  fs.mkdirSync(context.stateDir, { recursive: true, mode: 0o700 });
  const destination = path.join(context.stateDir, name);
  const temporary = path.join(context.stateDir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
