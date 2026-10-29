import type { Context } from "./context.js";
import { bundleSummary } from "./bundle.js";
import { redact } from "./process.js";
import { createGitRegistration, refreshGitRegistration, validateGitRegistration } from "./source-git.js";
import { createRegistration, sourceStatus } from "./sources.js";
import {
  readSourceRegistration,
  removeSourceRegistration,
  sourceRegistrationFingerprint,
  writeSourceRegistration,
} from "./source-state.js";
import { withOperationLock } from "./state.js";
import { failedStep, skippedStep, successfulStep, type CommandResult, type OverallStatus } from "./types.js";

export type SourceAction = "set" | "list" | "clear" | "refresh";

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

function setSources(context: Context, gitInputs: string[]): CommandResult {
  let prepared: ReturnType<typeof createRegistration>;
  try {
    prepared = gitInputs.length ? createGitRegistration(context, gitInputs) : createRegistration(context);
  } catch (error) {
    return failure(context, "set", error, "not-executed");
  }
  try {
    return withOperationLock(context, () => {
      const output = result(context, "set");
      try {
        const current = gitInputs.length ? validateGitRegistration(context, prepared.registration) : createRegistration(context);
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

export function refreshRegisteredSources(context: Context) {
  const registration = readSourceRegistration(context);
  if (!registration || !registration.layers.some((layer) => layer.git)) return registration;
  const fingerprint = sourceRegistrationFingerprint(context);
  return withOperationLock(context, () => {
    const current = readSourceRegistration(context);
    if (!current || sourceRegistrationFingerprint(context) !== fingerprint
      || JSON.stringify(current) !== JSON.stringify(registration)) {
      throw new Error("the source binding changed while waiting for the operation lock; review and retry");
    }
    const refreshed = refreshGitRegistration(context, current);
    if (JSON.stringify(refreshed.registration) !== JSON.stringify(current)) writeSourceRegistration(context, refreshed.registration);
    return refreshed.registration;
  });
}

function refreshSources(context: Context): CommandResult {
  const before = readSourceRegistration(context);
  if (!before) return failure(context, "refresh", "source refresh requires a registered source binding", "not-executed");
  if (!before.layers.some((layer) => layer.git)) {
    const output = result(context, "refresh");
    output.steps.push(skippedStep("source-refresh", "Refresh registered Git sources", "the binding contains only local files"));
    return output;
  }
  try {
    const after = refreshRegisteredSources(context)!;
    const output = result(context, "refresh");
    const changes = after.layers.flatMap((layer) => {
      const previous = before.layers.find((candidate) => candidate.layer === layer.layer);
      return layer.git && previous?.git && layer.git.commit !== previous.git.commit
        ? [{ layer: layer.layer, from: previous.git.commit, to: layer.git.commit }]
        : [];
    });
    const changed = JSON.stringify(after) !== JSON.stringify(before);
    output.changes = changed ? "observed" : "none";
    output.steps.push(changed
      ? successfulStep("source-refresh", "Refresh registered Git sources", "observed", `${changes.length} Git source(s) advanced; managed resources were not changed`)
      : skippedStep("source-refresh", "Refresh registered Git sources", "all registered Git sources already match HEAD"));
    output.data = { action: "refresh", resourcesChanged: false, changes, registration: after };
    return output;
  } catch (error) {
    return failure(context, "refresh", error, "not-executed");
  }
}

export function sourceCommand(context: Context, action: SourceAction, gitInputs: string[] = []): CommandResult {
  if (action === "set") return setSources(context, gitInputs);
  if (action === "clear") return clearSources(context);
  if (action === "refresh") return refreshSources(context);
  return listSources(context);
}
