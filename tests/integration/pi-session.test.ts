// End-to-end against a real pi AgentSession with a scripted (faux) model, so the
// extension contract (agent_before_settle, agent_settled, tools, commands) is pi's, not a mock.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type AssistantMessage,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import aim, { currentGoal, type GoalState } from "../../src/index.ts";

type Step = AssistantMessage | (() => AssistantMessage);

/** Worker steps and evaluator verdicts are scripted separately; the evaluator is recognized by its system prompt. */
async function session(worker: Step[], verdicts: object[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "pi-aim-e2e-"));
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "worker", contextWindow: 200000 }],
  });
  const evaluatorPrompts: string[] = [];
  const respond: FauxResponseFactory = (context) => {
    const system = JSON.stringify(context.messages[0] ?? "");
    if (system.includes("independent verifier")) {
      evaluatorPrompts.push(JSON.stringify(context.messages));
      const verdict = verdicts.shift();
      assert.ok(verdict, "unexpected evaluator call");
      return fauxAssistantMessage(JSON.stringify(verdict));
    }
    const step = worker.shift() ?? fauxAssistantMessage("(script exhausted)");
    return typeof step === "function" ? step() : step;
  };
  faux.setResponses(Array.from({ length: 50 }, () => respond));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(dir, "models-store.json"),
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey("faux", "test");
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    extensionFactories: [aim],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model: faux.getModel(),
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    tools: ["bash", "get_goal", "update_goal"],
    sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  });
  const goal = () =>
    currentGoal({
      sessionManager: session.sessionManager,
    } as never) as GoalState;
  /** Branch summary for assertion messages. */
  const trace = () =>
    session.sessionManager
      .getBranch()
      .map((e: any) =>
        [
          e.type,
          e.message?.role ?? e.customType,
          JSON.stringify(e.message?.content ?? e.data ?? "").slice(0, 200),
        ].join(" "),
      )
      .join("\n");
  return {
    dir,
    session,
    goal,
    trace,
    evaluatorPrompts,
    async close() {
      session.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const bash = (command: string) =>
  fauxAssistantMessage(fauxToolCall("bash", { command }), {
    stopReason: "toolUse",
  });
const claim = (status: string, reason = "done") =>
  fauxAssistantMessage(fauxToolCall("update_goal", { status, reason }), {
    stopReason: "toolUse",
  });
const say = (text: string) => fauxAssistantMessage(text);

test("e2e: work, verified completion, loop stops", async () => {
  const s = await session(
    [bash("printf hi > a.txt && cat a.txt"), claim("complete"), say("Done.")],
    [{ status: "verified", reason: "cat shows hi" }],
  );
  try {
    await s.session.prompt("/goal Create a.txt containing hi");
    await s.session.waitForIdle();
    assert.equal(s.goal().status, "complete", s.trace());
    assert.equal(await readFile(join(s.dir, "a.txt"), "utf8"), "hi");
    assert.match(s.evaluatorPrompts[0]!, /printf hi > a\.txt/);
  } finally {
    await s.close();
  }
});

test("e2e: rejected claim keeps the goal active and work continues across turns", async () => {
  const s = await session(
    [
      claim("complete", "trust me"),
      say("Ending this turn."),
      // Next run comes from the continuation prompt.
      bash("printf hi > a.txt && cat a.txt"),
      claim("complete"),
      say("Done."),
    ],
    [
      { status: "inconclusive", reason: "no evidence" },
      { status: "verified", reason: "cat shows hi" },
    ],
  );
  try {
    await s.session.prompt("/goal Create a.txt containing hi");
    await s.session.waitForIdle();
    assert.equal(s.goal().status, "complete", s.trace());
    assert.equal(s.evaluatorPrompts.length, 2);
  } finally {
    await s.close();
  }
});

test("e2e: Escape pauses the goal and nothing resumes it automatically", async () => {
  let s!: Awaited<ReturnType<typeof session>>;
  s = await session([
    () => {
      void s.session.abort();
      return bash("sleep 5");
    },
    say("hello"),
  ]);
  try {
    await s.session.prompt("/goal Long task");
    await s.session.waitForIdle();
    assert.equal(s.goal().status, "paused");
    assert.equal(s.goal().reason, "interrupted");
    await s.session.prompt("Say hello");
    await s.session.waitForIdle();
    assert.equal(s.goal().status, "paused");
  } finally {
    await s.close();
  }
});

test("e2e: runs without tool work pause the loop", async () => {
  const s = await session([
    say("Thinking."),
    say("Still thinking."),
    say("Hmm."),
  ]);
  try {
    await s.session.prompt("/goal Something");
    await s.session.waitForIdle();
    assert.equal(s.goal().status, "paused");
    assert.match(s.goal().reason!, /no tool work/);
  } finally {
    await s.close();
  }
});
