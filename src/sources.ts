import type { Context } from "./context.js";
import { bundleSummary, loadBundle, parseLayerArguments, type ResolvedBundle } from "./bundle.js";
import { redact } from "./process.js";
import type { SourceRegistration, SourceRegistrationLayer } from "./source-state.js";

export interface SourceStatus {
  registered: boolean;
  state: "none" | "current" | "changed" | "error";
  layers: Array<{ layer: string; file: string; sha256: string; currentSha256?: string; git?: SourceRegistrationLayer["git"] }>;
  inputHash?: string;
  currentInputHash?: string;
  bundle?: unknown;
  error?: string;
}

export function registrationLayers(registration: SourceRegistration): string[] {
  return parseLayerArguments(registration.layers.map(({ layer, file }) => `${layer}=${file}`))
    .map(({ layer, file }) => `${layer}=${file}`);
}

export function createRegistration(context: Context): { registration: SourceRegistration; bundle: ResolvedBundle } {
  const bundle = loadBundle(context.layers, context);
  if (!bundle) throw new Error("source set requires at least one explicit --layer");
  return {
    registration: {
      schemaVersion: 1,
      kind: "agentbrew-source-registration",
      target: { agentDir: context.agentDir },
      layers: bundle.sources.map(({ layer, file, sha256 }) => ({ layer, file, sha256 })),
      inputHash: bundle.inputHash,
    },
    bundle,
  };
}

export function sourceStatus(context: Context, registration: SourceRegistration | null): SourceStatus {
  if (!registration) return { registered: false, state: "none", layers: [] };
  try {
    const bundle = loadBundle(registrationLayers(registration), context);
    if (!bundle) throw new Error("registered Bundle is empty");
    const current = new Map(bundle.sources.map((source) => [source.layer, source.sha256]));
    const layers = registration.layers.map((layer) => ({
      ...layer,
      ...(current.has(layer.layer) ? { currentSha256: current.get(layer.layer) } : {}),
    }));
    const changed = bundle.inputHash !== registration.inputHash
      || layers.some((layer) => layer.currentSha256 !== layer.sha256);
    return {
      registered: true,
      state: changed ? "changed" : "current",
      layers,
      inputHash: registration.inputHash,
      currentInputHash: bundle.inputHash,
      bundle: bundleSummary(bundle),
    };
  } catch (error) {
    return {
      registered: true,
      state: "error",
      layers: registration.layers,
      inputHash: registration.inputHash,
      error: redact(error instanceof Error ? error.message : String(error)),
    };
  }
}
