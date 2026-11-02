import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import aim, {
  currentGoal,
  type GoalState,
  goalEntryType,
  startGoal,
} from "../../src/index.ts";
import { defaultEvaluatorConfig } from "../../src/verification/evaluator-schema.ts";
import { EvaluatorError, evaluate } from "../../src/verification/evaluator.ts";

const model = (provider: string, id: string) =>
  ({ provider, id, input: ["text"], contextWindow: 272000 }) as any;

const reply = (text: string) => ({
  stopReason: "stop",
  content: [{ type: "text", text }],
});
const failure = (errorMessage: string) => ({
  stopReason: "error",
  errorMessage,
  content: [],
});
const verdict = (status: string, reason = "because") =>
  reply(JSON.stringify({ status, reason }));

function harness(
  available: any[],
  {
    worker = model("openai", "gpt-6-luna"),
    entries = [] as any[],
    replies = [] as any[],
  } = {},
) {
  const notes: string[] = [];
  const sent: any[] = [];
  const prompts: string[] = [];
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const tools = new Map<string, any>();
  const statusBar = { text: undefined as string | undefined };
  const registry = {
    available,
    refreshes: 0,
    refresh: async () => {
      registry.refreshes++;
      return {} as any;
    },
    getError: () => undefined as string | undefined,
    getAvailable: () => registry.available,
    streamSimple: (_model: any, context: any) => {
      prompts.push(context.messages[0].content);
      const next = replies.shift();
      return { result: async () => next };
    },
  };
  const ctx: any = {
    model: worker,
    modelRegistry: registry,
    sessionManager: { getBranch: () => entries },
    ui: {
      notify: (text: string) => notes.push(text),
      setStatus: (_key: string, text: string | undefined) =>
        (statusBar.text = text),
    },
  };
  let command: any;
  aim({
    registerCommand: (_: string, options: any) => (command = options),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: any) => handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
    sendMessage: async (message: any) => {
      sent.push(message);
    },
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: any = {}) =>
    handlers.get(name)?.({ type: name, ...event }, ctx);
  return {
    ctx,
    registry,
    entries,
    notes,
    sent,
    prompts,
    statusBar,
    goal: (args: string) => command.handler(args, ctx),
    tool: (name: string, params: any = {}) =>
      tools.get(name).execute("call", params, undefined, undefined, ctx),
    emit,
    /** One agent run: optional tool work, then settlement. Commits drafts like pi does. */
    async run(
      work: [string, object, string][] = [],
      outcome = "completed",
    ): Promise<any> {
      await emit("agent_start");
      for (const [toolName, args, output] of work) {
        const id = `${toolName}-${entries.length}`;
        await emit("tool_call", { toolName, input: args });
        entries.push({
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", id, name: toolName, arguments: args },
            ],
          },
        });
        entries.push({
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: id,
            toolName,
            isError: false,
            content: [{ type: "text", text: output }],
          },
        });
      }
      const result = await emit("agent_before_settle", {
        outcome,
        entries: [],
        continue: false,
      });
      entries.push(...(result?.entries ?? []));
      return result;
    },
  };
}

async function withConfig(verification: unknown, fn: (path: string) => any) {
  const dir = await mkdtemp(join(tmpdir(), "pi-aim-"));
  try {
    const path = join(dir, "pi-aim.json");
    await writeFile(path, JSON.stringify({ verification }));
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("/goal starts work, shows status, and resolves the worker model as evaluator", async () => {
  const h = harness([
    model("openai", "gpt-6-luna"),
    model("openai", "gpt-5.6-luna"),
  ]);
  await h.goal("Implement authentication");
  const goal = currentGoal(h.ctx)!;
  assert.equal(h.entries[0].customType, goalEntryType);
  assert.equal(goal.status, "active");
  assert.equal(goal.evaluator?.modelId, "gpt-6-luna");
  assert.doesNotMatch(JSON.stringify(goal), /apiKey|headers|secret/i);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].content, /Implement authentication/);
  assert.equal(h.statusBar.text, "goal: active");
  await h.goal("status");
  for (const line of [
    /^Goal: Implement authentication$/m,
    /^Status: Active$/m,
    /^Worker: openai\/gpt-6-luna$/m,
    /^Evaluator: openai\/gpt-6-luna$/m,
    /^Evaluator selection: worker$/m,
    /^Verification: hybrid$/m,
  ])
    assert.match(h.notes.at(-1)!, line);
});

test("Worker変更・Registry更新・再起動後も保存済みモデルを再利用し、消えたら blocked", async () => {
  const h = harness([
    model("openai", "gpt-6-luna"),
    model("anthropic", "claude"),
  ]);
  await h.goal("Ship it");
  const saved = structuredClone(currentGoal(h.ctx));
  h.ctx.model = model("anthropic", "claude");
  h.registry.available = [model("anthropic", "new"), ...h.registry.available];
  await h.goal("status");
  assert.deepEqual(currentGoal(h.ctx), saved);
  assert.match(h.notes.at(-1)!, /Evaluator: openai\/gpt-6-luna/);
  assert.match(h.notes.at(-1)!, /Status: Active/);
  // Restart: a fresh extension instance over the same session entries.
  const restarted = harness(h.registry.available, { entries: h.entries });
  await restarted.emit("session_start");
  assert.equal(restarted.statusBar.text, "goal: active");
  await restarted.goal("status");
  assert.deepEqual(currentGoal(restarted.ctx), saved);
  assert.match(restarted.notes.at(-1)!, /Status: Active/);
  // Model retired or credentials revoked.
  h.registry.available = [model("anthropic", "claude")];
  await h.goal("status");
  assert.match(h.notes.at(-1)!, /Status: Blocked \(Saved evaluator/);
});

test("評価モデルが利用不能・Registry不調・不正設定 → blocked で開始しない", async () => {
  const h = harness([model("openai", "gpt-6-luna")]);
  const unavailable: GoalState = await withConfig(
    { model: "anthropic/claude" },
    (path) => startGoal(h.ctx, "Do work", path),
  );
  assert.equal(unavailable.status, "blocked");
  assert.match(unavailable.reason!, /not available/);
  const invalid: GoalState = await withConfig({ model: "luna" }, (path) =>
    startGoal(h.ctx, "x", path),
  );
  assert.match(invalid.reason!, /Invalid .*pi-aim\.json/);
  h.registry.getError = () => "models.json is invalid";
  await h.goal("Do work");
  assert.match(currentGoal(h.ctx)!.reason!, /Model registry unavailable/);
  assert.equal(h.sent.length, 0);
});

test("明示指定ならWorkerモデル未選択でも開始できる", async () => {
  const h = harness([model("anthropic", "claude")]);
  h.ctx.model = undefined;
  const goal: GoalState = await withConfig(
    { model: "anthropic/claude" },
    (path) => startGoal(h.ctx, "x", path),
  );
  assert.equal(goal.status, "active");
  assert.equal(goal.worker, "unknown");
});

test("Deterministic-only → LLMを選ばず、自己申告で完了しないよう blocked", async () => {
  const h = harness([]);
  const goal: GoalState = await withConfig({ mode: "deterministic" }, (path) =>
    startGoal(h.ctx, "x", path),
  );
  assert.equal(goal.evaluator, null);
  assert.equal(goal.status, "blocked");
  assert.equal(h.registry.refreshes, 0);
});

test("active goal は run 終了時に継続し、verified で complete になり止まる", async () => {
  const h = harness([model("openai", "gpt-6-luna")], {
    replies: [verdict("verified", "tests pass")],
  });
  await h.goal("Make tests pass");
  const result = await h.run([
    ["bash", { command: "npm test" }, "# pass 42\n# fail 0"],
  ]);
  assert.equal(result.continue, true);
  assert.equal(h.entries.at(-1).type, "custom_message");
  await h.tool("get_goal");
  const done = await h.tool("update_goal", {
    status: "complete",
    reason: "npm test passes",
  });
  assert.match(done.content[0].text, /Goal complete/);
  assert.equal(currentGoal(h.ctx)!.status, "complete");
  assert.equal(h.statusBar.text, undefined);
  // The evaluator saw real tool output, not goal tool chatter.
  assert.match(h.prompts[0]!, /npm test[\s\S]*# fail 0/);
  assert.doesNotMatch(h.prompts[0]!, /get_goal/);
  assert.equal(await h.run([["bash", {}, "x"]]), undefined);
});

test("incomplete / inconclusive → 完了を拒否し、active のまま継続", async () => {
  const h = harness([model("openai", "gpt-6-luna")], {
    replies: [verdict("incomplete", "2 tests fail")],
  });
  await h.goal("Make tests pass");
  await assert.rejects(
    h.tool("update_goal", { status: "complete", reason: "done" }),
    /not accepted \(incomplete\): 2 tests fail/,
  );
  assert.equal(currentGoal(h.ctx)!.status, "active");
  assert.equal((await h.run([["bash", {}, "x"]])).continue, true);
});

test("Evaluator失敗 → blocked（fail closed）で継続しない", async () => {
  const h = harness([model("openai", "gpt-6-luna")], {
    replies: [reply("looks good"), reply("still prose")],
  });
  await h.goal("Make tests pass");
  await assert.rejects(
    h.tool("update_goal", { status: "complete", reason: "done" }),
    /Evaluation failed; goal blocked/,
  );
  assert.equal(currentGoal(h.ctx)!.status, "blocked");
  assert.equal(await h.run([["bash", {}, "x"]]), undefined);
});

test("Workerの blocked 申告で停止し、/goal resume で再開", async () => {
  const h = harness([model("openai", "gpt-6-luna")]);
  await h.goal("Deploy");
  await h.tool("update_goal", { status: "blocked", reason: "needs creds" });
  assert.equal(currentGoal(h.ctx)!.reason, "needs creds");
  assert.equal(h.statusBar.text, "goal: blocked");
  await h.goal("resume");
  assert.equal(currentGoal(h.ctx)!.status, "active");
  assert.equal(currentGoal(h.ctx)!.reason, undefined);
  assert.equal(h.sent.length, 2);
});

test("Escape で中断 → paused、自動では再開しない", async () => {
  const h = harness([model("openai", "gpt-6-luna")]);
  await h.goal("Refactor");
  // pi skips agent_before_settle for aborted runs and reports it on agent_settled.
  await h.emit("agent_settled", { aborted: true });
  assert.equal(currentGoal(h.ctx)!.status, "paused");
  assert.equal(currentGoal(h.ctx)!.reason, "interrupted");
  assert.match(h.sent.at(-1).content, /paused the goal/);
  assert.equal(h.statusBar.text, "goal: paused");
  assert.equal(await h.run([["bash", {}, "x"]]), undefined);
});

test("却下後に作業せず完了申告を繰り返しても Evaluator を呼ばない", async () => {
  const h = harness([model("openai", "gpt-6-luna")], {
    replies: [verdict("inconclusive", "no proof"), verdict("verified", "ok")],
  });
  await h.goal("Make tests pass");
  const claim = { status: "complete", reason: "done" };
  await assert.rejects(h.tool("update_goal", claim), /inconclusive/);
  await assert.rejects(h.tool("update_goal", claim), /No new work/);
  assert.equal(h.prompts.length, 1);
  await h.run([["bash", { command: "npm test" }, "# fail 0"]]);
  await h.tool("update_goal", claim);
  assert.equal(currentGoal(h.ctx)!.status, "complete");
});

test("ツール作業のない run が3回続くと paused", async () => {
  const h = harness([model("openai", "gpt-6-luna")]);
  await h.goal("Refactor");
  assert.equal((await h.run()).continue, true);
  assert.equal((await h.run([["get_goal", {}, "{}"]])).continue, true);
  await h.run();
  assert.match(currentGoal(h.ctx)!.reason!, /no tool work in 3/);
});

test("/goal clear で goal を消す", async () => {
  const h = harness([model("openai", "gpt-6-luna")]);
  await h.goal("x");
  await h.goal("clear");
  assert.equal(currentGoal(h.ctx), null);
  assert.equal(h.statusBar.text, undefined);
});

function scripted(replies: any[]) {
  const calls: string[] = [];
  return {
    calls,
    streamSimple: (m: any) => {
      calls.push(`${m.provider}/${m.id}`);
      const next = replies.shift();
      return { result: async () => next };
    },
  } as any;
}

const input = { objective: "o", workerClaim: "done", evidence: "e" };

test("Evaluatorの不正JSON → 規定回数再試行後に停止", async () => {
  const registry = scripted([reply("looks good!"), reply('{"status":"ok"}')]);
  await assert.rejects(
    evaluate(registry, model("openai", "e"), input, defaultEvaluatorConfig),
    EvaluatorError,
  );
  assert.equal(registry.calls.length, defaultEvaluatorConfig.maxAttempts);
});

test("Provider障害 → 同一モデルで再試行し、別モデルへ切り替えない", async () => {
  const registry = scripted([
    failure("503 Service Unavailable"),
    verdict("incomplete", "tests fail"),
  ]);
  const result = await evaluate(
    registry,
    model("openai", "e"),
    input,
    defaultEvaluatorConfig,
  );
  assert.equal(result.status, "incomplete");
  assert.deepEqual(registry.calls, ["openai/e", "openai/e"]);

  const down = scripted([failure("503 Service Unavailable"), failure("503")]);
  await assert.rejects(
    evaluate(down, model("openai", "e"), input, defaultEvaluatorConfig),
    EvaluatorError,
  );
  assert.deepEqual(down.calls, ["openai/e", "openai/e"]);
});

test("恒久エラー（認証失効など）は再試行せず停止", async () => {
  const registry = scripted([failure("401 Unauthorized: invalid api key")]);
  await assert.rejects(
    evaluate(registry, model("openai", "e"), input, defaultEvaluatorConfig),
    EvaluatorError,
  );
  assert.equal(registry.calls.length, 1);
});
