import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  EvaluatorConfig,
  ModelSelection,
  ThinkingLevel,
} from "./evaluator-schema.ts";

export type ModelInfo = Pick<
  Model<Api>,
  "provider" | "id" | "input" | "contextWindow"
>;

export interface ResolvedEvaluator {
  requested: ModelSelection;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  selectionSource: "worker" | "explicit";
  /** Human-readable explanation of the choice. */
  reason: string;
  resolvedAt: string;
}

export class ModelResolutionError extends Error {
  override name = "ModelResolutionError";
}

/** Context the evaluation prompt needs; smaller windows are never used. */
export const minContextWindow = 32000;

const key = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

/** `available` must already be limited to models with working credentials. */
export function isUsable(model: ModelInfo) {
  return (
    model.input.includes("text") && model.contextWindow >= minContextWindow
  );
}

/** Returns undefined in deterministic mode, where no LLM is used. */
export function resolveEvaluator(
  config: EvaluatorConfig,
  worker: Pick<ModelInfo, "provider" | "id"> | undefined,
  available: readonly ModelInfo[],
  now = new Date(),
): ResolvedEvaluator | undefined {
  if (config.mode === "deterministic") return undefined;
  if (config.model === "worker" && !worker)
    throw new ModelResolutionError("No worker model is selected");
  const wanted = config.model === "worker" ? key(worker!) : config.model;
  const label = config.model === "worker" ? `worker model ${wanted}` : wanted;
  // Compare whole keys: some providers (e.g. openrouter) use "/" inside model IDs.
  const model = available.find((m) => key(m) === wanted);
  if (!model)
    throw new ModelResolutionError(
      `Evaluator ${label} is not available with current credentials`,
    );
  if (!isUsable(model))
    throw new ModelResolutionError(
      `Evaluator ${label} lacks text input or a ${minContextWindow}-token context window`,
    );
  return {
    requested: config.model,
    provider: model.provider,
    modelId: model.id,
    thinkingLevel: config.thinkingLevel,
    selectionSource: config.model === "worker" ? "worker" : "explicit",
    reason:
      config.model === "worker"
        ? "same model as worker"
        : `explicitly configured as ${wanted}`,
    resolvedAt: now.toISOString(),
  };
}

/** A saved evaluator is reused as-is; if it is no longer usable the goal is blocked, never re-selected. */
export function restoreEvaluator<T extends ModelInfo>(
  saved: ResolvedEvaluator,
  available: readonly T[],
): T {
  const model = available.find(
    (m) => m.provider === saved.provider && m.id === saved.modelId,
  );
  if (!model || !isUsable(model))
    throw new ModelResolutionError(
      `Saved evaluator ${saved.provider}/${saved.modelId} is no longer available`,
    );
  return model;
}
