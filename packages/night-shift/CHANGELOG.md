# Changelog

## 0.2.0

Reinforcements: mechanical guards on top of the prompt layer.

- **Completion evidence gate** (`evidence: "strict"`, default): the completion marker must be paired with an `[夜间任务证据]` / `[task evidence]` line right above it (one-line summary: what was done, how it was verified). A claim without evidence does not end the session — it gets exactly one nudge (sent through the normal throttled queue) and stays watched. `evidence: "loose"` restores the 0.1.x marker-only behavior.
- **Idle-turn detection** (`idleTurns`, default 3): counts consecutive turns with no tool calls and no real output; at the threshold the continuation prompt is escalated, and at 2× the session is paused (`paused: true` in the config) so a lazy night waits for a human instead of burning tokens.
- **Turn trace**: one structured log line per turn (`轮次留痕 … fp=… changed=yes|no`) — the morning read shows where progress actually happened.
- **Goal-engine yield** (`yieldToGoals`, default true): steps aside when `.opencode/goals` exists for the session's project (a goal plugin is active) and resumes when it is gone. Best-effort overlap guard only — never arm the same session in two continuation plugins.
- **Config**: new top-level fields `evidence`, `idleTurns`, `yieldToGoals`; session entries gained `paused`.
- Default `message` template updated to the two-line evidence protocol; READMEs updated; tests grew to 37.

## 0.1.0

Initial release.

- **Shift model**: auto-continue armed sessions until an end time (`endTime` / `endAt`), then stop.
- **Multi-session supervision**: one shift can watch several sessions; completion removes only that session.
- **Real-time anchors**: `{time}` and `{remaining}` placeholders are replaced with the real local clock — no more "it must be morning" hallucinations.
- **Busy-aware**: never injects a continuation while a session is busy or retrying.
- **Completion detection**: a `[夜间任务完成]` / `[task done]` marker on the last line ends that session (markdown bold and full-width brackets tolerated).
- **False-positive guards**: echo guard for self-sent messages; stop phrases require a leading stop word, a short message and no negation ("别收工" does not stop).
- **Robust config**: legacy single-session migration, BOM tolerance, unknown-field preservation, `endAt` derived from `endTime` when omitted.
- **Performance**: tracks the last assistant message via `message.updated` and fetches only that message (with a full-list fallback).
- Zero dependencies, 22 tests, CI on Linux + Windows.
- Bilingual README (English + 简体中文) with a design banner, a how-it-works diagram and a use-case table.
