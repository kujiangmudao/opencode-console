const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const { spawn } = require("node:child_process")
const { DatabaseSync } = require("node:sqlite")

const PORT = Number(process.env.OCDASH_PORT || 8787)
const HOST = "127.0.0.1"
const DB_PATH = process.env.OCDASH_DB || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
const INDEX = path.join(__dirname, "index.html")
const LIVE_MS = 5 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const CNY_FALLBACK = 7.2

let cny = { rate: CNY_FALLBACK, source: "fallback", updatedAt: 0 }

const NIGHT_PROJECT_DIR = process.env.OC_NIGHT_DIR || "D:/MY_PROJECT/good_night/packages/night-shift/data"
const NIGHT_FILE = path.join(NIGHT_PROJECT_DIR, "night-shift.json")
const NIGHT_DEFAULT_MESSAGE = [
  "现在是 {time}（距离结束还有 {remaining}）。",
  "",
  "请回顾任务目标继续执行：如果任务尚未完成，直接继续，不要停止、不要等待用户输入。",
  "如果你认为已经完成：请自行 review 或运行测试验证一遍，确认无误再结束。",
  "只有当你确认全部完成且验证通过时，才在最后单独输出一行：[夜间任务完成]"
].join("\n")

function readNightStored() {
  const def = { enabled: false, endTime: "08:30", endAt: 0, message: NIGHT_DEFAULT_MESSAGE, sessions: [] }
  try {
    const j = JSON.parse(fs.readFileSync(NIGHT_FILE, "utf8").replace(/^\uFEFF/, ""))
    let sessions = []
    if (Array.isArray(j.sessions)) {
      sessions = j.sessions
        .filter((s) => s && typeof s.id === "string" && s.id)
        .map((s) => ({ id: s.id, sent: Number(s.sent) || 0, lastSentAt: Number(s.lastSentAt) || 0 }))
    } else if (typeof j.sessionId === "string" && j.sessionId) {
      sessions = [{ id: j.sessionId, sent: Number(j.sent) || 0, lastSentAt: Number(j.lastSentAt) || 0 }]
    }
    return {
      enabled: !!j.enabled,
      endTime: String(j.endTime || def.endTime),
      endAt: Number(j.endAt) || 0,
      message: typeof j.message === "string" && j.message ? j.message : def.message,
      sessions
    }
  } catch {
    return def
  }
}

function nightView() {
  const s = readNightStored()
  const totalSent = s.sessions.reduce((a, x) => a + x.sent, 0)
  const lastSentAt = s.sessions.reduce((a, x) => Math.max(a, x.lastSentAt), 0)
  return { ...s, totalSent, lastSentAt }
}

function writeNight(cfg) {
  try {
    fs.mkdirSync(NIGHT_PROJECT_DIR, { recursive: true })
    let raw = {}
    try { raw = JSON.parse(fs.readFileSync(NIGHT_FILE, "utf8").replace(/^\uFEFF/, "")) } catch {}
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {}
    fs.writeFileSync(NIGHT_FILE, JSON.stringify({ ...raw, ...cfg }, null, 2))
    return true
  } catch {
    return false
  }
}

function computeEndAt(endTime) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(endTime || ""))
  if (!m) return 0
  const d = new Date()
  d.setHours(Number(m[1]), Number(m[2]), 0, 0)
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
  return d.getTime()
}

let db

function openDb() {
  if (db) return db
  db = new DatabaseSync(DB_PATH, { readOnly: true })
  try { db.exec("pragma busy_timeout = 3000") } catch {}
  return db
}

function statSize(p) {
  try { return fs.statSync(p).size } catch { return 0 }
}

async function refreshRate() {
  const fixed = Number(process.env.OCDASH_CNY_RATE || 0)
  if (fixed > 0) {
    cny = { rate: fixed, source: "fixed", updatedAt: Date.now() }
    return
  }
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(8000) })
    const j = await res.json()
    const v = j && j.rates && j.rates.CNY
    if (typeof v === "number" && v > 0) cny = { rate: v, source: "live", updatedAt: Date.now() }
  } catch {}
}

function localDay(ms) {
  const d = new Date(ms)
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0")
}

function parseModel(raw) {
  if (!raw) return { providerID: "", modelID: "", variant: "" }
  try {
    const o = JSON.parse(raw)
    return { providerID: o.providerID || "", modelID: o.id || o.modelID || "", variant: o.variant || "" }
  } catch {
    return { providerID: "", modelID: raw, variant: "" }
  }
}

function modelLabel(m) {
  const base = (m.providerID ? m.providerID + "/" : "") + (m.modelID || "?")
  return m.variant ? base + " · " + m.variant : base
}

function emptyBucket() {
  return { cost: 0, usd: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, sessions: 0 }
}

function addTo(b, s) {
  const input = s.tokens_input || 0
  const output = s.tokens_output || 0
  const reasoning = s.tokens_reasoning || 0
  const cacheRead = s.tokens_cache_read || 0
  const cacheWrite = s.tokens_cache_write || 0
  b.cost += s.__cny !== undefined ? s.__cny : (s.cost || 0) * cny.rate
  b.usd += s.cost || 0
  b.input += input
  b.output += output
  b.reasoning += reasoning
  b.cacheRead += cacheRead
  b.cacheWrite += cacheWrite
  b.tokens += input + output + reasoning + cacheRead + cacheWrite
  b.sessions += 1
  return b
}

function sessionTokens(s) {
  return (s.tokens_input || 0) + (s.tokens_output || 0) + (s.tokens_reasoning || 0) + (s.tokens_cache_read || 0) + (s.tokens_cache_write || 0)
}

function sessionRow(s, now) {
  const m = parseModel(s.model)
  return {
    id: s.id,
    parentID: s.parent_id,
    title: s.title,
    directory: s.directory,
    agent: s.agent,
    model: modelLabel(m),
    providerID: m.providerID,
    modelID: m.modelID,
    variant: m.variant,
    cost: s.__cny !== undefined ? s.__cny : (s.cost || 0) * cny.rate,
    usd: s.cost || 0,
    byDay: s.__byDay || {},
    input: s.tokens_input || 0,
    output: s.tokens_output || 0,
    reasoning: s.tokens_reasoning || 0,
    cacheRead: s.tokens_cache_read || 0,
    cacheWrite: s.tokens_cache_write || 0,
    tokens: sessionTokens(s),
    timeCreated: s.time_created,
    timeUpdated: s.time_updated,
    ageMs: now - s.time_updated
  }
}

function parseMessage(data, fallbackTime) {
  try {
    const o = JSON.parse(data)
    if (o.role !== "assistant") return null
    const t = o.tokens || {}
    const c = t.cache || {}
    const tokens = (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (c.read || 0) + (c.write || 0)
    return {
      time: (o.time && o.time.created) || fallbackTime,
      cost: o.cost || 0,
      tokens,
      input: t.input || 0,
      output: t.output || 0,
      reasoning: t.reasoning || 0,
      cacheRead: c.read || 0,
      cacheWrite: c.write || 0,
      modelID: o.modelID || "",
      providerID: o.providerID || "",
      variant: o.variant || "",
      agent: o.agent || ""
    }
  } catch {
    return null
  }
}

const DS_PRICES = {
  flash: { hit: { peak: 0.04, off: 0.02 }, miss: { peak: 2, off: 1 }, out: { peak: 8, off: 4 } },
  pro: { hit: { peak: 0.3, off: 0.15 }, miss: { peak: 9, off: 4.5 }, out: { peak: 27, off: 13.5 } }
}

function priceFor(modelID) {
  const id = String(modelID || "").toLowerCase()
  if (id.includes("deepseek-v4-pro")) return DS_PRICES.pro
  if (id.includes("deepseek")) return DS_PRICES.flash
  return null
}

function isPeak(ms) {
  const d = new Date(ms + 8 * 3600 * 1000)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false
  const h = d.getUTCHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

function cnyFromMessage(m, modelID, time) {
  const p = priceFor(modelID || m.modelID)
  if (!p) return null
  const peak = isPeak(time || m.time)
  const hit = peak ? p.hit.peak : p.hit.off
  const miss = peak ? p.miss.peak : p.miss.off
  const out = peak ? p.out.peak : p.out.off
  return (m.input / 1e6) * miss + (m.cacheRead / 1e6) * hit + ((m.output + m.reasoning) / 1e6) * out
}

function stepCost(x) {
  const c = cnyFromMessage(x, null, x.time)
  return c === null ? x.cost * cny.rate : c
}

const costCache = new Map()

function emptyDay() {
  return { cost: 0, usd: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, tokens: 0 }
}

function sessionCost(d, s) {
  const cached = costCache.get(s.id)
  if (cached && cached.timeUpdated === s.time_updated) return cached
  let cnySum = 0
  let count = 0
  const byDay = {}
  const rows = d.prepare("select data, time_created from message where session_id = ?").all(s.id)
  for (const r of rows) {
    const m = parseMessage(r.data, r.time_created)
    if (!m) continue
    if (m.tokens <= 0 && m.cost <= 0) continue
    count++
    const c = cnyFromMessage(m, null, m.time)
    const cost = c === null ? m.cost * cny.rate : c
    cnySum += cost
    const day = localDay(m.time)
    const b = byDay[day] || (byDay[day] = emptyDay())
    b.cost += cost
    b.usd += m.cost || 0
    b.input += m.input
    b.output += m.output
    b.reasoning += m.reasoning
    b.cacheRead += m.cacheRead
    b.cacheWrite += m.cacheWrite
    b.tokens += m.tokens
  }
  if (count === 0) {
    cnySum = (s.cost || 0) * cny.rate
    byDay[localDay(s.time_updated)] = {
      cost: cnySum,
      usd: s.cost || 0,
      input: s.tokens_input || 0,
      output: s.tokens_output || 0,
      reasoning: s.tokens_reasoning || 0,
      cacheRead: s.tokens_cache_read || 0,
      cacheWrite: s.tokens_cache_write || 0,
      tokens: sessionTokens(s)
    }
  }
  const entry = { timeUpdated: s.time_updated, cost: cnySum, byDay }
  costCache.set(s.id, entry)
  return entry
}

const SESSION_COLS = "id, parent_id, directory, title, model, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated"

function collect() {
  const d = openDb()
  const sessions = d.prepare("select " + SESSION_COLS + " from session").all()

  const now = Date.now()
  const today = localDay(now)
  const yesterday = localDay(now - DAY_MS)
  const month = today.slice(0, 7)

  const totals = { today: emptyBucket(), yesterday: emptyBucket(), month: emptyBucket(), all: emptyBucket() }
  const models = new Map()
  const dirs = new Map()
  const dayTotals = new Map()
  const daySessions = new Map()
  const monthSessions = new Set()

  for (const s of sessions) {
    const sc = sessionCost(d, s)
    s.__cny = sc.cost
    s.__byDay = sc.byDay
    addTo(totals.all, s)
    for (const [day, b] of Object.entries(sc.byDay)) {
      let db = dayTotals.get(day)
      if (!db) { db = emptyBucket(); dayTotals.set(day, db) }
      db.cost += b.cost
      db.usd += b.usd
      db.input += b.input
      db.output += b.output
      db.reasoning += b.reasoning
      db.cacheRead += b.cacheRead
      db.cacheWrite += b.cacheWrite
      db.tokens += b.tokens
      daySessions.set(day, (daySessions.get(day) || 0) + 1)
      if (day.slice(0, 7) === month) monthSessions.add(s.id)
    }

    const m = parseModel(s.model)
    const key = m.providerID + "/" + m.modelID + "|" + m.variant
    if (!models.has(key)) models.set(key, { ...m, label: modelLabel(m), bucket: emptyBucket(), lastUpdate: 0 })
    const entry = models.get(key)
    addTo(entry.bucket, s)
    if (s.time_updated > entry.lastUpdate) entry.lastUpdate = s.time_updated

    const dir = s.directory || "(未知)"
    if (!dirs.has(dir)) dirs.set(dir, emptyBucket())
    addTo(dirs.get(dir), s)
  }

  const byModel = [...models.values()]
    .map((x) => ({ label: x.label, providerID: x.providerID, modelID: x.modelID, variant: x.variant, lastUpdate: x.lastUpdate, ...x.bucket }))
    .sort((a, b) => b.cost - a.cost)

  const byDirectory = [...dirs.entries()]
    .map(([directory, b]) => ({ directory, ...b }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 8)

  for (const [day, db] of dayTotals) db.sessions = daySessions.get(day) || 0
  totals.today = dayTotals.get(today) || emptyBucket()
  totals.yesterday = dayTotals.get(yesterday) || emptyBucket()
  for (const [day, db] of dayTotals) {
    if (day.slice(0, 7) !== month) continue
    totals.month.cost += db.cost
    totals.month.usd += db.usd
    totals.month.input += db.input
    totals.month.output += db.output
    totals.month.reasoning += db.reasoning
    totals.month.cacheRead += db.cacheRead
    totals.month.cacheWrite += db.cacheWrite
    totals.month.tokens += db.tokens
  }
  totals.month.sessions = monthSessions.size

  const dailyList = []
  for (let i = 13; i >= 0; i--) {
    const day = localDay(now - i * DAY_MS)
    dailyList.push({ day, ...(dayTotals.get(day) || emptyBucket()) })
  }

  const sorted = [...sessions].sort((a, b) => b.time_updated - a.time_updated)
  const live = sorted
    .filter((s) => now - s.time_updated <= LIVE_MS)
    .slice(0, 6)
    .map((s) => sessionRow(s, now))

  const sessionList = sorted.map((s) => sessionRow(s, now))

  const recentSession = live[0] || (sorted[0] ? { id: sorted[0].id, title: sorted[0].title, timeUpdated: sorted[0].time_updated } : null)
  let steps = []
  if (recentSession) {
    const rows = d.prepare("select data, time_created from message where session_id = ? order by time_created desc limit 40").all(recentSession.id)
    steps = rows
      .map((r) => parseMessage(r.data, r.time_created))
      .filter(Boolean)
      .filter((x) => x.tokens > 0 || x.cost > 0)
      .map((x) => ({ ...x, cost: stepCost(x), usd: x.cost }))
      .slice(0, 12)
      .reverse()
  }

  return {
    ok: true,
    generatedAt: now,
    cny,
    night: nightView(),
    db: { path: DB_PATH, sizeBytes: statSize(DB_PATH), walBytes: statSize(DB_PATH + "-wal") },
    totals,
    live,
    recent: { session: recentSession, steps },
    byModel,
    byDirectory,
    daily: dailyList,
    sessions: sessionList
  }
}

function bucketize(points, unit) {
  if (!points.length) return []
  const step = unit === "hour" ? 3600000 : 86400000
  const keyOf = (ms) => {
    if (unit === "hour") return Math.floor(ms / 3600000) * 3600000
    const d = new Date(ms)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const map = new Map()
  for (const p of points) {
    const k = keyOf(p.t)
    const b = map.get(k) || { t: k, cost: 0, usd: 0, tokens: 0, count: 0 }
    b.cost += p.cost
    b.usd += (p.m && p.m.cost) || 0
    b.tokens += p.tokens
    b.count += 1
    map.set(k, b)
  }
  const keys = [...map.keys()].sort((a, b) => a - b)
  const out = []
  for (let t = keys[0]; t <= keys[keys.length - 1] && out.length < 600; t += step) {
    const b = map.get(t)
    out.push(b || { t, cost: 0, usd: 0, tokens: 0, count: 0 })
  }
  return out
}

function sessionDetail(id) {
  const d = openDb()
  const s = d.prepare("select " + SESSION_COLS + " from session where id = ?").get(id)
  if (!s) return null
  const sc = sessionCost(d, s)
  s.__cny = sc.cost
  s.__byDay = sc.byDay
  const now = Date.now()
  const rows = d.prepare("select id, data, time_created from message where session_id = ? order by time_created").all(id)
  const textByMsg = new Map()
  for (const p of d.prepare("select p.message_id mid, p.data pdata from part p join message m on m.id = p.message_id where p.session_id = ? and json_extract(m.data,'$.role') = 'user'").all(id)) {
    try {
      const pd = JSON.parse(p.pdata)
      if (pd.type !== "text" || !pd.text) continue
      const prev = textByMsg.get(p.mid)
      textByMsg.set(p.mid, prev ? prev + " " + pd.text : pd.text)
    } catch {}
  }
  const points = []
  for (const r of rows) {
    const m = parseMessage(r.data, r.time_created)
    if (!m) continue
    if (m.tokens <= 0 && m.cost <= 0) continue
    points.push({ t: m.time, cost: stepCost(m), tokens: m.tokens, m })
  }
  const steps = points.slice(-40).reverse().map((p) => ({ ...p.m, cost: p.cost, usd: p.m.cost }))

  const rounds = []
  let cur = null
  for (const r of rows) {
    let o
    try { o = JSON.parse(r.data) } catch { continue }
    if (o.role === "user") {
      const text = String(textByMsg.get(r.id) || "").replace(/\s+/g, " ").trim().slice(0, 120)
      cur = { t: (o.time && o.time.created) || r.time_created, prompt: text, cost: 0, usd: 0, tokens: 0, stepCount: 0, steps: [], kids: { count: 0, cost: 0, usd: 0, items: [] } }
      rounds.push(cur)
      continue
    }
    if (o.role !== "assistant") continue
    const m = parseMessage(r.data, r.time_created)
    if (!m) continue
    if (m.tokens <= 0 && m.cost <= 0) continue
    if (!cur) {
      cur = { t: m.time, prompt: null, cost: 0, usd: 0, tokens: 0, stepCount: 0, steps: [], kids: { count: 0, cost: 0, usd: 0, items: [] } }
      rounds.push(cur)
    }
    const sk = stepCost(m)
    cur.cost += sk
    cur.usd += m.cost
    cur.tokens += m.tokens
    cur.stepCount++
    cur.steps.push({ t: m.time, cost: sk, usd: m.cost, tokens: m.tokens, providerID: m.providerID, modelID: m.modelID, variant: m.variant })
  }
  for (const r of rounds) if (r.steps.length > 120) r.steps = r.steps.slice(-120)
  const childRows = d.prepare("select " + SESSION_COLS + " from session where parent_id = ?").all(id)
  for (const k of childRows) {
    const kc = sessionCost(d, k)
    let idx = -1
    for (let i = 0; i < rounds.length; i++) {
      const end = i + 1 < rounds.length ? rounds[i + 1].t : Infinity
      if (k.time_created >= rounds[i].t && k.time_created < end) { idx = i; break }
    }
    if (idx < 0) idx = rounds.length ? 0 : -1
    if (idx < 0) continue
    const rd = rounds[idx]
    rd.kids.count++
    rd.kids.cost += kc.cost
    rd.kids.usd += k.cost || 0
    if (rd.kids.items.length < 50) {
      rd.kids.items.push({ id: k.id, title: k.title || "", cost: kc.cost, usd: k.cost || 0, tokens: sessionTokens(k), timeCreated: k.time_created })
    }
  }

  return {
    ok: true,
    generatedAt: now,
    cny,
    session: sessionRow(s, now),
    steps,
    rounds: rounds.slice(-60),
    series: {
      hourly: bucketize(points, "hour"),
      daily: bucketize(points, "day")
    }
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://" + HOST + ":" + PORT)
  if (u.pathname === "/" || u.pathname === "/index.html") {
    fs.readFile(INDEX, (err, buf) => {
      if (err) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
        res.end("index.html not found")
        return
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      res.end(buf)
    })
    return
  }
  if (u.pathname === "/api/usage") {
    try {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
      res.end(JSON.stringify(collect()))
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e), generatedAt: Date.now() }))
    }
    return
  }
  if (u.pathname === "/api/session") {
    try {
      const detail = sessionDetail(u.searchParams.get("id") || "")
      if (!detail) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" })
        res.end(JSON.stringify({ ok: false, error: "session not found" }))
        return
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
      res.end(JSON.stringify(detail))
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
    }
    return
  }
  if (u.pathname === "/api/night" && req.method === "POST") {
    let body = ""
    req.on("data", (c) => {
      body += c
      if (body.length > 1e6) req.destroy()
    })
    req.on("end", () => {
      try {
        const input = JSON.parse(body || "{}")
        const cur = readNightStored()
        if (input.action === "start") {
          const ids = Array.isArray(input.sessionIds)
            ? input.sessionIds.filter((x) => typeof x === "string" && x)
            : (typeof input.sessionId === "string" && input.sessionId ? [input.sessionId] : [])
          if (!ids.length) throw new Error("缺少 sessionIds（至少勾选一个会话）")
          cur.enabled = true
          cur.endTime = String(input.endTime || "08:30")
          cur.endAt = computeEndAt(cur.endTime)
          if (typeof input.message === "string" && input.message.trim()) cur.message = input.message
          const prev = new Map(cur.sessions.map((s) => [s.id, s]))
          cur.sessions = ids.map((id) => prev.get(id) || { id, sent: 0, lastSentAt: 0 })
        } else if (input.action === "stop") {
          cur.enabled = false
        } else if (input.action === "save") {
          if (typeof input.message === "string" && input.message.trim()) cur.message = input.message
          if (input.endTime) {
            cur.endTime = String(input.endTime)
            cur.endAt = computeEndAt(cur.endTime)
          }
        } else {
          throw new Error("未知 action：" + String(input.action))
        }
        if (!writeNight(cur)) throw new Error("写入配置失败：" + NIGHT_FILE)
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
        res.end(JSON.stringify({ ok: true, night: nightView() }))
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" })
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
      }
    })
    return
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
  res.end("not found")
})

server.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") {
    console.error("端口 " + PORT + " 已被占用：可能已经有一个用量控制台在运行。")
    console.error("先关闭旧的控制台窗口，或重启后再试。")
  } else {
    console.error(String((e && e.message) || e))
  }
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  const url = "http://" + HOST + ":" + PORT + "/"
  console.log("OpenCode 用量监视已启动: " + url)
  console.log("数据库: " + DB_PATH)
  if (!process.env.OCDASH_NO_OPEN) {
    try {
      spawn("cmd", ["/c", "start", "", url], { windowsHide: true, detached: true, stdio: "ignore" }).unref()
    } catch {}
  }
})

refreshRate()
setInterval(refreshRate, 6 * 60 * 60 * 1000)

process.on("SIGINT", () => {
  try { db && db.close() } catch {}
  process.exit(0)
})
