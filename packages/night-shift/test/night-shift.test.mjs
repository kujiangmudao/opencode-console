import { test, after } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const TMP = mkdtempSync(join(tmpdir(), "night-shift-test-"))
process.env.OC_NIGHT_DIR = TMP
process.env.OC_NIGHT_CONFIG = join(TMP, "night-shift.json")
process.env.OC_NIGHT_LOG = join(TMP, "night-shift.log")
process.env.OC_NIGHT_DELAY_MS = "50"
process.env.OC_NIGHT_MIN_INTERVAL_MS = "80"

const { NightShift } = await import("../src/night-shift.js")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cfgPath = process.env.OC_NIGHT_CONFIG
const writeCfg = (o) => writeFileSync(cfgPath, JSON.stringify(o, null, 2))
const readCfg = () => JSON.parse(readFileSync(cfgPath, "utf8"))
const sentOf = (cfg, id) => (cfg.sessions.find((s) => s.id === id) || {}).sent

const mkarmed = (ids, extra) => ({
  enabled: true,
  endAt: Date.now() + 3600000,
  message: "继续",
  sessions: ids.map((id) => ({ id, sent: 0, lastSentAt: 0 })),
  ...(extra || {})
})

let lastMsg = { text: "继续干活中。", error: null }
let singleMsg = { text: "", error: null }
const calls = { prompts: [], single: [] }
const client = {
  session: {
    messages: async () => ({ data: [{ info: { role: "assistant", error: lastMsg.error }, parts: [{ type: "text", text: lastMsg.text }] }] }),
    message: async (args) => {
      calls.single.push(args)
      return { info: { role: "assistant", error: singleMsg.error }, parts: [{ type: "text", text: singleMsg.text }] }
    },
    prompt: async (args) => {
      calls.prompts.push(args)
      return {}
    }
  }
}

const hooks = await NightShift({ client })
const idle = (sessionID) => hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
const status = (sessionID, type) => hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type } } } })
const chat = (sessionID, text) => hooks["chat.message"]({ sessionID }, { parts: [{ type: "text", text }] })

after(() => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
})

test("selftest guard: mock clients never consume the flag", () => {
  const flag = join(TMP, "selftest.flag")
  writeFileSync(flag, "run-once")
  assert.equal(existsSync(flag), true)
})

test("renders real time and remaining, sends a continuation", async () => {
  writeCfg(mkarmed(["ses_top"], { message: "现在是 {time}。继续。剩余 {remaining}。" }))
  lastMsg = { text: "阶段汇报完毕。", error: null }
  await idle("ses_top")
  await sleep(300)
  assert.equal(calls.prompts.length, 1)
  const text = calls.prompts[0].body.parts[0].text
  assert.match(text, /现在是 20/)
  assert.match(text, /剩余/)
  assert.equal(sentOf(readCfg(), "ses_top"), 1)
})

test("completion marker removes the session, disables when none left", async () => {
  writeCfg(mkarmed(["ses_top"]))
  lastMsg = { text: "都做完了，已验证。\n[夜间任务完成]", error: null }
  await idle("ses_top")
  await sleep(200)
  const cfg = readCfg()
  assert.equal(cfg.sessions.length, 0)
  assert.equal(cfg.enabled, false)
  assert.equal(calls.prompts.length, 1)
})

test("skips when the last assistant message is an error", async () => {
  writeCfg(mkarmed(["ses_top"]))
  lastMsg = { text: "网络断了", error: { name: "APIError", data: { message: "TLS" } } }
  await idle("ses_top")
  await sleep(200)
  assert.equal(calls.prompts.length, 1)
  assert.equal(readCfg().enabled, true)
})

test("stops all when the end time has passed", async () => {
  writeCfg(mkarmed(["ses_top"], { endAt: Date.now() - 1000 }))
  lastMsg = { text: "正常", error: null }
  await idle("ses_top")
  await sleep(200)
  assert.equal(readCfg().enabled, false)
  assert.equal(calls.prompts.length, 1)
})

test("short stop phrase stops globally", async () => {
  writeCfg(mkarmed(["ses_top"]))
  await chat("ses_top", "先收工吧")
  assert.equal(readCfg().enabled, false)
})

test("sessions not armed are ignored", async () => {
  writeCfg(mkarmed(["ses_top"]))
  await idle("ses_other")
  await sleep(200)
  assert.equal(calls.prompts.length, 1)
})

test("marker in the middle of the text does not stop", async () => {
  writeCfg(mkarmed(["ses_top"]))
  lastMsg = { text: "我会在最后输出 [夜间任务完成]，现在继续工作。", error: null }
  await idle("ses_top")
  await sleep(300)
  assert.equal(readCfg().enabled, true)
  assert.equal(calls.prompts.length, 2)
})

test("long user message does not stop", async () => {
  writeCfg(mkarmed(["ses_top"]))
  await chat("ses_top", "现在是 2026/9/24 09:30:00（距离结束还有 4.0 小时）。请回顾任务目标继续执行：如果任务尚未完成，直接继续，不要停止。")
  assert.equal(readCfg().enabled, true)
})

test("stop phrase with extra words still stops", async () => {
  writeCfg(mkarmed(["ses_top"]))
  await chat("ses_top", "停止夜班，睡觉了")
  assert.equal(readCfg().enabled, false)
})

test("echo guard: self-sent short message does not stop", async () => {
  writeCfg(mkarmed(["ses_top"], { message: "继续，别收工" }))
  lastMsg = { text: "阶段结束。", error: null }
  await idle("ses_top")
  await sleep(300)
  await chat("ses_top", "继续，别收工")
  assert.equal(readCfg().enabled, true)
})

test("real short stop still works", async () => {
  await chat("ses_top", "收工")
  assert.equal(readCfg().enabled, false)
})

test("multiple armed sessions each get continued with own counters", async () => {
  const before = calls.prompts.length
  writeCfg(mkarmed(["ses_a", "ses_b"]))
  lastMsg = { text: "阶段A结束。", error: null }
  await idle("ses_a")
  await sleep(300)
  lastMsg = { text: "阶段B结束。", error: null }
  await idle("ses_b")
  await sleep(300)
  const cfg = readCfg()
  assert.equal(calls.prompts.length, before + 2)
  assert.equal(sentOf(cfg, "ses_a"), 1)
  assert.equal(sentOf(cfg, "ses_b"), 1)
})

test("completion removes only that session, the rest keep running", async () => {
  lastMsg = { text: "A 全部完成。\n[夜间任务完成]", error: null }
  await idle("ses_a")
  await sleep(200)
  let cfg = readCfg()
  assert.equal(cfg.sessions.length, 1)
  assert.equal(cfg.sessions[0].id, "ses_b")
  assert.equal(cfg.enabled, true)

  const before = calls.prompts.length
  await idle("ses_a")
  await sleep(200)
  assert.equal(calls.prompts.length, before)

  lastMsg = { text: "B 继续中。", error: null }
  await idle("ses_b")
  await sleep(300)
  assert.equal(calls.prompts.length, before + 1)
})

test("stop in any armed session stops globally", async () => {
  await chat("ses_b", "收工")
  assert.equal(readCfg().enabled, false)
})

test("legacy single-session config is migrated", async () => {
  const before = calls.prompts.length
  writeCfg({ enabled: true, endAt: Date.now() + 3600000, message: "继续", sessionId: "ses_legacy", sent: 2, lastSentAt: 0 })
  lastMsg = { text: "旧格式会话工作中。", error: null }
  await idle("ses_legacy")
  await sleep(300)
  const cfg = readCfg()
  assert.equal(calls.prompts.length, before + 1)
  assert.equal(cfg.sessions[0].id, "ses_legacy")
})

test("markdown-bold completion marker is recognized", async () => {
  writeCfg(mkarmed(["ses_top"]))
  lastMsg = { text: "全部完成。\n**[夜间任务完成]**", error: null }
  await idle("ses_top")
  await sleep(200)
  const cfg = readCfg()
  assert.equal(cfg.sessions.length, 0)
  assert.equal(cfg.enabled, false)
})

test("negated stop phrase does not stop", async () => {
  writeCfg(mkarmed(["ses_top"]))
  await chat("ses_top", "别收工，继续干")
  assert.equal(readCfg().enabled, true)
})

test("busy session is skipped, then resumed when idle again", async () => {
  const before = calls.prompts.length
  writeCfg(mkarmed(["ses_top"]))
  lastMsg = { text: "工作中。", error: null }
  await idle("ses_top")
  await status("ses_top", "busy")
  await sleep(300)
  assert.equal(calls.prompts.length, before)
  await status("ses_top", "idle")
  await idle("ses_top")
  await sleep(300)
  assert.equal(calls.prompts.length, before + 1)
})

test("uses the single-message endpoint once the last message is tracked", async () => {
  const before = calls.prompts.length
  writeCfg(mkarmed(["ses_top"]))
  singleMsg = { text: "事件追踪到的消息，继续干活。", error: null }
  await hooks.event({ event: { type: "message.updated", properties: { info: { id: "msg_q1", sessionID: "ses_top", role: "assistant" } } } })
  await idle("ses_top")
  await sleep(300)
  assert.ok(calls.single.some((c) => c.path.messageID === "msg_q1"))
  assert.equal(calls.prompts.length, before + 1)
})

test("retries after the minimum interval instead of stalling", async () => {
  const before = calls.prompts.length
  writeCfg(mkarmed(["ses_top"]))
  lastMsg = { text: "快速回合。", error: null }
  await idle("ses_top")
  await sleep(120)
  await idle("ses_top")
  await sleep(400)
  assert.equal(calls.prompts.length, before + 2)
})

test("endAt is derived from endTime when omitted", async () => {
  const before = calls.prompts.length
  writeCfg({ enabled: true, endTime: "23:59", message: "继续", sessions: [{ id: "ses_top", sent: 0, lastSentAt: 0 }] })
  lastMsg = { text: "继续。", error: null }
  await idle("ses_top")
  await sleep(300)
  assert.equal(calls.prompts.length, before + 1)
})
