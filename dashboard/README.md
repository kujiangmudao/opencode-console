# Console (local dashboard)

A local web console for opencode: the cost ledger, session analytics, night-shift controls, and the session cleanup desk. It reads your local opencode database directly and never makes outbound requests (except the optional CNY rate refresh).

**Requirements:** Node.js **22.5+** (uses the built-in `node:sqlite`), opencode with a local database.

## Start

```bash
node dashboard/server.js          # http://127.0.0.1:8787
# Windows: double-click dashboard\start.bat
```

## What's inside

| Area | What it does |
| --- | --- |
| Cost ledger | DeepSeek official CNY pricing (cache-hit/miss × peak/off-peak), live USD from opencode, switchable display currency, smooth switching animations |
| Rounds | Per-question cost breakdown (steps + subagents attributed to the round), live-updating current round |
| Subagents | Child-session costs folded into the parent session, expandable tree |
| Night shift | Arm sessions, start/stop a shift, watch status — writes the plugin's config file |
| **Cleanup desk** | Size-ranked session list, multi-select, **archive-before-delete**, residual verification, one-click VACUUM |

## Cleanup desk safety

- **Execution requires opencode to be fully closed** (the console detects running `OpenCode*.exe` processes and disables the buttons).
- **Archive first**: each session's cost, tokens, model, directory and per-round detail are written to a permanent local ledger (`dashboard/data/ledger.db`) **before** anything is deleted.
- Totals, daily chart, model shares and directory shares keep counting archived sessions — deleting sessions no longer loses your spending history.
- Deleting a parent session also archives and deletes its subagent subtree.
- **VACUUM** ("紧凑化数据库") rewrites the SQLite file (e.g. 34 GB → 6 GB after heavy deletions). It needs opencode closed and can take minutes on large databases.
- A dev-only escape hatch `OC_CLEANUP_ALLOW_RUNNING=1` bypasses the running-opencode guard (tests only).

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `OCDASH_PORT` | `8787` | HTTP port |
| `OCDASH_DB` | `~/.local/share/opencode/opencode.db` | opencode database path |
| `OCDASH_LEDGER` | `dashboard/data/ledger.db` | cleanup ledger path |
| `OCDASH_CNY_RATE` | — | pin the CNY/USD rate (skip live refresh) |
| `OCDASH_NO_OPEN` | — | do not auto-open the browser |
| `OC_NIGHT_DIR` | `packages/night-shift/data` | the night-shift plugin's data directory |

## Tests

```bash
node --test dashboard/test/cleanup.test.cjs
```

Covers: session listing/sizes, subtree expansion, archive→delete ordering, residual checks, ledger aggregates, rollback, guard, VACUUM, and an end-to-end API run proving totals stay intact after cleanup.

---

# 中文说明（简版）

本地用量控制台：DeepSeek 官方人民币计价账本、按轮次花费、子代理花费合并、夜班控制、**会话清理台**（删除前自动归档进永久账本，总额不丢；执行需完全退出 opencode；支持一键 VACUUM 紧凑化）。需要 Node 22.5+。启动：`node dashboard/server.js`（Windows 双击 `start.bat`）。账本位置：`dashboard/data/ledger.db`（不入 git）。
