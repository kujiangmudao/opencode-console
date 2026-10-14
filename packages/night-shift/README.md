<div align="center">

<img src="assets/banner.svg" alt="opencode-night-shift" width="100%">

**English** · [简体中文](README.zh-CN.md)

[![CI](https://github.com/kujiangmudao/opencode-night-shift/actions/workflows/ci.yml/badge.svg)](https://github.com/kujiangmudao/opencode-night-shift/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode-night-shift?style=flat-square&label=npm)](https://www.npmjs.com/package/opencode-night-shift)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-3c873a?style=flat-square)](#install)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)](#install)
[![for](https://img.shields.io/badge/for-opencode-7c5cff?style=flat-square)](https://opencode.ai)

**Arm one or more opencode sessions, give them an end time, then go to sleep. Night-shift keeps them working — and stops on schedule.**

**[Install](#install) · [Quick start](#quick-start) · [Configuration](#configuration) · [How it works](#how-it-works) · [FAQ](#faq)**

</div>

## Why not "yet another auto-continue"

There are already several auto-continue / loop plugins for opencode (`opencode-auto-resume`, `opencode-loop`, goal-mode plugins). They answer *"don't stop"*. Night-shift answers a different question: **"work a shift for me."**

| | Typical auto-continue / loop | Night-shift |
| --- | --- | --- |
| Stop condition | run forever / until a goal is done | **until an end time** (`endTime`, e.g. `08:30`) |
| Sessions | usually one | **many sessions in one shift**, counted per session |
| Message | fixed "continue" | **template with real-clock anchors** (`{time}` / `{remaining}`) |
| Busy sessions | few handle it | **checked before every send** — never queues into a running turn |
| Completion | global stop | **removes just that session**, the rest keep working |
| Dependencies | varies | **zero** |

Typical use: hand your overnight work to a shift, sleep, and in the morning read `night-shift.log` to see how many times each session was picked up and when the shift ended.

## Features

- **Shift window** — `enabled` + `endTime`; the shift stops globally when the time is reached.
- **Multi-session** — supervise several sessions at once; a completion marker removes only that session.
- **Real-clock anchors** — `{time}` / `{remaining}` are rendered from the actual local clock, which also helps against "it must be morning by now" hallucinations.
- **False-positive guards** — the plugin never reacts to its own messages; `别收工` ("don't stop") does not stop; completion markers are only recognized on the last line (markdown bold and full-width brackets tolerated).
- **Busy-aware** — skips a session while it is `busy`/`retrying` and resumes on the next idle.
- **No session aborts** — the plugin never kills a running turn; stalled-session recovery is left to specialists.
- **Fast checks** — tracks the last assistant message via `message.updated` and fetches only that one (fallback: full list).
- **Tested** — 22 unit tests, CI on Linux + Windows × Node 20/22.

## Install

Requirements: [opencode](https://opencode.ai) (plugin API `@opencode-ai/plugin` 1.18.x), Node ≥ 20. No runtime dependencies.

**Option A — from npm (recommended)**

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-night-shift"]
}
```

**Option B — manual**

Copy `packages/night-shift/src/night-shift.js` (from this repo) into `~/.config/opencode/plugins/` and restart opencode.

Data lives in:

- running from a source checkout → `<checkout>/packages/night-shift/data/`
- installed from npm → `~/.local/share/opencode-night-shift/`

Both can be overridden with `OC_NIGHT_DIR`.

## Quick start

Create (or edit) `night-shift.json` in the data directory — the plugin hot-reloads on file changes, no restart needed:

```json
{
  "enabled": true,
  "endTime": "08:30",
  "message": "Now {time} ({remaining} left).\n\nContinue the task: do not stop, do not wait for user input.\nIf everything is done, review or run tests to verify.\nWhen fully verified, end your last line with: [task done]",
  "sessions": [
    { "id": "ses_your_session_id", "sent": 0, "lastSentAt": 0 }
  ]
}
```

Find session IDs in opencode (they are `ses_...`), or use the optional web dashboard to tick sessions and set the shift.

**Stopping a shift** — any one of:

- the clock reaches `endTime` (global stop)
- a short message starting with a stop phrase in any watched session: `收工` / `先收工吧` / `停止夜班，睡觉了` (`别收工` will not trigger it)
- the model ends its last line with `[夜间任务完成]` / `[task done]` (that session only)

**Watch it work** — `night-shift.log` in the data directory records every continuation, skip reason, and stop.

## Configuration

| Field | Description |
| --- | --- |
| `enabled` | shift on/off |
| `endTime` | local `HH:MM`; global stop at that time |
| `endAt` | absolute epoch ms — optional, derived from `endTime` when omitted |
| `message` | continuation template (`{time}` `{remaining}` supported) |
| `sessions[]` | `{ id, sent, lastSentAt }` per watched session |

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `OC_NIGHT_DIR` | see above | data directory |
| `OC_NIGHT_CONFIG` / `OC_NIGHT_LOG` | inside it | override config / log path |
| `OC_NIGHT_DELAY_MS` | `15000` | wait before sending after a session goes idle |
| `OC_NIGHT_MIN_INTERVAL_MS` | `30000` | minimum gap between two continuations in one session (blocked idles are retried, never dropped) |
| `OC_NIGHT_SHIFT` | — | set to `0` to disable the plugin entirely |

## How it works

<img src="assets/how-it-works.svg" alt="How it works" width="100%">

The plugin subscribes to three event types:

- `session.idle` — is this session armed? was the last turn an error (leave it to a network-recovery plugin)? does it end with a completion marker? if not → send the template after a short delay.
- `session.status` — track `busy`/`retry` per session and re-check right before sending, so a continuation never queues into a running turn.
- `message.updated` — remember the last assistant message id so the check fetches a single message instead of the whole history.

Config I/O is multi-process friendly: BOM tolerance, unknown-field preservation, legacy-format migration, mtime-based hot reload.

## In action

The log is the demo (session ids scrubbed; default log language is Chinese):

```text
# 23:00 — arm two sessions in the dashboard, hit "Start", go to sleep
2026/9/24 23:12:40  跳过：会话正忙（等下次空闲）session=ses_d4e5f6
2026/9/25 00:44:37  续跑完成（该会话第 3 次）session=ses_a1b2c3
2026/9/25 01:31:15  跳过：上一条是错误，交给网络续跑插件 session=ses_d4e5f6
2026/9/25 03:20:09  续跑完成（该会话第 7 次）session=ses_d4e5f6
2026/9/25 05:03:44  停止单个会话 session=ses_a1b2c3：检测到完成标记（还剩 1 个）
2026/9/25 08:30:00  夜班全局停止：结束时间已到
```

Inside the session (the message is a template in any language; `{time}`/`{remaining}` are substituted at send time):

```text
[auto message]  It's 03:20 — keep going. State your progress; end your last line with [task done]
[model]         Finished the 12 unit tests for the orders module (npm test green); all goals for this batch are met.
[model last]    [task done]     ← only the last line counts; the session is dropped from the shift
```

## Use cases

| Situation | What you do |
| --- | --- |
| Overnight refactor or long build/fix loop | arm the session, set `endTime: 08:30`, sleep |
| Several agents running in parallel | arm all of them — each gets its own counter and completion state |
| Want a morning report | read `night-shift.log` (or the dashboard) when you wake up |
| Keep a session alive but stop before a deadline | `endTime` gives you a hard stop instead of an infinite loop |

## Safety

> [!IMPORTANT]
> Night-shift makes **no network requests**, only reads/writes three local files, and **never aborts** a running session. It can, however, send messages into sessions — with a permissive permission setup a continued session may run commands, exactly like a normal user turn. Use the stop phrases or `endTime` if a shift should end early.

## FAQ

- **Does it kill stuck sessions?** No. Recovery for frozen streams belongs to dedicated plugins; night-shift deliberately never aborts your long-running work.
- **Does it upload anything?** No. Local files only.
- **Does it conflict with network-error auto-resume plugins?** No — night-shift skips turns that ended in an error and leaves them to those plugins.
- **Logs and messages are Chinese?** Defaults are Chinese; `message` is a template you can write in any language, and the completion marker accepts `[task done]`.

## Development

```bash
npm test        # node:test — 22 cases
```

```
src/night-shift.js          plugin (zero dependencies)
test/night-shift.test.mjs   unit tests with a mock opencode client
.github/workflows/ci.yml    CI: Linux + Windows × Node 20/22
```

Contributions are welcome. Please keep changes covered by tests and keep `README.md` / `README.zh-CN.md` in sync.

## License

[MIT](LICENSE)
