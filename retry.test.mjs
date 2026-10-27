import { expect, test } from "bun:test"
import * as mod from "./retry.middleware.js"
import { check } from "./middleware.mjs"

check(import.meta.dir, mod)

// A rest grows on the clock, and the window slides on it, which cases.json
// cannot wait for. These tests sleep the seconds they need — the rests and the
// window are a second or two for them — and each uses models of its own, so
// none of them reads or leaves anything the others are counting.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ctxFor is a ctx shaped as the gateway's: one per request, reject recording.
function ctxFor(options) {
  const refused = []
  const ctx = {
    protocol: "anthropic", model: "", stream: false, path: "",
    options, state: {}, reject: (status, message) => refused.push({ status, message }),
  }
  return { ctx, refused }
}

// asker is one round for one model: the request, then its reply. A refused
// request has no reply, so none is given.
function asker(model, ctx, refused) {
  return async (status) => {
    const before = refused.length
    await mod.onRequest({ model }, ctx)
    if (refused.length === before) await mod.onResponse({ model }, { ...ctx, status })
  }
}

// back is the failed round and the round after it. The second request is the
// one refused, and its message says how long the rest is now.
async function back(ask, refused) {
  await ask(500)
  await ask(500)
  return refused.at(-1)?.message
}

test("the probe after a rest that fails again rests twice as long", async () => {
  mod._reset()
  const { ctx, refused } = ctxFor({ failures: 1, cooldown: 1, max: 600 })
  const ask = asker("cb-sleep-doubling", ctx, refused)

  expect(await back(ask, refused)).toContain("1s left") // the cooldown
  await sleep(1100)
  expect(await back(ask, refused)).toContain("2s left") // the probe failed: twice as long
})

test("the rest grows to max and no further, and a model that works again starts over", async () => {
  mod._reset()
  const { ctx, refused } = ctxFor({ failures: 1, cooldown: 1, max: 2 })
  const ask = asker("cb-sleep-max", ctx, refused)

  expect(await back(ask, refused)).toContain("1s left") // the cooldown
  await sleep(1100)
  expect(await back(ask, refused)).toContain("2s left") // twice as long
  await sleep(2100)
  expect(await back(ask, refused)).toContain("2s left") // max, not four times

  await sleep(2100)
  await ask(200) // the probe works again, which gives the model its first rest back
  await ask(500)
  await ask(500)
  expect(refused.at(-1)?.message).toContain("1s left") // a first rest, not a grown one
}, 30000)

test("a max under the cooldown cannot shorten a rest", async () => {
  mod._reset()
  const { ctx, refused } = ctxFor({ failures: 1, cooldown: 2, max: 1 })
  const ask = asker("cb-sleep-tight", ctx, refused)

  expect(await back(ask, refused)).toContain("2s left")
  await sleep(2100)
  expect(await back(ask, refused)).toContain("2s left") // doubling to 1s would have shortened it
}, 30000)

test("a failure older than the window does not count towards the rest", async () => {
  mod._reset()
  const { ctx, refused } = ctxFor({ failures: 2, window: 1, cooldown: 60 })
  const ask = asker("cb-sleep-window", ctx, refused)

  await ask(500)
  await sleep(1100)
  await ask(500)
  await ask(500) // refused only if the first failure had counted

  expect(refused).toEqual([])
})
