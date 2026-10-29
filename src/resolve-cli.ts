import type { Context } from "./context.js";
import { loadBundle } from "./bundle.js";
import { createMetadataClient } from "./metadata.js";
import { redact } from "./process.js";
import { resolveConfiguration, type ResolveReport } from "./resolve.js";
import type { CommandResult, HealthCheck } from "./types.js";

export function metadataOffline(env: NodeJS.ProcessEnv): boolean {
  const value = env.PI_OFFLINE?.trim().toLowerCase();
  return Boolean(value && !["0", "false", "no"].includes(value));
}

export function resolutionChecks(report: ResolveReport): HealthCheck[] {
  const checks: HealthCheck[] = [];
  checks.push(report.host
    ? {
        resource: "pi.host",
        status: "pass",
        message: `${report.host.currentVersion} -> ${report.host.targetVersion} (${report.host.action}); ${report.host.reason}`,
      }
    : { resource: "pi.host", status: "fail", message: "target host could not be resolved" });
  for (const resource of report.resources) {
    checks.push({
      resource: resource.id,
      status: resource.action === "blocked" ? "fail" : resource.action === "unknown" ? "warn" : "pass",
      message: resource.action === "unknown" && report.host?.action === "update"
        ? `${resource.reason}; a host update must remain blocked`
        : resource.reason,
    });
  }
  for (const error of report.errors) checks.push({ resource: error.source, status: "fail", message: error.message });
  return checks;
}

export async function resolveCommand(context: Context, selected: string[]): Promise<CommandResult> {
  const result: CommandResult = {
    schemaVersion: 1,
    command: "resolve",
    status: "success",
    target: { agentDir: context.agentDir },
    changes: "none",
    steps: [],
    differences: [],
    checks: [],
  };
  if (metadataOffline(context.env)) {
    result.status = "not-executed";
    result.error = "resolve requires release and npm metadata; PI_OFFLINE is enabled and no network request was made";
    return result;
  }
  try {
    const bundle = loadBundle(context.layers);
    if (!bundle) throw new Error("resolve requires at least one explicit --layer or a registered source binding");
    const client = createMetadataClient({
      releaseUrl: context.env.AGENTBREW_PI_RELEASE_URL,
      registryUrl: context.env.AGENTBREW_NPM_REGISTRY_URL,
    });
    const report = await resolveConfiguration(context, bundle, selected, client);
    result.data = report;
    result.checks = resolutionChecks(report);
    if (!report.host || report.errors.length > 0 || report.resources.some((resource) => resource.action === "blocked")) {
      result.status = "failed";
      result.error = "resolution is incomplete or has blocking compatibility failures; no resources were changed";
    } else if (!report.ready) {
      result.error = "resolution contains unknown compatibility; subsequent host updates must remain blocked";
    }
  } catch (error) {
    result.status = "failed";
    result.error = redact(error instanceof Error ? error.message : String(error));
  }
  return result;
}
