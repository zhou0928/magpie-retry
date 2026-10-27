// Runs a gateway middleware's cases the way magpie's gateway calls it: one
// ctx for the request's hooks (so ctx.state carries over), each body a fresh
// copy of its JSON, undefined keeping what came in, null dropping an event.
// A case's provider is the one the request is tried on (ctx.provider): its
// request goes on through onProvider, and what it expects is that try's.
// The same cases.json runs in magpie's own JavaScript engine (moejs), so a
// middleware is checked in both.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "bun:test"

export function cases(dir) {
  return JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"))
}

export async function run(mod, c) {
  const m = mod.default ?? mod
  let rejected
  const ctx = {
    protocol: "anthropic", model: "", stream: false, path: "", ...c.ctx,
    options: c.options ?? {}, state: {},
    reject(status, message) { rejected ??= { status, message } },
  }
  const copy = (v) => JSON.parse(JSON.stringify(v))
  const out = {}
  if (c.request) {
    const r = m.onRequest ? await m.onRequest(copy(c.request), ctx) : undefined
    if (rejected) out.reject = rejected
    else out.request = r === undefined ? c.request : copy(r)
    if (!rejected && c.provider && m.onProvider) {
      const p = await m.onProvider(copy(out.request), { ...ctx, provider: c.provider })
      if (p !== undefined && p !== null) out.request = copy(p)
    }
  }
  if (c.events) {
    out.events = []
    for (const e of c.events) {
      const wants = !m.events || (e.event && m.events.includes(e.event))
      if (typeof e.data !== "object" || !m.onEvent || !wants) {
        out.events.push(e.data)
        continue
      }
      const r = await m.onEvent(copy(e.data), ctx)
      if (r === null) continue
      out.events.push(r === undefined ? e.data : copy(r))
    }
  }
  if (c.response) {
    ctx.status = c.status ?? 200
    const r = m.onResponse ? await m.onResponse(copy(c.response), ctx) : undefined
    out.response = r === undefined ? c.response : copy(r)
  }
  return out
}

// check runs each case and compares it with what it expects: a request,
// events or response not expected are expected to pass unchanged.
export function check(dir, mod) {
  for (const c of cases(dir)) {
    test(c.name, async () => {
      const got = await run(mod, c)
      if (c.reject) {
        expect(got.reject?.status).toBe(c.reject.status)
        if (c.reject.message) expect(got.reject?.message).toContain(c.reject.message)
      } else {
        expect(got.reject).toBeUndefined()
        if (c.request) expect(got.request).toEqual(c.expect_request ?? c.request)
      }
      if (c.events) expect(got.events).toEqual(c.expect_events ?? c.events.map((e) => e.data))
      if (c.response) expect(got.response).toEqual(c.expect_response ?? c.response)
    })
  }
}

// order asks a module's strategy for the order of seats, as the gateway
// does: strategies[name] or strategies[name].order, given the pool's name,
// the seats (with every field a seat has) and the plugin's options. An
// answer that isn't an order of the seats is the listed order, as the
// gateway falls back to; failed says so.
export function order(mod, name, pool, seats, options = {}) {
  const m = mod.default ?? mod
  const s = m.strategies?.[name]
  const fn = typeof s === "function" ? s : s?.order
  if (typeof fn !== "function") throw new Error(`no strategy ${name}`)
  const full = seats.map((x, i) => ({
    key: `seat-${i}`, account: false, known: false, learns: false, used: 0,
    soon: [], pace: 0, weight: 1, resting: false, tokens: 0, ...x,
  }))
  const listed = full.map((_, i) => i)
  let got
  try {
    got = fn(pool, JSON.parse(JSON.stringify(full)), options)
  } catch {
    return { order: listed, failed: true }
  }
  const ok = Array.isArray(got) && got.length === full.length &&
    got.every((i) => Number.isInteger(i) && i >= 0 && i < full.length) && new Set(got).size === full.length
  return ok ? { order: got } : { order: listed, failed: true }
}

// checkStrategies runs strategies.json: each case names a strategy, the
// seats (only the fields that matter; the rest are filled in), options,
// a pool, and the order it expects, by the seats' keys when they have one.
export function checkStrategies(dir, mod) {
  const list = JSON.parse(readFileSync(join(dir, "strategies.json"), "utf8"))
  for (const c of list) {
    test(c.name, () => {
      const got = order(mod, c.strategy, c.pool ?? "test-pool", c.seats, c.options ?? {})
      expect(got.failed).toBeUndefined()
      expect(got.order.map((i) => c.seats[i].key ?? i)).toEqual(c.expect)
    })
  }
}
