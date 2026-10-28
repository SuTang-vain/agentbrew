import fs from "node:fs";
import path from "node:path";
import type { Context } from "./context.js";
import { layerArguments, revalidateBundlePlan, type BundlePlan } from "./bundle-plan.js";
import { readOwnership, writeOwnership } from "./ownership.js";
import { diffCommand, doctorCommand } from "./plan.js";
import { redact } from "./process.js";
import { ensureHerdrIntegration } from "./providers/herdr.js";
import { installSelectedBundleDependencies, preflightPi, setSelectedNpmDependencies, snapshotPi } from "./providers/pi.js";
import { withOperationLock, writeStateJson } from "./state.js";
import { combineChanges, failedStep, skippedStep, successfulStep, type CommandResult, type Ownership } from "./types.js";

function resultFor(context: Context, plan: BundlePlan): CommandResult {
  return {
    schemaVersion: 1,
    command: "apply",
    status: "success",
    target: { agentDir: context.agentDir },
    changes: "none",
    steps: [],
    differences: [],
    checks: [],
    data: { mode: plan.mode, resources: plan.resources, bundlePlan: true },
  };
}

function notExecuted(context: Context, plan: BundlePlan, error: unknown): CommandResult {
  return {
    ...resultFor(context, plan),
    status: "not-executed",
    error: redact(error instanceof Error ? error.message : String(error)),
  };
}

function herdrSnapshot(context: Context, selected: boolean): unknown {
  if (!selected) return null;
  const file = path.join(context.agentDir, "extensions", "herdr-agent-state.ts");
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return { path: file, state: "not a regular file" };
    return { path: file, content: fs.readFileSync(file, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: file, state: "missing" };
    throw error;
  }
}

export function applyBundlePlan(context: Context, plan: BundlePlan): CommandResult {
  try {
    readOwnership(context);
    preflightPi(context);
    revalidateBundlePlan(context, plan);
  } catch (error) {
    return notExecuted(context, plan, error);
  }

  let entered = false;
  try {
    return withOperationLock(context, () => {
      entered = true;
      const result = resultFor(context, plan);
      try {
        revalidateBundlePlan(context, plan);
        result.steps.push(successfulStep("preflight", "Revalidate the Bundle plan and capture a local snapshot"));
        writeStateJson(context, "last-snapshot.json", {
          plan,
          pi: snapshotPi(context),
          herdrIntegration: herdrSnapshot(context, plan.actions.some((action) => action.type === "ensure-herdr-integration")),
        });

        const npmActions = plan.actions.filter((action) => action.type === "set-npm-dependency" || action.type === "remove-npm-dependency");
        let npmSucceeded = false;
        if (npmActions.length > 0) {
          const declarations = setSelectedNpmDependencies(context, npmActions.map((action) => ({
            name: action.name,
            spec: action.type === "set-npm-dependency" ? action.spec : null,
          })));
          result.steps.push(declarations);
          if (declarations.status === "success") {
            const installed = installSelectedBundleDependencies(context);
            result.steps.push(installed);
            npmSucceeded = installed.status === "success";
          } else {
            result.steps.push(skippedStep("bundle-npm-install", "Install selected Bundle dependencies", "declaration write failed"));
          }
        }
        for (const action of plan.actions) {
          if (action.type === "ensure-herdr-integration") result.steps.push(ensureHerdrIntegration(context));
        }

        const ownership = readOwnership(context);
        const resources: Record<string, Ownership> = { ...(ownership?.resources ?? {}) };
        const appliedResources: string[] = [];
        if (npmSucceeded) {
          for (const action of npmActions) {
            if (action.type === "remove-npm-dependency") delete resources[action.resource];
            else resources[action.resource] = "manage";
            appliedResources.push(action.resource);
          }
        }
        for (const action of plan.actions) {
          if (action.type === "ensure-herdr-integration"
            && result.steps.some((step) => step.id === "herdr-integration" && step.status === "success")) {
            resources[action.resource] = "generate";
            appliedResources.push(action.resource);
          }
        }
        if (appliedResources.length > 0) {
          const unchanged = ownership !== null && JSON.stringify(resources) === JSON.stringify(ownership.resources);
          if (!unchanged) writeOwnership(context, resources);
          result.steps.push(successfulStep("ownership", "Record ownership only for successfully applied Bundle resources", unchanged ? "none" : "observed"));
        } else {
          result.steps.push(skippedStep("ownership", "Record applied Bundle resource ownership", "no selected resource completed successfully"));
        }

        const checkedContext = { ...context, layers: layerArguments(plan), selftest: false };
        const doctor = doctorCommand(checkedContext);
        result.checks = doctor.checks;
        result.differences = diffCommand(checkedContext).differences;
        result.changes = combineChanges(result.steps);
        if (result.steps.some((step) => step.status === "failed")) {
          result.status = result.changes === "none" ? "failed" : "partial";
          result.error = "one or more selected Bundle actions failed; review individual steps and recorded changes";
        } else if (result.checks.some((check) => check.status === "fail")) {
          result.status = "unhealthy";
          result.error = "selected Bundle resources were applied but the target is not healthy";
        }
        result.data = {
          mode: plan.mode,
          resources: plan.resources,
          appliedResources,
          remainingDifferences: result.differences.length,
          bundlePlan: true,
        };
      } catch (error) {
        result.steps.push(failedStep("execute", "Execute the selected Bundle plan", error));
        result.changes = combineChanges(result.steps);
        result.status = result.changes === "none" ? "failed" : "partial";
        result.error = redact(error instanceof Error ? error.message : String(error));
      }
      writeStateJson(context, "last-result.json", result);
      return result;
    });
  } catch (error) {
    if (entered) {
      return {
        ...resultFor(context, plan),
        status: "failed",
        changes: "unknown",
        error: `${redact(error instanceof Error ? error.message : String(error))}; changes may have occurred before the state error`,
      };
    }
    return notExecuted(context, plan, error);
  }
}
