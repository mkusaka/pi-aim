import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultEvaluatorConfig,
  parseEvaluation,
  parseEvaluatorConfig,
} from "../../src/verification/evaluator-schema.ts";

test("config defaults and overrides", () => {
  assert.deepEqual(parseEvaluatorConfig(undefined), defaultEvaluatorConfig);
  assert.equal(
    parseEvaluatorConfig({ model: "anthropic/claude-haiku-4-5" }).model,
    "anthropic/claude-haiku-4-5",
  );
});

test("config rejects invalid values instead of defaulting", () => {
  for (const bad of [
    null,
    [],
    { model: "haiku" },
    { mode: "fast" },
    { thinkingLevel: "xhigh" },
    { timeoutMs: 0 },
    { maxAttempts: 1.5 },
    { allowWorkerFallback: "yes" },
    { failClosed: false },
    { modle: "auto" },
  ])
    assert.throws(() => parseEvaluatorConfig(bad), JSON.stringify(bad));
});

test("evaluation parsing accepts only the exact shape", () => {
  assert.deepEqual(parseEvaluation('{"status":"verified","reason":"ok"}'), {
    status: "verified",
    reason: "ok",
  });
  assert.deepEqual(
    parseEvaluation('```json\n{"status":"incomplete","reason":"x"}\n```'),
    { status: "incomplete", reason: "x" },
  );
  for (const bad of [
    "",
    "verified",
    '{"status":"success","reason":"ok"}',
    '{"status":"verified"}',
    '{"status":"verified","reason":" "}',
    '{"status":"verified","reason":"ok","extra":1}',
    'Sure! {"status":"verified","reason":"ok"}',
    '[{"status":"verified","reason":"ok"}]',
  ])
    assert.equal(parseEvaluation(bad), undefined, bad);
});
