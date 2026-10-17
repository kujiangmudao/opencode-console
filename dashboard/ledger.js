const fs = require("node:fs")
const path = require("node:path")
const { DatabaseSync } = require("node:sqlite")

const LEDGER_PATH = process.env.OCDASH_LEDGER || path.join(__dirname, "data", "ledger.db")

let db

function emptyBucket() {
  return { cost: 0, usd: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, sessions: 0 }
}

function openLedger() {
  if (db) return db
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true })
  db = new DatabaseSync(LEDGER_PATH)
  db.exec("pragma journal_mode = WAL")
  db.exec("pragma busy_timeout = 3000")
  db.exec(`
    create table if not exists archived_sessions (
      id text primary key,
      title text,
      parent_id text,
      directory text,
      agent text,
      model text,
      provider_id text,
      model_id text,
      variant text,
      cost_cny real default 0,
      cost_usd real default 0,
      tokens_input integer default 0,
      tokens_output integer default 0,
      tokens_reasoning integer default 0,
      tokens_cache_read integer default 0,
      tokens_cache_write integer default 0,
      tokens_total integer default 0,
      time_created integer,
      time_updated integer,
      by_day text,
      rounds text,
      deleted_at integer,
      reason text
    )
  `)
  db.exec("create table if not exists meta (k text primary key, v text)")
  return db
}

function archiveSessions(rows, reason) {
  const d = openLedger()
  const stmt = d.prepare(`
    insert or replace into archived_sessions
    (id, title, parent_id, directory, agent, model, provider_id, model_id, variant,
     cost_cny, cost_usd, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, tokens_total,
     time_created, time_updated, by_day, rounds, deleted_at, reason)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `)
  const now = Date.now()
  let n = 0
  for (const r of rows) {
    stmt.run(
      r.id, r.title || "", r.parentId || null, r.directory || "", r.agent || "",
      r.model || "", r.providerID || "", r.modelID || "", r.variant || "",
      r.costCny || 0, r.costUsd || 0,
      r.tokensInput || 0, r.tokensOutput || 0, r.tokensReasoning || 0, r.tokensCacheRead || 0, r.tokensCacheWrite || 0, r.tokensTotal || 0,
      r.timeCreated || 0, r.timeUpdated || 0,
      JSON.stringify(r.byDay || {}), JSON.stringify(r.rounds || []),
      now, reason || "manual"
    )
    n++
  }
  return n
}

function count() {
  const d = openLedger()
  return d.prepare("select count(*) c from archived_sessions").get().c
}

function removeSessions(ids) {
  if (!ids || !ids.length) return 0
  const d = openLedger()
  const ph = ids.map(() => "?").join(",")
  const r = d.prepare("delete from archived_sessions where id in (" + ph + ")").run(...ids)
  return Number(r.changes) || 0
}

function aggregates() {
  const d = openLedger()
  const rows = d.prepare("select * from archived_sessions").all()
  const all = emptyBucket()
  const byDay = new Map()
  const byModel = new Map()
  const byDirectory = new Map()
  const byMonthSessions = new Map()
  for (const r of rows) {
    all.cost += r.cost_cny || 0
    all.usd += r.cost_usd || 0
    all.input += r.tokens_input || 0
    all.output += r.tokens_output || 0
    all.reasoning += r.tokens_reasoning || 0
    all.cacheRead += r.tokens_cache_read || 0
    all.cacheWrite += r.tokens_cache_write || 0
    all.tokens += r.tokens_total || 0
    all.sessions += 1

    let bd = {}
    try { bd = JSON.parse(r.by_day || "{}") } catch {}
    const months = new Set()
    for (const [day, b] of Object.entries(bd)) {
      let x = byDay.get(day)
      if (!x) { x = emptyBucket(); byDay.set(day, x) }
      x.cost += b.cost || 0
      x.usd += b.usd || 0
      x.input += b.input || 0
      x.output += b.output || 0
      x.reasoning += b.reasoning || 0
      x.cacheRead += b.cacheRead || 0
      x.cacheWrite += b.cacheWrite || 0
      x.tokens += b.tokens || 0
      x.sessions += 1
      months.add(day.slice(0, 7))
    }
    for (const mth of months) byMonthSessions.set(mth, (byMonthSessions.get(mth) || 0) + 1)

    const key = (r.provider_id || "") + "/" + (r.model_id || "") + "|" + (r.variant || "")
    let mx = byModel.get(key)
    if (!mx) { mx = { providerID: r.provider_id || "", modelID: r.model_id || "", variant: r.variant || "", label: r.model || "?", bucket: emptyBucket() }; byModel.set(key, mx) }
    mx.bucket.cost += r.cost_cny || 0
    mx.bucket.usd += r.cost_usd || 0
    mx.bucket.input += r.tokens_input || 0
    mx.bucket.output += r.tokens_output || 0
    mx.bucket.reasoning += r.tokens_reasoning || 0
    mx.bucket.cacheRead += r.tokens_cache_read || 0
    mx.bucket.cacheWrite += r.tokens_cache_write || 0
    mx.bucket.tokens += r.tokens_total || 0
    mx.bucket.sessions += 1

    const dir = r.directory || "(未知)"
    let dx = byDirectory.get(dir)
    if (!dx) { dx = emptyBucket(); byDirectory.set(dir, dx) }
    dx.cost += r.cost_cny || 0
    dx.usd += r.cost_usd || 0
    dx.tokens += r.tokens_total || 0
    dx.sessions += 1
  }
  return { count: rows.length, all, byDay, byModel, byDirectory, byMonthSessions }
}

function stats() {
  const d = openLedger()
  const r = d.prepare("select count(*) n, coalesce(sum(cost_cny),0) cny, coalesce(sum(cost_usd),0) usd from archived_sessions").get()
  return { count: r.n, costCny: r.cny, costUsd: r.usd }
}

module.exports = {
  LEDGER_PATH,
  openLedger,
  archiveSessions,
  removeSessions,
  count,
  aggregates,
  stats
}
