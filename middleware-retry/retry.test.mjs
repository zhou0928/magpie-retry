// The smallest thing that fails if the breaker's logic breaks: failures
// inside the window open it, a good reply clears it, the window forgets old
// failures, a rest ends by itself, a failed probe re-opens the model at once
// with a longer rest up to max, and a streamed error counts like a whole one.
import assert from "node:assert"
import { onRequest, onResponse, onEvent, _reset } from "./retry.middleware.js"

const opts = { failures: 2, window: 60, cooldown: 1, status: [500, 503] }
const ctx = (options) => {
  const c = { options, state: {}, status: 200, rejected: null, reject: (s, m) => (c.rejected = [s, m]) }
  return c
}
const ask = (model, status, context) => {
  const c = context || ctx(opts)
  c.status = status
  onRequest({ model }, c)
  // a refused request never has a reply: onRequest set the state, and the
  // reply's status is the one this call means
  if (!c.rejected) onResponse({ model }, c)
  return c
}
// what a request to model gets right now: null when it is let through, the
// refusal when it is not
const probe = (model, options) => {
  const c = ctx(options || opts)
  onRequest({ model }, c)
  return c.rejected
}
const ms = (n) => new Promise((r) => setTimeout(r, n))

_reset()

// one failure of two: still open for use
let c = ask("a", 500)
onRequest({ model: "a" }, c)
assert.equal(c.rejected, null, "one failure must not rest the model")

// the second inside the window rests it
c = ask("a", 503)
const blocked = ctx(opts)
onRequest({ model: "a" }, blocked)
assert.equal(blocked.rejected?.[0], 429, "second failure must rest the model")
assert.match(blocked.rejected[1], /a is resting.*1s left/, "the refusal names the model and time left")

// another model is untouched
assert.equal(probe("b"), null, "a resting model must not block the others")

// a status not listed doesn't count
_reset()
ask("d", 404)
ask("d", 404)
assert.equal(probe("d"), null, "404 is not counted")

// the window forgets: two failures far apart never open it
_reset()
const slow = { ...opts, window: 0.05 }
ask("e", 500, ctx(slow))
await ms(90)
ask("e", 500, ctx(slow))
assert.equal(probe("e", slow), null, "failures outside the window must be forgotten")

// a good reply clears what the window had
_reset()
ask("f", 500)
ask("f", 200)
ask("f", 500)
assert.equal(probe("f"), null, "a good reply clears the window")

// the rest ends by itself, and the request after it goes through
_reset()
ask("g", 500)
ask("g", 500)
assert.equal(probe("g")?.[0], 429, "resting")
await ms(1100)
assert.equal(probe("g"), null, "a rest ends after its cooldown")

// a failed probe re-opens at once, resting twice as long each time, up to max
_reset()
const grow = { ...opts, cooldown: 1, max: 2 }
ask("h", 500, ctx(grow))
ask("h", 500, ctx(grow))
assert.match(probe("h", grow)?.[1], /1s left/, "the first rest is the cooldown")
await ms(1100)
assert.equal(probe("h", grow), null, "the probe after a rest is let through")
ask("h", 500, ctx(grow))
assert.match(probe("h", grow)?.[1], /2s left/, "a failed probe rests twice as long")
await ms(2100)
assert.equal(probe("h", grow), null, "let through again")
ask("h", 500, ctx(grow))
assert.match(probe("h", grow)?.[1], /2s left/, "the rest stops growing at max")

// and a probe that works gives the model its first rest back
await ms(2100)
ask("h", 200, ctx(grow))
ask("h", 500, ctx(grow))
ask("h", 500, ctx(grow))
assert.match(probe("h", grow)?.[1], /1s left/, "a model that works again starts over")

// a streamed reply's error event counts like a whole one
_reset()
const streamed = ctx(opts)
ask("k", 500, streamed)
onEvent({ type: "error", error: { status: 500 } }, streamed)
assert.equal(probe("k")?.[0], 429, "a stream error counts like a whole reply")

// a streamed answer clears what the window had, as a whole reply does
_reset()
const healthy = ctx(opts)
ask("m", 500, healthy)
onEvent({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }, healthy)
ask("m", 500, healthy)
assert.equal(probe("m"), null, "a streamed answer clears the window")

// a stream that opens and dies at once is not a model that works again
_reset()
const flaky = ctx(grow)
ask("n", 500, flaky)
ask("n", 500, flaky)
assert.equal(probe("n", grow)?.[0], 429, "resting")
await ms(1100)
assert.equal(probe("n", grow), null, "the probe is let through")
onEvent({ type: "message_start", message: {} }, flaky)
onEvent({ type: "error", error: {} }, flaky)
assert.equal(probe("n", grow)?.[0], 429, "connecting is not answering: the stream still failed")

// ...but content is, and it starts the model over
await ms(2100)
assert.equal(probe("n", grow), null, "let through again")
onEvent({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }, flaky)
ask("n", 500, ctx(grow))
assert.equal(probe("n", grow), null, "a streamed answer clears the count")

// the shipped default, with no options set at all: the second failure rests it
_reset()
ask("p", 500, ctx({}))
assert.equal(probe("p", {}), null, "one failure is not enough under the default")
ask("p", 500, ctx({}))
assert.equal(probe("p", {})?.[0], 429, "the shipped default threshold is 2")

// `message` replaces the refusal's text, and nothing else
_reset()
const told = { ...opts, message: "the volt is out; pick another" }
ask("q", 500, ctx(told))
ask("q", 500, ctx(told))
assert.equal(probe("q", told)?.[1], "the volt is out; pick another", "the message option is the refusal's whole text")

// a reply that names its model only in body.response.model is still counted:
// onResponse falls back to it when the request left nothing on the state
_reset()
const named = { state: {}, status: 500, rejected: null, reject: () => {} }
onResponse({ response: { model: "r" } }, named)
onResponse({ response: { model: "r" } }, named)
assert.equal(probe("r")?.[0], 429, "body.response.model names the model when the state has none")

// opts() keeps only what it can use: the rest is the default
_reset()
const junk = { failures: 0, window: -5, cooldown: "soon", max: null, status: "500", message: 7 }
ask("s", 500, ctx(junk))
assert.equal(probe("s", junk), null, "failures 0 falls back to the default 2")
ask("s", 500, ctx(junk))
assert.equal(probe("s", junk)?.[0], 429, "…so two failures still rest it")
assert.match(probe("s", junk)[1], /is resting/, "a message that is not a string is ignored")

// status that is not a non-empty array is ignored, so the default list stands
_reset()
ask("t", 500, ctx({ ...opts, status: [] }))
ask("t", 500, ctx({ ...opts, status: [] }))
assert.equal(probe("t", { ...opts, status: [] })?.[0], 429, "status [] leaves the default list in place")

// a max below the cooldown is raised to it: a rest must never shrink
_reset()
const tight = { ...opts, cooldown: 2, max: 1 }
ask("u", 500, ctx(tight))
ask("u", 500, ctx(tight))
assert.match(probe("u", tight)?.[1], /2s left/, "the first rest is the cooldown")
await ms(2100)
assert.equal(probe("u", tight), null, "the probe after a rest is let through")
ask("u", 500, ctx(tight))
assert.match(probe("u", tight)?.[1], /2s left/, "max under the cooldown cannot shorten the second rest")

console.log("retry.middleware: all checks passed")
