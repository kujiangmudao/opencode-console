# Changelog

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
