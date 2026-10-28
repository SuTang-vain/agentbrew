import fs from "node:fs";
import path from "node:path";
import type { Context } from "./context.js";
import { createInitPlan, evaluateEnvironment, type EnvironmentEvaluation } from "./init.js";
import { isManaged, readOwnership, writeOwnership } from "./ownership.js";
import { redact } from "./process.js";
import { withOperationLock, writeStateJson } from "./state.js";
import { diffHerdr, doctorHerdr, ensureHerdrIntegration } from "./providers/herdr.js";
import {
  checkPiGeneratedLinks,
  diffPi,
  doctorPi,
  HOST_PACKAGE,
  installMinimalPi,
  normalizeSelectedPiDependencies,
  piHostDependencyNames,
  repairPiGeneratedLinks,
  snapshotPiForInit,
} from "./providers/pi.js";
import {
  combineChanges,
  failedStep,
  skippedStep,
  successfulStep,
  type CommandResult,
  type HealthCheck,
  type InitPlan,
  type Ownership,
  type StepResult,
} from "./types.js";

function resultFor(context: Context, command: "init" | "apply", plan: InitPlan): CommandResult {
  return {
    schemaVersion: 1,
    command,
    status: "success",
    target: { agentDir: context.agentDir },
    changes: "none",
    steps: [],
    differences: [],
    checks: [],
    data: { mode: plan.mode, resources: plan.resources },
  };
}

function notExecuted(context: Context, command: "init" | "apply", plan: InitPlan, error: unknown): CommandResult {
  const result = resultFor(context, command, plan);
  result.status = "not-executed";
  result.error = redact(error instanceof Error ? error.message : String(error));
  return result;
}

function assertCurrentPlan(context: Context, plan: InitPlan): EnvironmentEvaluation {
  if (path.resolve(plan.target.agentDir) !== context.agentDir) {
    throw new Error(`plan target ${plan.target.agentDir} does not match the confirmed target ${context.agentDir}`);
  }
  const evaluation = evaluateEnvironment(context);
  const current = createInitPlan(context, evaluation, plan.mode, plan.resources);
  if (current.assessmentHash !== plan.assessmentHash || current.classification !== plan.classification) {
    throw new Error("the target changed after the init plan was authorized; run init again");
  }
  if (JSON.stringify(current.actions) !== JSON.stringify(plan.actions) || JSON.stringify(current.host) !== JSON.stringify(plan.host)) {
    throw new Error("the init plan actions or host do not match the validated selection");
  }
  return evaluation;
}

function integrationSnapshot(context: Context, selected: boolean): unknown {
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

function selectedPackages(context: Context, plan: InitPlan): Set<string> {
  const hostDependencies = new Set(piHostDependencyNames(context));
  const names = new Set<string>();
  for (const resource of plan.resources) {
    if (resource === "pi.host") names.add(HOST_PACKAGE);
    if (resource.startsWith("npm:")) {
      const name = resource.slice(4);
      if (hostDependencies.has(name)) names.add(name);
    }
  }
  return names;
}

function successfulResources(plan: InitPlan, steps: StepResult[], context: Context): Set<string> {
  const succeeded = new Set<string>();
  const success = (id: string) => steps.some((step) => step.id === id && step.status === "success");
  if (plan.mode === "adopt") {
    for (const resource of plan.resources) succeeded.add(resource);
  }
  if ((plan.mode === "repair" || plan.mode === "manage") && success("pi-generated-links")) succeeded.add("pi.host-links");
  if (success("herdr-integration")) succeeded.add("herdr.pi-integration");
  if (plan.mode === "manage") {
    const normalized = success("pi-dependency-spec");
    for (const resource of plan.resources) {
      if (resource === "pi.host" && normalized) succeeded.add(resource);
      if (resource.startsWith("npm:")) {
        const name = resource.slice(4);
        if (!piHostDependencyNames(context).includes(name) || normalized) succeeded.add(resource);
      }
    }
  }
  if (plan.mode === "fresh" && ["pi-base", "pi-generated-links", "npm-install-minimal"].every(success)) {
    succeeded.add("pi.base");
    succeeded.add("pi.host");
    succeeded.add("pi.host-links");
    for (const name of piHostDependencyNames(context)) succeeded.add(`npm:${name}`);
  }
  return succeeded;
}

function ownershipFor(
  evaluation: EnvironmentEvaluation,
  plan: InitPlan,
  succeeded: Set<string>,
  context: Context,
): Record<string, Ownership> {
  const current = readOwnership(context);
  const resources: Record<string, Ownership> = current
    ? { ...current.resources }
    : Object.fromEntries(evaluation.assessment.resources.map((resource) => [resource.id, "observe"]));
  for (const resource of succeeded) {
    if (resource === "pi.base") continue;
    if (resource === "pi.host-links" || resource === "herdr.pi-integration") resources[resource] = "generate";
    else resources[resource] = plan.mode === "adopt" ? "adopt" : "manage";
  }
  return resources;
}

function finalChecks(context: Context, plan: InitPlan): HealthCheck[] {
  const checks: HealthCheck[] = [];
  if (plan.mode === "fresh") {
    checks.push(...doctorPi(context));
  } else {
    if (plan.resources.includes("pi.host-links")) checks.push(checkPiGeneratedLinks(context));
    const selected = plan.mode === "manage" ? selectedPackages(context, plan) : new Set<string>();
    if (selected.size > 0) {
      let differences: ReturnType<typeof diffPi> = [];
      try {
        differences = diffPi(context);
      } catch (error) {
        checks.push({ resource: "pi.dependencies", status: "fail", message: error instanceof Error ? error.message : String(error) });
      }
      for (const name of selected) {
        const difference = differences.find((item) => item.resource === name && item.kind === "dependency-spec");
        checks.push({
          resource: name,
          status: difference ? "fail" : "pass",
          message: difference ? `${difference.kind}: expected ${difference.expected}, found ${difference.actual}` : "portable declaration is consistent",
        });
      }
    }
    if (!checks.some((check) => check.resource === "pi.runtime-load")) {
      checks.push({ resource: "pi.runtime-load", status: "warn", message: "extension loading was not executed during init" });
    }
  }
  const integrationManaged = plan.resources.includes("herdr.pi-integration") && plan.mode !== "adopt";
  checks.push(...doctorHerdr(context, integrationManaged));
  return checks;
}

export function applyInitPlan(
  context: Context,
  plan: InitPlan,
  command: "init" | "apply" = "apply",
): CommandResult {
  try {
    assertCurrentPlan(context, plan);
  } catch (error) {
    return notExecuted(context, command, plan, error);
  }

  let entered = false;
  try {
    return withOperationLock(context, () => {
      entered = true;
      const result = resultFor(context, command, plan);
      try {
        const evaluation = assertCurrentPlan(context, plan);
        result.steps.push(successfulStep("preflight", "Revalidate the init plan and capture a snapshot"));
        writeStateJson(context, "last-snapshot.json", {
          plan,
          pi: snapshotPiForInit(context),
          herdrIntegration: integrationSnapshot(context, plan.resources.includes("herdr.pi-integration")),
        });

        for (const action of plan.actions) {
          if (action === "record-ownership") continue;
          if (action === "install-minimal-pi") result.steps.push(...installMinimalPi(context, plan.host!));
          if (action === "repair-pi-links") result.steps.push(repairPiGeneratedLinks(context, plan.host!));
          if (action === "normalize-pi-dependencies") result.steps.push(normalizeSelectedPiDependencies(context, selectedPackages(context, plan)));
          if (action === "generate-herdr-integration") result.steps.push(ensureHerdrIntegration(context));
        }

        const succeeded = successfulResources(plan, result.steps, context);
        if (plan.actions.includes("record-ownership") && succeeded.size > 0) {
          const before = readOwnership(context);
          const resources = ownershipFor(evaluation, plan, succeeded, context);
          const unchanged = before && JSON.stringify(before.resources) === JSON.stringify(resources);
          if (!unchanged) writeOwnership(context, resources);
          result.steps.push(successfulStep("ownership", "Record ownership only for successfully initialized resources", unchanged ? "none" : "observed"));
        } else if (plan.actions.includes("record-ownership")) {
          result.steps.push(skippedStep("ownership", "Record initialized resource ownership", "no selected resource completed successfully"));
        }

        result.checks = finalChecks(context, plan);
        try {
          result.differences = [...diffPi(context), ...diffHerdr(context)];
        } catch (error) {
          result.differences = [];
          result.checks.push({ resource: "init.remaining-diff", status: "fail", message: error instanceof Error ? error.message : String(error) });
        }
        result.changes = combineChanges(result.steps);
        if (result.steps.some((step) => step.status === "failed")) {
          result.status = result.changes === "none" ? "failed" : "partial";
          result.error = "one or more selected init actions failed; review the recorded steps before retrying";
        } else if (result.checks.some((check) => check.status === "fail")) {
          result.status = "unhealthy";
          result.error = "selected resources were applied but did not pass health checks";
        }
        result.data = {
          mode: plan.mode,
          resources: plan.resources,
          initializedResources: [...succeeded],
          remainingDifferences: result.differences.length,
        };
      } catch (error) {
        result.steps.push(failedStep("execute", "Execute the selected init plan", error));
        result.changes = combineChanges(result.steps);
        result.status = result.changes === "none" ? "failed" : "partial";
        result.error = redact(error instanceof Error ? error.message : String(error));
      }
      writeStateJson(context, "last-result.json", result);
      return result;
    });
  } catch (error) {
    if (entered) {
      const result = resultFor(context, command, plan);
      result.status = "failed";
      result.changes = "unknown";
      result.error = `${redact(error instanceof Error ? error.message : String(error))}; changes may have occurred before the state error`;
      return result;
    }
    return notExecuted(context, command, plan, error);
  }
}

export function ownershipAllowsIntegration(state: ReturnType<typeof readOwnership>): boolean {
  return !state || isManaged(state.resources["herdr.pi-integration"]);
}
