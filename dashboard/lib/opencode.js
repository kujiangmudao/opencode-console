const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { DatabaseSync } = require("node:sqlite")

const DB_PATH = process.env.OCDASH_DB || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
const SESSION_COLS = "id, parent_id, directory, title, model, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated"
const CNY_FALLBACK = 7.2

let cny = { rate: CNY_FALLBACK, source: "fallback", updatedAt: 0 }
function getCny() {
  return cny
}
function setCny(v) {
  if (v && typeof v.rate === "number" && v.rate > 0) cny = v
}

let db
function openDb() {
  if (db) return db
  db = new DatabaseSync(DB_PATH, { readOnly: true })
  try { db.exec("pragma busy_timeout = 3000") } catch {}
  return db
}
function closeDb() {
  try { if (db) db.close() } catch {}
  db = null
}
function statSize(p) {
  try { return fs.statSync(p).size } catch { return 0 }
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

function roundsForSession(d, id) {
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
  return rounds.slice(-60)
}

module.exports = {
  DB_PATH,
  SESSION_COLS,
  getCny,
  setCny,
  openDb,
  closeDb,
  statSize,
  localDay,
  parseModel,
  modelLabel,
  emptyBucket,
  addTo,
  sessionTokens,
  sessionRow,
  parseMessage,
  stepCost,
  sessionCost,
  roundsForSession
}
