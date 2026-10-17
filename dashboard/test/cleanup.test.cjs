const { test, after } = require("node:test")
const assert = require("node:assert/strict")
const { mkdirSync, mkdtempSync, readFileSync, rmSync } = require("node:fs")
const { tmpdir } = require("node:os")
const { join } = require("node:path")
const { spawn } = require("node:child_process")
const { DatabaseSync } = require("node:sqlite")

const TMP = mkdtempSync(join(tmpdir(), "oc-cleanup-test-"))
process.env.OCDASH_DB = join(TMP, "db1", "opencode.db")
process.env.OCDASH_LEDGER = join(TMP, "ledger1.db")

const oc = require("../lib/opencode")
const ledger = require("../ledger")
const cleanup = require("../cleanup")

const DASH = join(__dirname, "..")
const SCHEMA = readFileSync(join(__dirname, "fixtures", "schema.sql"), "utf8")

function makeDb(file) {
  mkdirSync(join(file, ".."), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(SCHEMA)
  const now = Date.now()
  const old = now - 5 * 86400000
  db.prepare("insert into project (id, worktree, time_created, time_updated, sandboxes) values (?,?,?,?,?)").run("prj_test", "/tmp/test", now, now, "[]")
  const insS = db.prepare("insert into session (id, project_id, parent_id, slug, directory, title, version, model, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  const model = JSON.stringify({ providerID: "deepseek", id: "deepseek-v4-flash", variant: "max" })
  insS.run("ses_main", "prj_test", null, "main", "/tmp/test", "会话A（主）", "1", model, "build", 0.02, 0, 0, 0, 0, 0, old - 1000, old)
  insS.run("ses_child", "prj_test", "ses_main", "child", "/tmp/test", "子代理A", "1", model, "general", 0.01, 0, 0, 0, 0, 0, old - 500, old - 100)
  insS.run("ses_other", "prj_test", null, "other", "/tmp/test", "无关会话B", "1", model, "build", 0.03, 0, 0, 0, 0, 0, old - 2000, old - 200)
  const insM = db.prepare("insert into message (id, session_id, time_created, time_updated, data) values (?,?,?,?,?)")
  const insP = db.prepare("insert into part (id, message_id, session_id, time_created, time_updated, data) values (?,?,?,?,?,?)")
  const amsg = (cost) => JSON.stringify({ role: "assistant", time: { created: old }, cost, tokens: { input: 100000, output: 1000, reasoning: 0, cache: { read: 1000000, write: 0 } }, modelID: "deepseek-v4-flash", providerID: "deepseek", variant: "max", agent: "build" })
  const umsg = JSON.stringify({ role: "user", time: { created: old - 500 } })
  insM.run("m1u", "ses_main", old - 500, old - 500, umsg)
  insP.run("p1u", "m1u", "ses_main", old - 500, old - 500, JSON.stringify({ type: "text", text: "做任务A" }))
  insM.run("m1a1", "ses_main", old, old, amsg(0.01))
  insP.run("p1a1", "m1a1", "ses_main", old, old, JSON.stringify({ type: "text", text: "好的，开始做。" }))
  insM.run("m1a2", "ses_main", old + 1000, old + 1000, amsg(0.01))
  insP.run("p1a2", "m1a2", "ses_main", old + 1000, old + 1000, JSON.stringify({ type: "tool", tool: "bash", state: {} }))
  insM.run("m2u", "ses_child", old - 400, old - 400, umsg)
  insP.run("p2u", "m2u", "ses_child", old - 400, old - 400, JSON.stringify({ type: "text", text: "帮主会话干活" }))
  insM.run("m2a", "ses_child", old - 100, old - 100, amsg(0.01))
  insM.run("m3u", "ses_other", old - 1500, old - 1500, umsg)
  insM.run("m3a", "ses_other", old - 200, old - 200, amsg(0.03))
  const insES = db.prepare("insert into event_sequence (aggregate_id, seq, owner_id) values (?,?,?)")
  insES.run("ses_main", 3, null)
  insES.run("ses_child", 1, null)
  insES.run("ses_other", 1, null)
  db.prepare("insert into event (id, aggregate_id, seq, type, data) values (?,?,?,?,?)").run("ev1", "ses_main", 1, "x", "{}")
  db.close()
}

makeDb(process.env.OCDASH_DB)

after(() => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
})

test("listSessions: sizes, child count, costs", () => {
  const db = oc.openDb()
  const list = cleanup.listSessions(db)
  assert.equal(list.length, 3)
  const main = list.find((s) => s.id === "ses_main")
  assert.equal(main.isMain, true)
  assert.equal(main.childCount, 1)
  assert.ok(main.sizeBytes > 0)
  assert.ok(main.costCny > 0)
  assert.ok(main.costUsd > 0)
  const child = list.find((s) => s.id === "ses_child")
  assert.equal(child.isMain, false)
  assert.equal(child.parentID, "ses_main")
})

test("execute: archives the subtree, deletes, residual checks pass", () => {
  const out = cleanup.execute({ ids: ["ses_main"], runningCheck: () => false, reason: "test" })
  assert.equal(out.ok, true)
  assert.equal(out.deleted, 2)
  assert.equal(out.archived, 2)
  for (const [k, v] of Object.entries(out.residual)) assert.equal(v, 0, "residual " + k)
  const db = new DatabaseSync(process.env.OCDASH_DB, { readOnly: true })
  assert.equal(db.prepare("select count(*) c from session where id in ('ses_main','ses_child')").get().c, 0)
  assert.equal(db.prepare("select count(*) c from message where session_id in ('ses_main','ses_child')").get().c, 0)
  assert.equal(db.prepare("select count(*) c from part where session_id in ('ses_main','ses_child')").get().c, 0)
  assert.equal(db.prepare("select count(*) c from event where aggregate_id = 'ses_main'").get().c, 0)
  db.close()
})

test("ledger keeps costs, days, models and rounds", () => {
  const a = ledger.aggregates()
  assert.equal(a.count, 2)
  assert.ok(a.all.cost > 0)
  assert.ok(a.all.sessions === 2)
  assert.ok(a.byDay.size >= 1)
  assert.ok(a.byModel.size >= 1)
  const d = ledger.openLedger()
  const r = d.prepare("select rounds, by_day from archived_sessions where id = 'ses_main'").get()
  const rounds = JSON.parse(r.rounds)
  assert.ok(Array.isArray(rounds) && rounds.length >= 1)
  assert.ok(rounds[0].prompt.includes("做任务A"))
  assert.ok(JSON.parse(r.by_day) && Object.keys(JSON.parse(r.by_day)).length >= 1)
})

test("ledger.removeSessions removes archived rows (rollback on failed delete)", () => {
  ledger.archiveSessions([{ id: "ses_fake", title: "fake", costCny: 1, costUsd: 0.1, byDay: { "2026-10-01": { cost: 1, usd: 0.1 } }, rounds: [] }], "test")
  const c1 = ledger.count()
  const n = ledger.removeSessions(["ses_fake"])
  assert.equal(n, 1)
  assert.equal(ledger.count(), c1 - 1)
})

test("guard: refuses while opencode is running", () => {
  const before = ledger.count()
  const out = cleanup.execute({ ids: ["ses_other"], runningCheck: () => true })
  assert.equal(out.ok, false)
  assert.equal(out.code, 409)
  assert.equal(ledger.count(), before)
})

test("vacuum: returns sizes and keeps the db readable", () => {
  const out = cleanup.vacuumDb(process.env.OCDASH_DB)
  assert.ok(typeof out.before === "number" && out.before > 0)
  assert.ok(typeof out.after === "number" && out.after > 0)
  const db = new DatabaseSync(process.env.OCDASH_DB, { readOnly: true })
  assert.equal(db.prepare("select count(*) c from session").get().c, 1)
  db.close()
})

test("e2e: cleanup API archives, deletes, and totals stay intact", async () => {
  const db2 = join(TMP, "db2", "opencode.db")
  makeDb(db2)
  const ledger2 = join(TMP, "ledger2.db")
  const port = 8793
  const child = spawn(process.execPath, ["server.js"], {
    cwd: DASH,
    env: {
      ...process.env,
      OCDASH_PORT: String(port),
      OCDASH_NO_OPEN: "1",
      OCDASH_DB: db2,
      OCDASH_LEDGER: ledger2,
      OCDASH_CNY_RATE: "7.2",
      OC_CLEANUP_ALLOW_RUNNING: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let logs = ""
  child.stdout.on("data", (d) => { logs += d })
  child.stderr.on("data", (d) => { logs += d })
  const base = "http://127.0.0.1:" + port
  const waitReady = async (timeoutMs) => {
    const start = Date.now()
    while (Date.now() - start < (timeoutMs || 10000)) {
      try {
        const r = await fetch(base + "/api/usage")
        if (r.ok) return await r.json()
      } catch {}
      await new Promise((res) => setTimeout(res, 200))
    }
    return null
  }
  try {
    const usage1 = await waitReady(12000)
    assert.ok(usage1, "server did not start: " + logs)
    assert.equal(usage1.ok, true, logs)
    const n0 = usage1.sessions.length
    const cost0 = usage1.totals.all.cost
    assert.equal(n0, 3)

    const cl = await (await fetch(base + "/api/cleanup")).json()
    assert.equal(cl.ok, true, logs)
    assert.equal(typeof cl.opencodeRunning, "boolean")
    assert.equal(cl.ledger.count, 0)

    const ex = await (await fetch(base + "/api/cleanup/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["ses_main"] })
    })).json()
    assert.equal(ex.ok, true, JSON.stringify(ex))
    assert.equal(ex.deleted, 2)
    assert.equal(ex.archived, 2)

    const usage2 = await (await fetch(base + "/api/usage")).json()
    assert.equal(usage2.sessions.length, n0 - 2)
    assert.ok(Math.abs(usage2.totals.all.cost - cost0) < 0.01, "totals after cleanup: " + usage2.totals.all.cost + " vs " + cost0)

    const cl2 = await (await fetch(base + "/api/cleanup")).json()
    assert.equal(cl2.ledger.count, 2)
    assert.ok(cl2.ledger.costCny > 0)

    const vac = await (await fetch(base + "/api/cleanup/vacuum", { method: "POST" })).json()
    assert.equal(vac.ok, true, JSON.stringify(vac))

    const usage3 = await (await fetch(base + "/api/usage")).json()
    assert.equal(usage3.ok, true, logs)
    assert.ok(Math.abs(usage3.totals.all.cost - usage2.totals.all.cost) < 0.01)
  } finally {
    child.kill()
    await new Promise((r) => setTimeout(r, 300))
  }
})
