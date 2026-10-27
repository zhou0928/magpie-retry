// Circuit breaker for magpie's gateway: when a model keeps failing, stop
// sending it requests for a while instead of paying the timeout each turn.
//
//   {"failures": 2, "window": 60, "cooldown": 120, "max": 600,
//    "status": [429, 500, 502, 503, 504]}
//
// A request whose reply comes back with one of `status` counts as a failure.
// When a model reaches `failures` failures inside `window` seconds it rests
// for `cooldown` seconds: while it rests, requests to it are refused at once
// with a 429 naming the model and the seconds left. 429 is the code every
// agent backs off and retries on by itself, so the retry runs on the agent's
// clock instead of this request's timeout.
//
// A rest doubles each time the probe after it fails again, up to `max`
// seconds: a site that stays down costs one timeout a round, not a full set.
// A reply that comes back good — whole, or streamed — ends the rest and gives
// the model its first rest back.
//
// The count lives in this module, and magpie runs each request in a runtime of
// its own taken from a pool, so the count is sharded over that pool: a rest
// applies to the requests that land on the runtime which tripped. ctx.state is
// one request's, and ctx has no store of its own to keep this in.
//
// This does not retry a request itself: a middleware sees a request once and
// a reply after it, and cannot send the request again. Nor does the refusal
// fail over: ctx.reject stops the request in onRequest, before magpie reaches
// serve and the provider loop it hands a failed try to. The agent is the one
// that retries.

const DEFAULTS = {
  // 2, not 3: the count is sharded over the pool (below), so a threshold each
  // shard reaches sooner is what makes the rest happen for real traffic
  failures: 2,
  window: 60,
  cooldown: 120,
  max: 600,
  status: [429, 500, 502, 503, 504],
  message: "",
}

// state lives in this module: one runtime for the gateway, so a model's
// failures are seen by the next request. key is the model, the value is
// { hits: [ms…], until: ms, rest: ms, tripped: bool }.
const byModel = new Map()

export function onRequest(body, ctx) {
  const o = opts(ctx.options)
  const model = typeof body.model === "string" ? body.model : null
  if (!model) return
  // the reply's hooks see the same state: it is how onResponse knows which
  // model this status is about
  if (ctx.state) ctx.state.model = model
  const s = byModel.get(model)
  if (!s || !s.until) return
  const left = s.until - Date.now()
  if (left <= 0) {
    // the rest is over: this request is the probe. rest and tripped stay, so
    // a probe that fails again re-opens the model at once, resting longer
    s.until = 0
    return
  }
  const secs = Math.ceil(left / 1000)
  ctx.reject(429, o.message || `${model} is resting after ${s.hits.length} failures; ${secs}s left. Use another model.`)
}

export function onResponse(body, ctx) {
  const model = modelOf(body, ctx)
  if (!model) return
  const o = opts(ctx.options)
  record(model, ctx.status, o)
}

export function onEvent(ev, ctx) {
  const model = ctx.state && typeof ctx.state.model === "string" ? ctx.state.model : null
  if (!model) return
  const o = opts(ctx.options)
  // a streamed reply that ends in an error counts the same as a whole one:
  // the gateway hands onEvent the event's data itself, and an error event
  // (Anthropic's {type:"error"}) is the one that says the model failed.
  if (ev && ev.type === "error") {
    record(model, (ev.error && ev.error.status) || 500, o)
    return
  }
  // ...and a streamed reply that answers counts as a good one: its events are
  // the whole reply onResponse never sees. 200 is simply a status outside
  // `status`, which record reads as a good reply.
  if (answered(ev)) record(model, 200, o)
}

// answered says the model produced something rather than merely connected:
// the shapes are the ones the gateway speaks. A stream that opens and dies
// before any content is not a model that works again, and must not clear what
// its failures counted.
function answered(ev) {
  if (!ev || typeof ev !== "object") return false
  if (typeof ev.delta === "string") return ev.delta.length > 0 // Responses
  if (ev.delta && typeof ev.delta === "object") return true // Anthropic
  if (Array.isArray(ev.choices)) return ev.choices.length > 0 // OpenAI
  if (Array.isArray(ev.candidates)) return ev.candidates.length > 0 // Gemini
  return false
}

// record takes one reply's status for a model and, when it is one of the
// counted ones, adds it to the window; enough inside the window starts a rest.
// A failure after a rest has ended re-opens the model at once, with twice the
// rest, so a site that stays down stops costing a timeout every try.
function record(model, status, o) {
  const now = Date.now()
  let s = byModel.get(model)
  if (!s) byModel.set(model, (s = { hits: [], until: 0, rest: 0, tripped: false }))
  // while it rests, requests are refused in onRequest and never get here; a
  // reply that does arrive is one magpie served before the rest began
  if (s.until > now) return
  if (!o.status.includes(Number(status))) {
    // a good reply clears the window, ends the rest, and gives the model its
    // first rest back: a model that works again is trusted at once
    s.hits = []
    if (s.tripped) {
      s.tripped = false
      s.rest = 0
    }
    return
  }
  if (s.tripped) {
    // the probe after a rest failed: rest again, twice as long, up to max
    s.hits.push(now)
    s.rest = Math.min(s.rest * 2, o.max * 1000)
    s.until = now + s.rest
    return
  }
  const from = now - o.window * 1000
  s.hits = s.hits.filter((t) => t > from)
  s.hits.push(now)
  if (s.hits.length >= o.failures) {
    s.tripped = true
    s.rest = o.cooldown * 1000
    s.until = now + s.rest
  }
}

// modelOf is the model the reply is about: the one asked for, kept on the
// request's state, or the one the reply names.
function modelOf(body, ctx) {
  if (ctx.state && typeof ctx.state.model === "string") return ctx.state.model
  if (body && typeof body.model === "string") return body.model
  if (body && body.response && typeof body.response.model === "string") return body.response.model
  return null
}

function opts(raw) {
  const o = { ...DEFAULTS }
  if (raw && typeof raw === "object") {
    const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
    o.failures = num(raw.failures, DEFAULTS.failures)
    o.window = num(raw.window, DEFAULTS.window)
    o.cooldown = num(raw.cooldown, DEFAULTS.cooldown)
    // a max below the first rest would make a rest shrink, never grow
    o.max = Math.max(num(raw.max, DEFAULTS.max), o.cooldown)
    if (Array.isArray(raw.status) && raw.status.length) o.status = raw.status.map(Number)
    if (typeof raw.message === "string" && raw.message) o.message = raw.message
  }
  return o
}

// only for the tests below
export function _reset() {
  byModel.clear()
}
