const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")
const { spawn } = require("node:child_process")

const oc = require("./lib/opencode")
const ledger = require("./ledger")
const cleanup = require("./cleanup")
const {
  DB_PATH, SESSION_COLS, getCny, setCny, openDb, closeDb, statSize, localDay,
  parseModel, modelLabel, emptyBucket, addTo, sessionTokens, sessionRow,
  parseMessage, stepCost, sessionCost, roundsForSession
} = oc

const PORT = Number(process.env.OCDASH_PORT || 8787)
const HOST = "127.0.0.1"
const INDEX = path.join(__dirname, "index.html")
const LIVE_MS = 5 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const NIGHT_PROJECT_DIR = process.env.OC_NIGHT_DIR || "D:/MY_PROJECT/good_night/packages/night-shift/data"
const NIGHT_FILE = path.join(NIGHT_PROJECT_DIR, "night-shift.json")
const NIGHT_DEFAULT_MESSAGE = [
  "现在是 {time}（距离结束还有 {remaining}）。",
  "",
  "请回顾任务目标继续执行：如果任务尚未完成，直接继续，不要停止、不要等待用户输入。",
  "如果你认为已经完成：请自行 review 或运行测试验证一遍，确认无误再结束。",
  "确认全部完成后，最后输出两行：倒数第二行以 [夜间任务证据] 开头并附一句话（做了什么、如何验证）；最后一行单独输出 [夜间任务完成]"
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

function freePages() {
  try {
    const d = openDb()
    const ps = d.prepare("pragma page_size").get().page_size
    const fp = d.prepare("pragma freelist_count").get().freelist_count
    return ps * fp
  } catch {
    return 0
  }
}

function readJsonBody(req, cb) {
  let body = ""
  req.on("data", (c) => {
    body += c
    if (body.length > 1e6) req.destroy()
  })
  req.on("end", () => {
    try { cb(null, JSON.parse(body || "{}")) } catch (e) { cb(e) }
  })
}

async function refreshRate() {
  const fixed = Number(process.env.OCDASH_CNY_RATE || 0)
  if (fixed > 0) {
    setCny({ rate: fixed, source: "fixed", updatedAt: Date.now() })
    return
  }
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(8000) })
    const j = await res.json()
    const v = j && j.rates && j.rates.CNY
    if (typeof v === "number" && v > 0) setCny({ rate: v, source: "live", updatedAt: Date.now() })
  } catch {}
}


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

  const led = ledger.aggregates()
  const mergeBucket = (dst, src) => {
    for (const k of ["cost", "usd", "input", "output", "reasoning", "cacheRead", "cacheWrite", "tokens", "sessions"]) dst[k] = (dst[k] || 0) + (src[k] || 0)
  }
  mergeBucket(totals.all, led.all)
  for (const [day, b] of led.byDay) {
    let db = dayTotals.get(day)
    if (!db) { db = emptyBucket(); dayTotals.set(day, db) }
    mergeBucket(db, b)
    daySessions.set(day, (daySessions.get(day) || 0) + (b.sessions || 0))
  }
  for (const [key, x] of led.byModel) {
    if (!models.has(key)) models.set(key, { providerID: x.providerID, modelID: x.modelID, variant: x.variant, label: x.label, bucket: emptyBucket(), lastUpdate: 0 })
    mergeBucket(models.get(key).bucket, x.bucket)
  }
  for (const [dir, b] of led.byDirectory) {
    if (!dirs.has(dir)) dirs.set(dir, emptyBucket())
    mergeBucket(dirs.get(dir), b)
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
  totals.month.sessions = monthSessions.size + (led.byMonthSessions.get(month) || 0)

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
    cny: getCny(),
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
  const points = []
  for (const r of rows) {
    const m = parseMessage(r.data, r.time_created)
    if (!m) continue
    if (m.tokens <= 0 && m.cost <= 0) continue
    points.push({ t: m.time, cost: stepCost(m), tokens: m.tokens, m })
  }
  const steps = points.slice(-40).reverse().map((p) => ({ ...p.m, cost: p.cost, usd: p.m.cost }))

  const rounds = roundsForSession(d, id)

  return {
    ok: true,
    generatedAt: now,
    cny: getCny(),
    session: sessionRow(s, now),
    steps,
    rounds,
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
  if (u.pathname === "/api/cleanup" && req.method === "GET") {
    try {
      const d = openDb()
      const sessions = cleanup.listSessions(d)
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
      res.end(JSON.stringify({
        ok: true,
        db: { path: DB_PATH, sizeBytes: statSize(DB_PATH), walBytes: statSize(DB_PATH + "-wal"), freeBytes: freePages() },
        opencodeRunning: cleanup.opencodeRunning(),
        ledger: ledger.stats(),
        sessions
      }))
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
    }
    return
  }
  if (u.pathname === "/api/cleanup/execute" && req.method === "POST") {
    readJsonBody(req, (err, input) => {
      if (err) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" })
        res.end(JSON.stringify({ ok: false, error: "无效的请求体" }))
        return
      }
      try {
        const out = cleanup.execute({ ids: input.ids, vacuum: !!input.vacuum, reason: "manual" })
        const code = out.ok ? 200 : (out.code === 409 ? 409 : 400)
        res.writeHead(code, { "content-type": "application/json; charset=utf-8" })
        res.end(JSON.stringify(out))
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" })
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
      }
    })
    return
  }
  if (u.pathname === "/api/cleanup/vacuum" && req.method === "POST") {
    try {
      if (cleanup.opencodeRunning() && process.env.OC_CLEANUP_ALLOW_RUNNING !== "1") {
        res.writeHead(409, { "content-type": "application/json; charset=utf-8" })
        res.end(JSON.stringify({ ok: false, code: 409, error: "opencode 正在运行：请完全退出 opencode 后再执行紧凑化。" }))
        return
      }
      closeDb()
      const out = cleanup.vacuumDb(DB_PATH)
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ ok: true, ...out }))
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
    }
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
  try { closeDb() } catch {}
  process.exit(0)
})
