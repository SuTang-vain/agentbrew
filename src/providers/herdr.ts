import type { Context } from "../context.js";
import { assertProcessSuccess, runProcess } from "../process.js";
import { failedStep, skippedStep, successfulStep, type Difference, type HealthCheck, type StepResult } from "../types.js";

export type IntegrationState = "current" | "outdated" | "not-installed" | "unknown";

export interface HerdrInspection {
  available: boolean;
  version?: string;
  integration: IntegrationState;
  plugins: Array<{ id: string; name: string; enabled: boolean; version?: string }>;
  pluginError?: string;
}

function integrationState(context: Context): IntegrationState {
  const result = runProcess("herdr", ["integration", "status"], { env: context.env, timeout: 30_000 });
  assertProcessSuccess(result);
  const line = result.stdout.split("\n").find((entry) => entry.trimStart().startsWith("pi:"));
  if (!line) return "unknown";
  if (line.includes("current")) return "current";
  if (line.includes("outdated")) return "outdated";
  if (line.includes("not installed")) return "not-installed";
  return "unknown";
}

export function inspectHerdr(context: Context): HerdrInspection {
  const versionResult = runProcess("herdr", ["--version"], { env: context.env, timeout: 30_000 });
  if (versionResult.status !== 0 || versionResult.error) return { available: false, integration: "unknown", plugins: [] };

  const inspection: HerdrInspection = {
    available: true,
    version: versionResult.stdout.trim().replace(/^herdr\s+/, ""),
    integration: integrationState(context),
    plugins: [],
  };
  const plugins = runProcess("herdr", ["plugin", "list", "--json"], { env: context.env, timeout: 30_000 });
  if (plugins.status !== 0 || plugins.error) {
    inspection.pluginError = plugins.error?.message ?? `herdr plugin list exited with status ${plugins.status ?? "unknown"}`;
    return inspection;
  }
  try {
    const payload = JSON.parse(plugins.stdout);
    const rows = payload?.result?.plugins;
    if (!Array.isArray(rows)) throw new Error("missing result.plugins array");
    inspection.plugins = rows.map((plugin: any) => ({
      id: String(plugin.plugin_id ?? ""),
      name: String(plugin.name ?? plugin.plugin_id ?? ""),
      enabled: plugin.enabled === true,
      ...(typeof plugin.version === "string" ? { version: plugin.version } : {}),
    }));
  } catch (error) {
    inspection.pluginError = `cannot parse herdr plugin list: ${error instanceof Error ? error.message : String(error)}`;
  }
  return inspection;
}

export function diffHerdrInspection(inspection: HerdrInspection): Difference[] {
  if (!inspection.available || inspection.integration === "current") return [];
  return [{
    resource: "herdr.pi-integration",
    kind: "integration-state",
    expected: "current",
    actual: inspection.integration,
  }];
}

export function diffHerdr(context: Context): Difference[] {
  return diffHerdrInspection(inspectHerdr(context));
}

export function doctorHerdrInspection(inspection: HerdrInspection, integrationRequired = true): HealthCheck[] {
  if (!inspection.available) {
    return [{ resource: "herdr", status: "warn", message: "herdr is not available; integration checks were skipped" }];
  }
  const current = inspection.integration === "current";
  const checks: HealthCheck[] = [{
    resource: "herdr.pi-integration",
    status: current ? "pass" : integrationRequired ? "fail" : "warn",
    message: current
      ? `integration is current with herdr ${inspection.version ?? "unknown"}`
      : `integration is ${inspection.integration}${integrationRequired ? "; expected current" : "; it is not managed"}`,
  }];
  if (inspection.pluginError) {
    checks.push({ resource: "herdr.plugins", status: "warn", message: inspection.pluginError });
  } else {
    checks.push({ resource: "herdr.plugins", status: "pass", message: `${inspection.plugins.length} plugin(s) reported by herdr` });
  }
  return checks;
}

export function doctorHerdr(context: Context, integrationRequired = true): HealthCheck[] {
  try {
    return doctorHerdrInspection(inspectHerdr(context), integrationRequired);
  } catch (error) {
    return [{ resource: "herdr", status: "fail", message: error instanceof Error ? error.message : String(error) }];
  }
}

export function updateHerdr(context: Context): StepResult {
  const label = "Rebuild the herdr Pi integration";
  try {
    const before = inspectHerdr(context);
    if (!before.available) return skippedStep("herdr-integration", label, "herdr is not available");
    const result = runProcess("herdr", ["integration", "install", "pi"], {
      cwd: context.agentDir,
      env: context.env,
      timeout: 120_000,
    });
    assertProcessSuccess(result);
    const after = integrationState(context);
    if (after !== "current") throw new Error(`herdr Pi integration is ${after} after installation`);
    return successfulStep(
      "herdr-integration",
      label,
      before.integration === "current" ? "unknown" : "observed",
      "integration is current",
    );
  } catch (error) {
    return failedStep("herdr-integration", label, error);
  }
}

export function ensureHerdrIntegration(context: Context): StepResult {
  const label = "Ensure the selected herdr Pi integration is current";
  try {
    const before = inspectHerdr(context);
    if (!before.available) return failedStep("herdr-integration", label, "herdr is not available", "none");
    if (before.integration === "current") return successfulStep("herdr-integration", label, "none", "integration is already current");
    return updateHerdr(context);
  } catch (error) {
    return failedStep("herdr-integration", label, error);
  }
}
