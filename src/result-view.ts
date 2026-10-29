import type { TerminalStyle } from "./terminal.js";
import type { CommandResult } from "./types.js";

export function renderResult(result: CommandResult, verbose: boolean, style?: TerminalStyle): string {
  const lines = [`target: ${result.target.agentDir}`];
  const data = result.data as any;
  if (data?.layerOrigin && data.layerOrigin !== "none") lines.push(`sources: ${data.layerOrigin}`);
  if (result.command === "source" && data) {
    if (data.registered === false) lines.push("sources: no per-target registration");
    if (data.state && data.state !== "none") lines.push(`source state: ${data.state}`);
    for (const layer of data.registration?.layers ?? data.layers ?? []) {
      lines.push(`SOURCE ${layer.layer} ${layer.file}`);
      if (layer.git) lines.push(`  git ${layer.git.url}#${layer.git.path} (${layer.git.ref} ${layer.git.commit})`);
    }
  }
  if (result.command === "inspect" && data) {
    if (data.pi?.host) lines.push(`pi: ${data.pi.host.version} (${data.pi.host.source})`);
    if (data.herdr) {
      lines.push(data.herdr.available
        ? `herdr: ${data.herdr.version ?? "available"}; pi integration: ${data.herdr.integration}; plugins: ${data.herdr.plugins?.length ?? 0}`
        : `herdr: unavailable${data.herdr.error ? ` (${data.herdr.error})` : ""}`);
    }
  }
  if (data?.assessment) {
    const assessment = data.assessment;
    const failed = result.checks.filter((check) => check.status === "fail").length;
    const warnings = result.checks.filter((check) => check.status === "warn").length;
    lines.push(`classification: ${assessment.classification}`);
    lines.push(`pi: ${assessment.host ? `${assessment.host.version} (${assessment.host.source})` : "no usable host found"}`);
    lines.push(`health: ${failed} failing check(s), ${warnings} warning(s), ${result.differences.length} difference(s)`);
    if (assessment.issues?.length) lines.push(...assessment.issues.map((issue: string) => `issue: ${issue}`));
  }
  if (data?.planOut) lines.push(`plan: ${data.planOut}`);
  if (data?.output) lines.push(result.command === "release"
    ? `release: ${data.output} (new file; review before use)`
    : `proposal: ${data.output} (not an active configuration layer)`);
  if (data?.runtimeLoad) lines.push(`runtime load: ${data.runtimeLoad}`);
  if (data?.sourceRefresh) lines.push(`source refresh: ${data.sourceRefresh.state}; run ${data.sourceRefresh.command} to advance registered Git sources`);
  if (data?.warning) lines.push(`WARN ${data.warning}`);
  if (data?.resources && result.command === "explain") {
    for (const resource of data.resources) {
      const declaration = resource.declaration ? ` ${JSON.stringify(resource.declaration)}` : "";
      lines.push(`${resource.id}: ${resource.state}; winner=${resource.layer}; required=${resource.required}${declaration}`);
      lines.push(`  history: ${resource.history.map((event: any) => `${event.layer}:${event.effect}`).join(" -> ")}`);
      if (resource.target) lines.push(`  target: ${resource.target}`);
    }
  }
  const resolution = result.command === "resolve" ? data : data?.resolution;
  if (resolution) {
    if (resolution.host) lines.push(`RESOLVE pi.host ${resolution.host.currentVersion} -> ${resolution.host.targetVersion} (${resolution.host.action})`);
    for (const resource of resolution.resources ?? []) {
      lines.push(`RESOLVE ${resource.id} ${resource.currentVersion ?? "missing"} -> ${resource.targetVersion ?? "unresolved"} (${resource.action})`);
      if (verbose) {
        for (const peer of resource.peerEvidence) lines.push(`  PEER ${peer.dependency} ${peer.range} against ${peer.hostVersion}: ${peer.compatible}`);
        if (resource.integrity) lines.push(`  integrity: ${resource.integrity}`);
      }
    }
    lines.push(`resolution: ready=${resolution.ready}; complete=${resolution.complete}`);
  }
  if (data?.bundle && result.command !== "explain") {
    lines.push(`bundle: ${data.bundle.resources.length} resource(s), ${data.bundle.removed.length} removal(s), ${data.bundle.required.length} required`);
  }
  if (data?.initializedResources) lines.push(`initialized: ${data.initializedResources.join(", ") || "none"}`);
  if (typeof data?.remainingDifferences === "number" && data.remainingDifferences > 0) {
    lines.push(`remaining differences: ${data.remainingDifferences} (unselected; use --verbose to expand)`);
  }
  const assessmentOnly = result.command === "init" && data?.assessment;
  if (!["init", "apply"].includes(result.command) || verbose) {
    for (const difference of result.differences) {
      lines.push(`DIFF ${difference.resource} ${difference.kind}: ${difference.actual} -> ${difference.expected}`);
    }
  } else if (assessmentOnly && result.differences.length > 0) {
    lines.push("use --verbose to show individual differences");
  }
  for (const step of result.steps) {
    const marker = step.status === "success" ? "OK" : step.status === "failed" ? "FAIL" : step.status === "skipped" ? "SKIP" : "PLAN";
    lines.push(`${marker} ${step.label}${step.message ? ` — ${step.message}` : ""}`);
  }
  if (result.command === "resolve") {
    for (const check of result.checks) {
      if (verbose || check.status !== "pass") lines.push(`${check.status.toUpperCase()} ${check.resource}: ${check.message}`);
    }
  } else if (!assessmentOnly || verbose) {
    for (const check of result.checks) lines.push(`${check.status.toUpperCase()} ${check.resource}: ${check.message}`);
  }
  if (result.error) lines.push(`error: ${result.error}`);
  lines.push(`result: ${result.status}; changes: ${result.changes}`);
  if (!style) return lines.join("\n");
  const statusTone = result.status === "success" ? "success" : result.status === "cancelled" || result.status === "not-executed" ? "warning" : "error";
  const rendered = lines.map((line) => {
    if (line.startsWith("PASS ") || line.startsWith("OK ")) return style.paint(line, "success");
    if (line.startsWith("WARN ")) return style.paint(line, "warning");
    if (line.startsWith("FAIL ") || line.startsWith("error:")) return style.paint(line, "error");
    if (line.startsWith("DIFF ") || line.startsWith("SKIP ") || line.startsWith("target:")) return style.paint(line, "muted");
    if (line.startsWith("PLAN ") || line.startsWith("initialized:")) return style.paint(line, "accent");
    if (line.startsWith("result:")) return style.paint(line, statusTone);
    return line;
  });
  return ["", style.title(`Agentbrew · ${result.command}`), style.rule(), ...rendered].join("\n");
}
