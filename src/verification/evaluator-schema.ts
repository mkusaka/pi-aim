export type ModelSelection = "worker" | `${string}/${string}`;
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface EvaluatorConfig {
  mode: "hybrid" | "llm" | "deterministic";
  model: ModelSelection;
  thinkingLevel: ThinkingLevel;
  timeoutMs: number;
  maxAttempts: number;
  failClosed: true;
}

export const defaultEvaluatorConfig: EvaluatorConfig = {
  mode: "hybrid",
  model: "worker",
  thinkingLevel: "low",
  timeoutMs: 60000,
  maxAttempts: 2,
  failClosed: true,
};

const modes = ["hybrid", "llm", "deterministic"];
const thinkingLevels = ["off", "minimal", "low", "medium", "high"];

/** Validate the `verification` section of a settings file. Throws on anything unexpected. */
export function parseEvaluatorConfig(raw: unknown): EvaluatorConfig {
  if (raw === undefined) return defaultEvaluatorConfig;
  if (!isRecord(raw)) throw new Error("verification must be an object");
  const config = { ...defaultEvaluatorConfig, ...raw };
  const unknown = Object.keys(raw).filter(
    (key) => !(key in defaultEvaluatorConfig),
  );
  if (unknown.length)
    throw new Error(`Unknown verification keys: ${unknown.join(", ")}`);
  if (!modes.includes(config.mode as string))
    throw new Error(`verification.mode must be one of ${modes.join(", ")}`);
  if (
    config.model !== "worker" &&
    !(typeof config.model === "string" && /^[^/]+\/.+$/.test(config.model))
  )
    throw new Error(
      'verification.model must be "worker" or "provider/modelId"',
    );
  if (!thinkingLevels.includes(config.thinkingLevel as string))
    throw new Error(
      `verification.thinkingLevel must be one of ${thinkingLevels.join(", ")}`,
    );
  if (!isPositiveInteger(config.timeoutMs))
    throw new Error("verification.timeoutMs must be a positive integer");
  if (!isPositiveInteger(config.maxAttempts))
    throw new Error("verification.maxAttempts must be a positive integer");
  if (config.failClosed !== true)
    throw new Error("verification.failClosed must be true");
  return config;
}

export type EvaluationStatus = "verified" | "incomplete" | "inconclusive";

export interface Evaluation {
  status: EvaluationStatus;
  reason: string;
}

const statuses = ["verified", "incomplete", "inconclusive"];

/** Parse the evaluator's reply. Returns undefined for anything that is not exactly the expected JSON. */
export function parseEvaluation(text: string): Evaluation | undefined {
  // Models sometimes wrap JSON in a code fence; nothing else is tolerated.
  const json = text
    .trim()
    .replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, "$1")
    .trim();
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !statuses.includes(value.status as string) ||
    typeof value.reason !== "string" ||
    !value.reason.trim()
  )
    return undefined;
  return { status: value.status as EvaluationStatus, reason: value.reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown) {
  return Number.isInteger(value) && (value as number) > 0;
}
