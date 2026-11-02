import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { ModelResolutionError } from "./model-selector.ts";

export type Registry = Pick<
  ModelRegistry,
  "refresh" | "getError" | "getAvailable"
>;

/** Step A: models Pi can call right now with configured credentials. */
export async function listAvailableModels(
  registry: Registry,
): Promise<Model<Api>[]> {
  try {
    await registry.refresh();
  } catch (error) {
    throw new ModelResolutionError(
      `Model registry refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const error = registry.getError();
  if (error)
    throw new ModelResolutionError(`Model registry unavailable: ${error}`);
  return registry.getAvailable();
}
