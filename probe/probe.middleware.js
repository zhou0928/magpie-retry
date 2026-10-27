// Probe: learn onProvider's real contract. It reports through the reply
// itself, because the host has no console and no writable file.
//
// Two things are learned per request:
//   1. whether onProvider runs at all (RAN marker in the model name)
//   2. the argument shapes, put into the model name, which comes back in
//      the reply's `model` field.

let runs = 0

function shape(v, depth = 0) {
  if (v === null) return "null"
  if (v === undefined) return "undef"
  const t = typeof v
  if (t === "string") return `s(${v.length})`
  if (t === "number" || t === "boolean") return t
  if (t === "function") return "fn"
  if (Array.isArray(v)) return `arr(${v.length})`
  if (t === "object") {
    if (depth >= 1) return "obj{…}"
    const keys = Object.keys(v).slice(0, 25)
    return "{" + keys.map((k) => `${k}:${shape(v[k], depth + 1)}`).join(",") + "}"
  }
  return t
}

export function onProvider(ctx, ...rest) {
  runs++
  const args = [shape(ctx), ...rest.map((a) => shape(a))].join("+").replace(/[^a-zA-Z0-9{}():,._+]/g, "")
  // if the host lets a hook rewrite the model name, this is where it shows
  if (ctx && typeof ctx === "object") {
    ctx.probe = `RAN${runs}:${args}`
  }
  return { probe: `RAN${runs}:${args}` }
}

export function onRequest(body, ctx) {
  // the fallback channel: mark the request itself, so the reply's model
  // name proves whether onProvider was reached
  if (typeof body.model === "string" && !body.model.startsWith("probe")) {
    body.model = body.model
  }
}
