import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

function defaultDataDir() {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..")
    if (existsSync(join(root, ".git")) || existsSync(join(root, "test"))) return join(root, "data")
  } catch {}
  return join(homedir(), ".local", "share", "opencode-night-shift")
}

function computeEndAt(endTime) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(endTime || ""))
  if (!m) return 0
  const d = new Date()
  d.setHours(Number(m[1]), Number(m[2]), 0, 0)
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
  return d.getTime()
}

const PROJECT_DIR = process.env.OC_NIGHT_DIR || defaultDataDir()
const CONFIG_FILE = process.env.OC_NIGHT_CONFIG || join(PROJECT_DIR, "night-shift.json")
const LOG_FILE = process.env.OC_NIGHT_LOG || join(PROJECT_DIR, "night-shift.log")
const DELAY_MS = Number(process.env.OC_NIGHT_DELAY_MS || 15000)
const MIN_INTERVAL_MS = Number(process.env.OC_NIGHT_MIN_INTERVAL_MS || 30000)

const DEFAULT_MESSAGE = [
  "现在是 {time}（距离结束还有 {remaining}）。",
  "",
  "请回顾任务目标继续执行：如果任务尚未完成，直接继续，不要停止、不要等待用户输入。",
  "如果你认为已经完成：请自行 review 或运行测试验证一遍，确认无误再结束。",
  "只有当你确认全部完成且验证通过时，才在最后单独输出一行：[夜间任务完成]"
].join("\n")

function fileLog(line) {
  try {
    mkdirSync(PROJECT_DIR, { recursive: true })
    appendFileSync(LOG_FILE, new Date().toLocaleString("zh-CN", { hour12: false }) + "  " + line + "\n")
  } catch {}
}

let cache = { mtime: 0, data: null }

function normalize(raw) {
  const def = { enabled: false, endTime: "08:30", endAt: 0, message: DEFAULT_MESSAGE, sessions: [] }
  if (!raw || typeof raw !== "object") return def
  let sessions = []
  if (Array.isArray(raw.sessions)) {
    sessions = raw.sessions
      .filter((s) => s && typeof s.id === "string" && s.id)
      .map((s) => ({ id: s.id, sent: Number(s.sent) || 0, lastSentAt: Number(s.lastSentAt) || 0 }))
  } else if (typeof raw.sessionId === "string" && raw.sessionId) {
    sessions = [{ id: raw.sessionId, sent: Number(raw.sent) || 0, lastSentAt: Number(raw.lastSentAt) || 0 }]
  }
  return {
    enabled: !!raw.enabled,
    endTime: String(raw.endTime || def.endTime),
    endAt: Number(raw.endAt) || computeEndAt(String(raw.endTime || def.endTime)),
    message: typeof raw.message === "string" && raw.message ? raw.message : def.message,
    sessions
  }
}

function readConfig() {
  try {
    const st = statSync(CONFIG_FILE)
    if (st.mtimeMs !== cache.mtime || !cache.data) {
      cache = { mtime: st.mtimeMs, data: normalize(JSON.parse(readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, ""))) }
    }
    return cache.data
  } catch {
    return null
  }
}

function writeConfig(cfg) {
  try {
    mkdirSync(PROJECT_DIR, { recursive: true })
    let raw = {}
    try { raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, "")) } catch {}
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {}
    writeFileSync(CONFIG_FILE, JSON.stringify({ ...raw, ...cfg, updatedAt: Date.now() }, null, 2))
    cache = { mtime: 0, data: null }
    return true
  } catch {
    return false
  }
}

function render(text, cfg) {
  const now = new Date()
  const time = now.toLocaleString("zh-CN", { hour12: false })
  const remain = Math.max(0, Number(cfg.endAt || 0) - now.getTime())
  const remText = remain >= 3600000 ? (remain / 3600000).toFixed(1) + " 小时" : Math.max(1, Math.round(remain / 60000)) + " 分钟"
  return String(text || DEFAULT_MESSAGE).replace(/\{time\}/g, time).replace(/\{remaining\}/g, remText)
}

function completedBy(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return false
  const last = lines[lines.length - 1]
    .replace(/[*_`~]/g, "")
    .replace(/【/g, "[")
    .replace(/】/g, "]")
    .trim()
  return /^\[(夜间任务完成|任务完成|task done|night shift done)\]$/i.test(last)
}

export const NightShift = async ({ client }) => {
  if (process.env.OC_NIGHT_SHIFT === "0") {
    fileLog("插件已禁用（OC_NIGHT_SHIFT=0）")
    return {}
  }

  const state = new Map()
  fileLog("插件已加载（夜班自动续跑·多会话）")

  function stOf(sessionID) {
    let st = state.get(sessionID)
    if (!st) {
      st = { sending: false, sentAt: 0, lastSentText: "", busy: false, lastMsgId: "", retryTimer: null }
      state.set(sessionID, st)
    }
    return st
  }

  function stopAll(reason) {
    const cur = readConfig()
    if (cur) writeConfig({ ...cur, enabled: false })
    fileLog("夜班全局停止：" + reason)
  }

  function removeSession(sessionID, reason) {
    const cur = readConfig()
    if (!cur) return
    const sessions = cur.sessions.filter((s) => s.id !== sessionID)
    writeConfig({ ...cur, enabled: sessions.length > 0 ? cur.enabled : false, sessions })
    fileLog("停止单个会话 session=" + sessionID + "：" + reason + "（还剩 " + sessions.length + " 个）")
  }

  function bumpSession(sessionID, fields) {
    const cur = readConfig()
    if (!cur) return null
    const sessions = cur.sessions.map((s) => (s.id === sessionID ? { ...s, ...fields } : s))
    writeConfig({ ...cur, sessions })
    return sessions.find((s) => s.id === sessionID) || null
  }

  function textOf(parts) {
    return (parts || [])
      .filter((p) => p && p.type === "text")
      .map((p) => p.text || "")
      .join("\n")
  }

  async function lastAssistant(sessionID) {
    const st = stOf(sessionID)
    if (st.lastMsgId) {
      try {
        const r = await client.session.message({ path: { id: sessionID, messageID: st.lastMsgId } })
        const item = r && r.data ? r.data : r
        if (item && item.info && item.info.role === "assistant") {
          return { text: textOf(item.parts), hasError: !!item.info.error }
        }
      } catch {}
    }
    try {
      const r = await client.session.messages({ path: { id: sessionID } })
      const list = r && r.data ? r.data : r
      if (!Array.isArray(list)) return { text: "", hasError: false }
      for (let i = list.length - 1; i >= 0; i--) {
        const item = list[i]
        if (item && item.info && item.info.role === "assistant") {
          return { text: textOf(item.parts), hasError: !!item.info.error }
        }
      }
      return { text: "", hasError: false }
    } catch {
      return { text: "", hasError: false }
    }
  }

  function schedule(sessionID) {
    const st = stOf(sessionID)
    if (st.sending) return
    const since = Date.now() - st.sentAt
    if (since < MIN_INTERVAL_MS) {
      if (!st.retryTimer) {
        st.retryTimer = setTimeout(() => {
          st.retryTimer = null
          schedule(sessionID)
        }, MIN_INTERVAL_MS - since + 100)
      }
      return
    }
    st.sending = true
    setTimeout(() => {
      const fresh = readConfig()
      if (!fresh || !fresh.enabled) {
        st.sending = false
        return
      }
      const entry = fresh.sessions.find((s) => s.id === sessionID)
      if (!entry) {
        st.sending = false
        return
      }
      if (st.busy) {
        fileLog("跳过：会话正忙（等下次空闲）session=" + sessionID)
        st.sending = false
        return
      }
      if (Date.now() >= fresh.endAt) {
        stopAll("结束时间已到")
        st.sending = false
        return
      }
      const text = render(fresh.message, fresh)
      st.lastSentText = text.trim()
      const bumped = bumpSession(sessionID, { sent: entry.sent + 1, lastSentAt: Date.now() })
      const sent = bumped ? bumped.sent : "?"
      client.session
        .prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } })
        .then(() => fileLog("续跑完成（该会话第 " + sent + " 次）session=" + sessionID))
        .catch((e) => fileLog("续跑发送失败 session=" + sessionID + "：" + String((e && e.message) || e)))
      st.sentAt = Date.now()
      st.sending = false
    }, DELAY_MS)
  }

  function infoOf(r) {
    if (!r) return {}
    if (r.data && r.data.info) return r.data.info
    if (r.data && r.data.id) return r.data
    if (r.info) return r.info
    return r
  }

  async function selfTest() {
    if (!client.session || typeof client.session.create !== "function") return
    const flag = join(PROJECT_DIR, "selftest.flag")
    if (!existsSync(flag)) return
    try { unlinkSync(flag) } catch { return }
    fileLog("自检开始（验证发消息通道与模型继承）")
    let sid = null
    try {
      const created = await client.session.create({ body: { title: "night-shift-selftest" } })
      sid = infoOf(created).id
      if (!sid) throw new Error("创建测试会话失败：" + JSON.stringify(created).slice(0, 200))
      fileLog("自检: 测试会话 " + sid)

      const r1 = await client.session.prompt({
        path: { id: sid },
        body: { agent: "build", model: { providerID: "deepseek", modelID: "deepseek-v4-flash-vision-exp" }, parts: [{ type: "text", text: "只回复一个字母：A" }] }
      })
      const i1 = infoOf(r1)
      fileLog("自检1 带模型发送 -> " + JSON.stringify({ modelID: i1.modelID, providerID: i1.providerID, variant: i1.variant, agent: i1.agent }))

      const r2 = await client.session.prompt({
        path: { id: sid },
        body: { parts: [{ type: "text", text: "只回复一个字母：B" }] }
      })
      const i2 = infoOf(r2)
      fileLog("自检2 不带模型发送 -> " + JSON.stringify({ modelID: i2.modelID, providerID: i2.providerID, variant: i2.variant, agent: i2.agent }))
      const inherit = i1.modelID === i2.modelID && i1.providerID === i2.providerID
      fileLog("自检结论A: " + (inherit ? "不带模型会继承会话模型（续跑可不带模型）" : "警告：不带模型会切换模型，需要修改插件显式带模型"))

      const r3 = await client.session.prompt({
        path: { id: sid },
        body: { agent: "build", model: { providerID: "deepseek", modelID: "deepseek-v4-flash-vision-exp" }, variant: "max", parts: [{ type: "text", text: "只回复一个字母：C" }] }
      })
      const i3 = infoOf(r3)
      fileLog("自检3 指定 variant=max -> " + JSON.stringify({ modelID: i3.modelID, variant: i3.variant }))
      fileLog("自检结论B: " + (i3.variant === "max" ? "接口支持指定 variant=max" : "接口不支持指定 variant（返回 " + String(i3.variant) + "），续跑档位只能靠继承"))
    } catch (e) {
      fileLog("自检失败: " + String((e && e.message) || e))
    }
    if (sid) {
      try {
        await client.session.delete({ path: { id: sid } })
        fileLog("自检: 测试会话已删除")
      } catch (e) {
        fileLog("自检: 删除测试会话失败 " + String((e && e.message) || e))
      }
    }
    fileLog("自检结束")
  }

  selfTest().catch(() => {})

  return {
    event: async ({ event }) => {
      if (!event) return
      if (event.type === "message.updated") {
        const info = event.properties && event.properties.info
        if (info && info.role === "assistant" && info.sessionID && info.id) {
          stOf(info.sessionID).lastMsgId = info.id
        }
        return
      }
      if (event.type === "session.status") {
        const sid = event.properties && event.properties.sessionID
        const status = event.properties && event.properties.status
        if (!sid || !status) return
        const st = stOf(sid)
        st.busy = status.type === "busy" || status.type === "retry"
        return
      }
      if (event.type !== "session.idle") return
      const sessionID = event.properties && event.properties.sessionID
      if (!sessionID) return
      const cfg = readConfig()
      if (!cfg || !cfg.enabled) return
      if (!cfg.sessions.some((s) => s.id === sessionID)) return
      if (Date.now() >= cfg.endAt) {
        stopAll("结束时间已到")
        return
      }
      const last = await lastAssistant(sessionID)
      if (last.hasError) {
        fileLog("跳过：上一条是错误，交给网络续跑插件 session=" + sessionID)
        return
      }
      if (completedBy(last.text)) {
        removeSession(sessionID, "检测到完成标记")
        return
      }
      schedule(sessionID)
    },
    "chat.message": async (input, output) => {
      const sessionID = input && input.sessionID
      if (!sessionID) return
      const cfg = readConfig()
      if (!cfg || !cfg.enabled) return
      if (!cfg.sessions.some((s) => s.id === sessionID)) return
      const text = ((output && output.parts) || [])
        .filter((p) => p && p.type === "text")
        .map((p) => p.text || "")
        .join("\n")
      const trimmed = text.trim()
      const st = stOf(sessionID)
      if (st.lastSentText && trimmed === st.lastSentText) return
      const t = trimmed.replace(/[!！。.\s]+$/g, "")
      const stopStart = /^(先)?(收工|停止夜班|停止夜间|结束夜班|关掉夜班)/
      const neg = /别|不要|还没|没有|未|不用/
      if (t.length <= 20 && stopStart.test(t) && !neg.test(t)) {
        stopAll("用户要求收工（session=" + sessionID + "）")
      }
    }
  }
}
