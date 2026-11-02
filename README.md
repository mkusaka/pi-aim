# pi-aim

Codex-style goals for [pi](https://pi.dev), where completion is checked by an evaluator model instead of trusted from the worker.

## Install

```sh
pi install npm:pi-aim
```

## How it works

- `/goal <objective>` resolves the evaluator model, saves the goal in the session and starts working.
- While the goal is active, every finished run is followed by a continuation prompt, so the agent keeps going across turns.
- The agent calls the `update_goal` tool:
  - `complete`: the evaluator judges the objective against the tool calls and outputs recorded since the goal started (not the agent's own summary). `verified` completes the goal; `incomplete` or `inconclusive` is returned to the agent as an error and work continues. If the evaluation itself fails, the goal is blocked; it is never marked complete without a verdict.
  - `blocked`: the agent is stuck on the same blocker for three turns.
- Escape pauses the goal. Three consecutive runs without any tool work also pause it.
- The footer shows the status and the start of the objective (`goal: active · Migrate the billing service…`). Press `alt+g` to show or hide the full goal above the editor (on macOS the terminal must send Option as Meta).

## Commands

- `/goal <objective>` starts (or replaces) a goal.
- `/goal status` shows the goal and re-checks that the saved evaluator is still available (it is never re-selected).
- `/goal resume` resumes a paused or blocked goal.
- `/goal clear` removes the goal.

```
Goal: Implement authentication
Status: Active
Worker: openai/gpt-6-luna
Evaluator: openai/gpt-6-luna
Evaluator selection: worker
Evaluator reason: same model as worker
Verification: hybrid
```

## Configuration

Optional `~/.pi/agent/pi-aim.json` (or under `PI_CODING_AGENT_DIR`). Defaults:

```json
{
  "verification": {
    "mode": "hybrid",
    "model": "worker",
    "thinkingLevel": "low",
    "timeoutMs": 60000,
    "maxAttempts": 2,
    "failClosed": true
  }
}
```

- `model`: `"worker"` (the model active when the goal starts) or an explicit `"provider/modelId"`. Either must be authenticated, accept text and have a 32k+ context window; otherwise the goal is blocked. The choice is saved and never changes for that goal.
- `mode: "deterministic"` never selects or calls an LLM. Deterministic checks are not implemented yet, so such goals start blocked rather than trusting the agent. `hybrid` and `llm` currently behave the same.
- Invalid settings block the goal instead of falling back to defaults.

## Checking the evaluator prompt against real models

```sh
PI_AIM_LIVE=1 PI_AIM_MODELS=provider/model-id,... bun run test:live
```

## Development

```sh
bun install
bun fmt --check && bun run lint && bun run typecheck && bun run test
```

## Release

Publishing runs from `.github/workflows/publish.yml` with npm trusted publishing (OIDC, no token, automatic provenance).

First release (`0.0.1`):

1. Run the checks above and `npm pack --dry-run`. In a local checkout, temporarily set `version` in `package.json` to `0.0.1-stage.0` and run `npm publish --tag stage` from an authenticated terminal. Restore `0.0.1` without committing the change.
2. On npmjs.com, configure a GitHub Actions trusted publisher with owner `mkusaka`, repository `pi-aim` and workflow filename `publish.yml`. Allow direct `npm publish`.
3. Push tag `v0.0.1` for the release commit within two days of step 2.

The placeholder lets npm create the package before [trusted publishing can be configured](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites); it stays on the `stage` dist-tag, so `latest` starts at `0.0.1`.

Later releases: bump `version`, run `bun install` and the checks, commit, and push the matching `vX.Y.Z` tag. The workflow reruns the checks, verifies that the tag matches `package.json`, and skips versions already on npm.
