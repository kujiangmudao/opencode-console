# OpenCode Console

A small, dependency-free toolkit for [opencode](https://opencode.ai): a night-shift session supervisor and a local usage console.

| Component | What it is | Where |
| --- | --- | --- |
| **Night Shift** | opencode plugin — keeps armed sessions working while you sleep, then clocks off at an end time. Multi-session, busy-aware, completion markers, zero dependencies, 22 tests. | [`packages/night-shift/`](packages/night-shift/) · npm `opencode-night-shift` (coming soon) |
| **Console** | Local web console — a cost ledger with DeepSeek official CNY pricing (cache- and peak-aware), per-round cost attribution, subagent roll-up, session analytics and night-shift controls. Reads your local opencode data only; no network calls. | [`dashboard/`](dashboard/) |

## Quick start

Night Shift (plugin):

```bash
# in this repo
cp packages/night-shift/src/night-shift.js ~/.config/opencode/plugins/
# restart opencode; then arm sessions via the console or the config file
```

Console (dashboard):

```bash
node dashboard/server.js          # then open http://127.0.0.1:8787
# on Windows: dashboard\start.bat
```

## Status

- **Night Shift** — `v0.1.0` tagged, CI green (Linux + Windows × Node 20/22); npm publishing soon.
- **Console** — open-source hardening in progress (auto-detected paths, schema checks, provider boundary).

## License

MIT
