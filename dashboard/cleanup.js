const fs = require("node:fs")
const { DatabaseSync } = require("node:sqlite")
const { execFileSync } = require("node:child_process")
const oc = require("./lib/opencode")
const ledger = require("./ledger")

function opencodeRunning() {
  if (process.platform !== "win32") return false
  try {
    const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 8000, windowsHide: true })
    return /"opencode[^"]*\.exe"/i.test(out)
  } catch {
    return false
  }
}

function sessionSizes(db) {
  const partSizes = new Map()
  for (const r of db.prepare("select session_id sid, count(*) n, coalesce(sum(length(data)),0) b from part group by session_id").all()) partSizes.set(r.sid, r)
  const msgSizes = new Map()
  for (const r of db.prepare("select session_id sid, count(*) n, coalesce(sum(length(data)),0) b from message group by session_id").all()) msgSizes.set(r.sid, r)
  return { partSizes, msgSizes }
}

function listSessions(db) {
  const sizes = sessionSizes(db)
  const rows = db.prepare("select " + oc.SESSION_COLS + " from session").all()
  const childCount = new Map()
  for (const s of rows) if (s.parent_id) childCount.set(s.parent_id, (childCount.get(s.parent_id) || 0) + 1)
  const now = Date.now()
  return rows.map((s) => {
    const sc = oc.sessionCost(db, s)
    const p = sizes.partSizes.get(s.id) || { n: 0, b: 0 }
    const m = sizes.msgSizes.get(s.id) || { n: 0, b: 0 }
    return {
      id: s.id,
      parentID: s.parent_id,
      title: s.title || "",
      directory: s.directory || "",
      agent: s.agent || "",
      model: oc.modelLabel(oc.parseModel(s.model)),
      costCny: sc.cost,
      costUsd: s.cost || 0,
      tokens: oc.sessionTokens(s),
      sizeBytes: p.b + m.b,
      parts: p.n,
      messages: m.n,
      timeCreated: s.time_created,
      timeUpdated: s.time_updated,
      ageMs: now - s.time_updated,
      childCount: childCount.get(s.id) || 0,
      isMain: !s.parent_id
    }
  })
}

function expandSubtree(sessions, ids) {
  const byParent = new Map()
  for (const s of sessions) {
    if (!s.parentID) continue
    if (!byParent.has(s.parentID)) byParent.set(s.parentID, [])
    byParent.get(s.parentID).push(s.id)
  }
  const out = new Set(ids.filter((x) => typeof x === "string" && x))
  const queue = [...out]
  while (queue.length) {
    const id = queue.shift()
    for (const c of byParent.get(id) || []) {
      if (!out.has(c)) { out.add(c); queue.push(c) }
    }
  }
  return [...out]
}

function snapshotSession(d, s) {
  const sc = oc.sessionCost(d, s)
  const m = oc.parseModel(s.model)
  const rounds = oc.roundsForSession(d, s.id)
  return {
    id: s.id,
    title: s.title,
    parentId: s.parent_id,
    directory: s.directory,
    agent: s.agent,
    model: oc.modelLabel(m),
    providerID: m.providerID,
    modelID: m.modelID,
    variant: m.variant,
    costCny: sc.cost,
    costUsd: s.cost || 0,
    tokensInput: s.tokens_input || 0,
    tokensOutput: s.tokens_output || 0,
    tokensReasoning: s.tokens_reasoning || 0,
    tokensCacheRead: s.tokens_cache_read || 0,
    tokensCacheWrite: s.tokens_cache_write || 0,
    tokensTotal: oc.sessionTokens(s),
    timeCreated: s.time_created,
    timeUpdated: s.time_updated,
    byDay: sc.byDay,
    rounds
  }
}

const RESIDUAL_TABLES = ["message", "part", "todo", "session_share", "session_message", "session_input", "session_context_epoch"]

function deleteSessions(dbPath, ids) {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec("pragma busy_timeout = 15000")
    db.exec("pragma foreign_keys = ON")
    const ph = ids.map(() => "?").join(",")
    db.exec("begin immediate")
    try {
      db.prepare("delete from event_sequence where aggregate_id in (" + ph + ")").run(...ids)
      db.prepare("delete from session where id in (" + ph + ")").run(...ids)
      db.exec("commit")
    } catch (e) {
      try { db.exec("rollback") } catch {}
      return { ok: false, error: String((e && e.message) || e) }
    }
    try { db.exec("pragma wal_checkpoint(TRUNCATE)") } catch {}
    const residual = {}
    residual.session = db.prepare("select count(*) c from session where id in (" + ph + ")").get(...ids).c
    residual.event_sequence = db.prepare("select count(*) c from event_sequence where aggregate_id in (" + ph + ")").get(...ids).c
    residual.event = db.prepare("select count(*) c from event where aggregate_id in (" + ph + ")").get(...ids).c
    for (const t of RESIDUAL_TABLES) {
      try {
        residual[t] = db.prepare("select count(*) c from " + t + " where session_id in (" + ph + ")").get(...ids).c
      } catch {
        residual[t] = 0
      }
    }
    const bad = Object.entries(residual).filter(([, v]) => v > 0)
    return { ok: bad.length === 0, residual, residualError: bad.length ? "删除后仍有残留：" + bad.map(([k, v]) => k + "=" + v).join(", ") : null }
  } finally {
    try { db.close() } catch {}
  }
}

function vacuumDb(dbPath) {
  const before = fs.statSync(dbPath).size
  const db = new DatabaseSync(dbPath)
  try {
    db.exec("pragma busy_timeout = 60000")
    try { db.exec("pragma wal_checkpoint(TRUNCATE)") } catch {}
    db.exec("VACUUM")
  } finally {
    try { db.close() } catch {}
  }
  const after = fs.statSync(dbPath).size
  return { before, after }
}

function execute(opts) {
  const options = opts || {}
  const ids = Array.isArray(options.ids) ? options.ids.filter((x) => typeof x === "string" && x) : []
  if (!ids.length) return { ok: false, error: "没有选择任何会话" }
  const runningCheck = typeof options.runningCheck === "function" ? options.runningCheck : opencodeRunning
  const allowRunning = options.allowRunning === true || process.env.OC_CLEANUP_ALLOW_RUNNING === "1"
  if (runningCheck() && !allowRunning) {
    return { ok: false, code: 409, error: "opencode 正在运行：请完全退出 opencode（含桌面端所有进程）后再执行清理。" }
  }

  const d = oc.openDb()
  const all = listSessions(d)
  const targetIds = expandSubtree(all, ids)
  const targets = all.filter((s) => targetIds.includes(s.id))
  if (!targets.length) return { ok: false, error: "选中的会话已不存在" }

  const dbBefore = fs.statSync(oc.DB_PATH).size
  let snapshots
  try {
    snapshots = targets.map((s) => {
      const row = d.prepare("select * from session where id = ?").get(s.id)
      return snapshotSession(d, row)
    })
  } catch (e) {
    return { ok: false, error: "归档快照失败（未删除任何数据）：" + String((e && e.message) || e) }
  }
  let archived = 0
  try {
    archived = ledger.archiveSessions(snapshots, options.reason || "manual")
  } catch (e) {
    return { ok: false, error: "写入账本失败（未删除任何数据）：" + String((e && e.message) || e) }
  }

  const del = deleteSessions(oc.DB_PATH, targets.map((s) => s.id))
  if (!del.ok) {
    try { ledger.removeSessions(targets.map((s) => s.id)) } catch {}
    return { ok: false, error: del.residualError || del.error, archived: 0, deleted: 0, residual: del.residual }
  }

  let vacuum = null
  if (options.vacuum) {
    try {
      oc.closeDb()
      vacuum = vacuumDb(oc.DB_PATH)
    } catch (e) {
      return { ok: true, archived, deleted: targets.length, residual: del.residual, vacuum: null, vacuumError: String((e && e.message) || e), dbBefore, dbAfter: fs.statSync(oc.DB_PATH).size }
    }
  }
  const dbAfter = fs.statSync(oc.DB_PATH).size
  return {
    ok: true,
    archived,
    deleted: targets.length,
    residual: del.residual,
    vacuum,
    dbBefore,
    dbAfter,
    ledger: ledger.stats()
  }
}

module.exports = {
  opencodeRunning,
  listSessions,
  expandSubtree,
  snapshotSession,
  deleteSessions,
  vacuumDb,
  execute
}
