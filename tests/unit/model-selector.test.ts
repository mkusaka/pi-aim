import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultEvaluatorConfig,
  type EvaluatorConfig,
} from "../../src/verification/evaluator-schema.ts";
import {
  type ModelInfo,
  ModelResolutionError,
  resolveEvaluator,
  restoreEvaluator,
} from "../../src/verification/model-selector.ts";

const model = (
  provider: string,
  id: string,
  extra: Partial<ModelInfo> = {},
): ModelInfo => ({
  provider,
  id,
  input: ["text"],
  contextWindow: 200000,
  ...extra,
});
const worker = { provider: "anthropic", id: "claude-x" };
const resolve = (
  available: ModelInfo[],
  overrides: Partial<EvaluatorConfig> = {},
) =>
  resolveEvaluator(
    { ...defaultEvaluatorConfig, ...overrides },
    worker,
    available,
    new Date("2026-11-02T12:00:00Z"),
  );
const blocks = (fn: () => unknown) => assert.throws(fn, ModelResolutionError);

test("default uses the worker model, whatever the provider", () => {
  assert.deepEqual(
    resolve([model("openai", "gpt"), model("anthropic", "claude-x")]),
    {
      requested: "worker",
      provider: "anthropic",
      modelId: "claude-x",
      thinkingLevel: "low",
      selectionSource: "worker",
      reason: "same model as worker",
      resolvedAt: "2026-11-02T12:00:00.000Z",
    },
  );
});

test("explicit model is used as configured", () => {
  const resolved = resolve(
    [model("anthropic", "claude-x"), model("openrouter", "vendor/model")],
    { model: "openrouter/vendor/model" },
  );
  assert.equal(resolved?.selectionSource, "explicit");
  assert.equal(resolved?.provider, "openrouter");
  assert.equal(resolved?.modelId, "vendor/model");
});

test("unavailable or unsuitable model blocks instead of falling back", () => {
  blocks(() => resolve([model("openai", "gpt")]));
  blocks(() =>
    resolve([model("anthropic", "claude-x")], { model: "openai/gpt" }),
  );
  blocks(() =>
    resolve([model("anthropic", "claude-x", { contextWindow: 8000 })]),
  );
  blocks(() => resolve([model("anthropic", "claude-x", { input: ["image"] })]));
});

test("deterministic mode selects no LLM", () => {
  assert.equal(resolve([], { mode: "deterministic" }), undefined);
});

test("saved evaluator is reused after registry changes, blocked once gone", () => {
  const saved = resolve([model("anthropic", "claude-x")])!;
  const updated = [
    model("anthropic", "claude-y"),
    model("anthropic", "claude-x"),
  ];
  assert.equal(restoreEvaluator(saved, updated).id, "claude-x");
  assert.throws(
    () => restoreEvaluator(saved, [model("anthropic", "claude-y")]),
    ModelResolutionError,
  );
});
