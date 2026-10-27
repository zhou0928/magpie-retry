# @magpie-community/middleware-retry

A circuit breaker for [magpie](https://usemagpie.ai)'s gateway. A model that
keeps failing rests for a while: requests to it are refused at once with a
**429**, so the agent backs off and retries on its own clock instead of paying
a connection timeout every turn.

```sh
magpie plugin add /Users/xiaozhou/magpie-plugins/middleware-retry
magpie plugin options retry '{"failures": 2, "cooldown": 120}'
```

## Options

```json
{ "failures": 2, "window": 60, "cooldown": 120, "max": 600, "status": [429, 500, 502, 503, 504] }
```

- **`failures`.** How many failures inside `window` rest the model. 2 by default,
  low because the count is sharded (see [Known limit](#known-limit-the-count-is-per-runtime)).
- **`window`.** Seconds the failures are counted over. 60 by default.
- **`cooldown`.** Seconds the model rests once it reaches `failures`. 120 by default.
- **`max`.** How long the rest may grow to. A model that fails again as soon as
  its rest is over rests twice as long next time — `cooldown`, `2×`, `4×` … up
  to `max`. 600 by default. A site that stays down then costs one timeout a
  round instead of a full `failures` of them.
- **`status`.** Which reply statuses count as a failure. A good reply clears
  the window and ends the rest, so a model that works again is trusted at once
  and gets its first rest back. A streamed reply never reaches `onResponse` and
  gives it no status: there an `error` event counts as a failure, and an event
  carrying content counts as a good reply. Merely connecting is not answering —
  a stream that opens and dies at once still counts as a failure.
- **`message`.** The refusal's text, in place of the default one.

## Why 429

The refusal is what tells the agent to try again, and 429 is the one code every
agent already backs off on: Claude Code, Codex and opencode all have a
rate-limit retry with backoff. A 503 reads as a broken server — agents retry it
a few times and give up.

## What it does not do

It does not fail over to another model, and it cannot. `ctx.reject` stops the
request in `onRequest`, and a rejected request never reaches `serve` — the one
place magpie's provider loop runs, the loop that hands a failed try to the next
model (`internal/gateway/middleware.go`: `writeError`, then `return`, before
`s.serve`). So there is no fallback for magpie to do here. The agent gets the
429 itself and retries.

Model failover is magpie's own, and separate:

```sh
magpie provider fallback <provider-id> <provider/model> <provider/model> …
```

The two do not compose: while a model rests, this plugin refuses the whole
request ahead of that chain, so the chain never runs for it.

## Known limit: the count is per runtime

magpie compiles a middleware once but runs each request in a runtime of its own,
taken from a pool (`docs/subsystems/gateway-middleware.md`: “each request gets a
runtime of its own”). A middleware's module state lives in that runtime, so this
plugin's failure count is **sharded over the pool** — measured on one magpie,
four runtimes served ten requests, and each kept its own count. A model resting
on one runtime is refused for the requests that land on it, not for all of them.

There is no cross-request store to keep this in: `ctx.state` is one request's,
and `ctx` has no key–value of its own. So the breaker trips, but only for its
share of the traffic. Lowering `failures` makes each shard trip sooner. The
`resting` seats of magpie's own routings, and `magpie provider fallback`, hold
that state in Go and are not sharded.

## Install

```sh
magpie plugin add /Users/xiaozhou/magpie-plugins/middleware-retry
```

No restart is needed: a change to `plugins.json` or to a middleware's file is
picked up by the next request, at most a second later. Settings → Plugins shows
what a middleware really served — its hooks, calls, average µs and failures.

`magpie plugin list` can't tell you: it runs in a process of its own, so the
counts there are always zero. The gateway's process is the one that counts.

中文：熔断器。某个模型在窗口期内失败到次数就先「休息」，休息期间的请求立刻被 **429** 拒绝——429 是各家 agent 都自带退避重试的状态码，让重试跑在 agent 自己的节奏上，而不是每轮干等一次连接超时。休息结束后的探测请求再失败，休息时间翻倍（`cooldown` → 2× → 4× …）直到 `max` 秒封顶，站点一直不通时每轮只烧一次超时；回复正常则立刻清零，休息时长也重置回 `cooldown`。

注意三点：**这个插件不换模型**。`ctx.reject` 在 `onRequest` 就把请求截断了，magpie 的 provider 候选循环（`serve`）根本进不去，所以不存在「插件触发 fallback」这回事——agent 拿到 429 自己重试。换模型是 `magpie provider fallback` 的事，而且两者不叠加。

**计数是分片的**：magpie 编译一份中间件，但每个请求各拿一个 runtime（来自一个池），模块状态存在 runtime 里，所以失败计数分散在池中的几个 runtime 上（实测：十个请求由四个 runtime 分担）。熔断会发生，但只对它自己那份流量生效；`ctx.state` 是单个请求的，`ctx` 没有跨请求的键值存储可用。把 `failures` 调小可以让每个分片更早熔断。要做全局熔断，magpie 自己的 routing `resting` 席位和 `provider fallback` 是 Go 里实现、不分片的。另外**不需要重启**：plugins.json 或中间件文件改动，下一次请求（最多迟一秒）就重新加载；真正的计数在网关进程里，用 `magpie plugin list` 看永远是 0，要看请开 Settings → Plugins。

## Test

```sh
bun retry.test.mjs   # or: node retry.test.mjs
```
