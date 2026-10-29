export const RESULT_SCHEMA_VERSION = 1;

export type CommandName = "inspect" | "diff" | "doctor" | "update" | "init" | "apply" | "explain" | "adopt" | "resolve" | "source";
export type Ownership = "observe" | "adopt" | "manage" | "generate";
export type ChangeState = "none" | "observed" | "unknown";
export type OverallStatus = "success" | "partial" | "unhealthy" | "failed" | "cancelled" | "not-executed";
export type EnvironmentClass = "empty" | "healthy" | "repairable" | "damaged" | "unknown";
export type InitMode = "observe" | "adopt" | "repair" | "manage" | "fresh";

export interface InitResource {
  id: string;
  description: string;
  sideEffect: string;
  required: boolean;
}

export interface PlanHost {
  dir: string;
  version: string;
  source: "managed" | "path" | "npm-global";
}

export interface InitAssessment {
  classification: EnvironmentClass;
  host: PlanHost | null;
  manifest: { dependencies: Record<string, string> } | null;
  resources: InitResource[];
  freshEligible: boolean;
  issues: string[];
  fingerprint: string;
}

export type InitAction =
  | "record-ownership"
  | "repair-pi-links"
  | "normalize-pi-dependencies"
  | "install-minimal-pi"
  | "generate-herdr-integration";

export interface InitPlan {
  schemaVersion: 1;
  kind: "agentbrew-init-plan";
  target: Target;
  classification: EnvironmentClass;
  mode: InitMode;
  resources: string[];
  host: PlanHost | null;
  actions: InitAction[];
  assessmentHash: string;
}
export type StepStatus = "planned" | "success" | "failed" | "skipped";

export interface Target {
  agentDir: string;
}

export interface Difference {
  resource: string;
  kind: string;
  expected: string;
  actual: string;
}

export interface HealthCheck {
  resource: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export interface StepResult {
  id: string;
  label: string;
  status: StepStatus;
  changes: ChangeState;
  message?: string;
}

export interface CommandResult<T = unknown> {
  schemaVersion: number;
  command: CommandName;
  status: OverallStatus;
  target: Target;
  changes: ChangeState;
  steps: StepResult[];
  differences: Difference[];
  checks: HealthCheck[];
  data?: T;
  error?: string;
}

export interface ContextOptions {
  agentDir?: string;
  stateDir?: string;
  dryRun?: boolean;
  selftest?: boolean;
  layers?: string[];
}

export function combineChanges(steps: StepResult[]): ChangeState {
  if (steps.some((step) => step.changes === "observed")) return "observed";
  if (steps.some((step) => step.changes === "unknown")) return "unknown";
  return "none";
}

export function successfulStep(id: string, label: string, changes: ChangeState = "none", message?: string): StepResult {
  return { id, label, status: "success", changes, ...(message ? { message } : {}) };
}

export function failedStep(id: string, label: string, error: unknown, changes: ChangeState = "unknown"): StepResult {
  const message = error instanceof Error ? error.message : String(error);
  return { id, label, status: "failed", changes, message };
}

export function skippedStep(id: string, label: string, message: string): StepResult {
  return { id, label, status: "skipped", changes: "none", message };
}
