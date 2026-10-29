import type { Context } from "./context.js";
import { bundleSummary } from "./bundle.js";
import { redact } from "./process.js";
import { createRegistration, sourceStatus } from "./sources.js";
import {
  readSourceRegistration,
  removeSourceRegistration,
  sourceRegistrationFingerprint,
  writeSourceRegistration,
} from "./source-state.js";
import { withOperationLock } from "./state.js";
import { failedStep, skippedStep, successfulStep, type CommandResult, type OverallStatus } from "./types.js";

export type SourceAction = "set" | "list" | "clear";

function result(context: Context, action: SourceAction): CommandResult {
  return {
    schemaVersion: 1,
    command: "source",
    status: "success",
    target: { agentDir: context.agentDir },
    changes: "none",
    steps: [],
    differences: [],
    checks: [],
    data: { action, resourcesChanged: false },
  };
}

function failure(context: Context, action: SourceAction, error: unknown, status: OverallStatus = "failed"): CommandResult {
  return {
    ...result(context, action),
    status,
    error: redact(error instanceof Error ? error.message : String(error)),
  };
}

function setSources(context: Context): CommandResult {
  let prepared: ReturnType<typeof createRegistration>;
  try {
    prepared = createRegistration(context);
  } catch (error) {
    return failure(context, "set", error, "not-executed");
  }
  try {
    return withOperationLock(context, () => {
      const output = result(context, "set");
      try {
        const current = createRegistration(context);
        if (JSON.stringify(current.registration) !== JSON.stringify(prepared.registration)) {
          output.status = "not-executed";
          output.error = "source layers changed while waiting for the operation lock; review and retry";
          return output;
        }
        writeSourceRegistration(context, prepared.registration);
        output.changes = "observed";
        output.steps.push(successfulStep("source-set", "Register the complete explicit layer list", "observed", "only the per-target local binding changed"));
        output.data = {
          action: "set",
          resourcesChanged: false,
          registration: prepared.registration,
          bundle: bundleSummary(prepared.bundle),
        };
      } catch (error) {
        output.steps.push(failedStep("source-set", "Register the complete explicit layer list", error, "none"));
        output.status = "not-executed";
        output.error = redact(error instanceof Error ? error.message : String(error));
      }
      return output;
    });
  } catch (error) {
    return failure(context, "set", error);
  }
}

function listSources(context: Context): CommandResult {
  const output = result(context, "list");
  try {
    const registration = readSourceRegistration(context);
    const status = sourceStatus(context, registration);
    output.data = { action: "list", resourcesChanged: false, ...status };
    if (status.state === "error") {
      output.status = "failed";
      output.error = status.error ?? "registered sources cannot be loaded";
    }
    return output;
  } catch (error) {
    return failure(context, "list", error);
  }
}

function clearSources(context: Context): CommandResult {
  try {
    const registration = readSourceRegistration(context);
    if (!registration) {
      const output = result(context, "clear");
      output.steps.push(skippedStep("source-clear", "Clear the per-target source binding", "no source binding is registered"));
      return output;
    }
    const fingerprint = sourceRegistrationFingerprint(context);
    return withOperationLock(context, () => {
      const output = result(context, "clear");
      try {
        const current = readSourceRegistration(context);
        if (!current || sourceRegistrationFingerprint(context) !== fingerprint
          || JSON.stringify(current) !== JSON.stringify(registration)) {
          output.status = "not-executed";
          output.error = "the source binding changed while waiting for the operation lock; review and retry";
          return output;
        }
        removeSourceRegistration(context);
        output.changes = "observed";
        output.steps.push(successfulStep("source-clear", "Clear the per-target source binding", "observed", "registered sources removed; managed resources were not changed"));
        output.data = { action: "clear", resourcesChanged: false, cleared: true };
      } catch (error) {
        output.steps.push(failedStep("source-clear", "Clear the per-target source binding", error, "none"));
        output.status = "not-executed";
        output.error = redact(error instanceof Error ? error.message : String(error));
      }
      return output;
    });
  } catch (error) {
    return failure(context, "clear", error);
  }
}

export function sourceCommand(context: Context, action: SourceAction): CommandResult {
  if (action === "set") return setSources(context);
  if (action === "clear") return clearSources(context);
  return listSources(context);
}
