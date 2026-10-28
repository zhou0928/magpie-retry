# magpie-retry

A circuit breaker for [magpie](https://usemagpie.ai)'s gateway. A model that
keeps failing rests for a while: requests to it are refused at once with a
**429**, so the agent backs off and retries on its own clock instead of paying
a connection timeout every turn.

```sh
magpie plugin add github:zhou0928/magpie-retry
magpie plugin options magpie-retry '{"failures": 1}'
```

> **Status: reviewed upstream, not merged.** magpie's maintainer ran this inside
> magpie's real gateway and found that the count cannot hold there — see
> [What an upstream review found](#what-an-upstream-review-found). Per-model
> resting belongs in magpie's own gateway, next to its fallback cooldown
> (`internal/gateway/fallback.go`), where it has shared state and can hand the
> request to the fallback instead of refusing it. The PR was closed
> ([plugins#433](https://github.com/magpie-community/plugins/pull/433)); this
> repository is kept as a record.

## Options

```json
{ "failures": 2, "window": 60, "cooldown": 120, "max": 600, "status": [429, 500, 502, 503, 504] }
```

- **`failures`.** How many failures inside `window` rest the model. 2 by default.
  Lower would make the rest come sooner, but the count does not hold in
  practice — see [What an upstream review found](#what-an-upstream-review-found).
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

## What an upstream review found

It was run inside magpie's real gateway (`origin/main`, sandbox `HOME`, fake
upstreams, `failures: 2`, `cooldown: 10`) and does not behave as designed.
[The review](https://github.com/magpie-community/plugins/pull/433) in full:

- **The count does not hold.** magpie takes each request's runtime from a Go
  `sync.Pool`, which is per-CPU and is emptied on GC — so it is not one shard
  per runtime. Sequential failing requests took **7** failures to trip with
  `failures: 2`; refusals alternated between “10s left” and “20s left”; after
  the upstream recovered, later requests were still refused by other runtimes;
  and four 500s ~33s apart never tripped it at all. Module-level state is not a
  place a middleware can keep shared state today
  ([magpie#3869](https://github.com/yetone/magpie/issues/3869)).
- **It sits on top of magpie's own retrying.** For 408/5xx/529 magpie already
  retries 7 times over ~33s, and for an upstream 429 for ~37s while resting the
  key. This plugin then adds a rest of its own, and counts magpie's final 429 as
  a failure.
- **It blocks working fallbacks.** With `provider fallback A → B`, magpie served
  every A failure from B at once. Once A and B were both briefly down and B
  recovered, 6/6 requests were refused with “A is resting … Use another model”
  and B received none — because `ctx.reject` runs before the provider loop.
- **Streamed failures are missed.** An OpenAI-style `data: {"error":…}`
  mid-stream reaches the client as a 200 and is never counted (10 in a row, no
  rest); a role-only `choices` chunk counts as an answer; and Responses'
  `response.failed` is not handled.
- **The 429 carries no `Retry-After`**, and the default rest (120–600s) is
  longer than most agents' retry budget.

What that leaves: per-model resting is magpie's own to do, next to its fallback
cooldown in `internal/gateway/fallback.go`, where it has shared state and can
hand a request to the fallback instead of refusing it. magpie's `resting` seats
and `magpie provider fallback` already hold that state in Go and are not
sharded.

## Install

```sh
magpie plugin add github:zhou0928/magpie-retry
```

A local checkout works too: `magpie plugin add ./magpie-retry`.

No restart is needed: a change to `plugins.json` or to a middleware's file is
picked up by the next request, at most a second later. Settings → Plugins shows
what a middleware really served — its hooks, calls, average µs and failures.

`magpie plugin list` can't tell you: it runs in a process of its own, so the
counts there are always zero. The gateway's process is the one that counts.

中文：熔断器。某个模型在窗口期内失败到次数就先「休息」，休息期间的请求立刻被 **429** 拒绝——429 是各家 agent 都自带退避重试的状态码，让重试跑在 agent 自己的节奏上，而不是每轮干等一次连接超时。休息结束后的探测请求再失败，休息时间翻倍（`cooldown` → 2× → 4× …）直到 `max` 秒封顶，站点一直不通时每轮只烧一次超时；回复正常则立刻清零，休息时长也重置回 `cooldown`。

注意：**这个插件不换模型**。`ctx.reject` 在 `onRequest` 就把请求截断了，magpie 的 provider 候选循环（`serve`）根本进不去，所以不存在「插件触发 fallback」这回事——agent 拿到 429 自己重试。换模型是 `magpie provider fallback` 的事，而且两者不叠加。

**上游实测：计数不成立**。magpie 的每个请求从 Go 的 `sync.Pool` 取 runtime，池**按 CPU 分片、GC 时清空**，不是「每个 runtime 一份」。实测：配 `failures: 2` 时顺序失败要 **7 次**才熔断；拒绝消息在 "10s left"/"20s left" 之间跳；上游恢复后仍有请求被别的 runtime 拒；四次 500 间隔 33s **从头到尾没触发**。中间件今天没有可用的跨请求存储（另见 [#3869](https://github.com/yetone/magpie/issues/3869)）；`ctx.state` 是单个请求的，`ctx` 没有跨请求的键值。要做按模型休息，该做进 magpie 网关 `internal/gateway/fallback.go`（挨着 fallback cooldown）：那里有共享状态，能把请求交给 fallback 而不是拒绝。magpie 自己的 routing `resting` 席位和 `provider fallback` 是 Go 里实现、不分片的。

**而且它有副作用**：**会挡住能用的 fallback**——实测把 A、B 都短暂打挂、B 恢复后 6/6 请求被 "A is resting… Use another model" 拒掉，B 一次没收到；**还叠在 magpie 自己的重试之上**——408/5xx/529 magpie 本来就重试 7 次约 33s，上游 429 重试约 37s 并让 key 休息，插件再加一层，还把 magpie 最后那次 429 记成失败。另外**不需要重启**：plugins.json 或中间件文件改动，下一次请求（最多迟一秒）就重新加载；真正的计数在网关进程里，用 `magpie plugin list` 看永远是 0，要看请开 Settings → Plugins。

## Test

```sh
bun test
```

`cases.json` is the suite's source of truth and is shared: it is the copy the
community package runs
([magpie-community/plugins PR #433](https://github.com/magpie-community/plugins/pull/433),
closed unmerged),
as is `middleware.mjs`, which calls the hooks the way magpie's gateway does.
`retry.test.mjs` adds what needs the clock — a rest that doubles up to `max`,
a rest that cannot shrink, a failure sliding out of the window — and differs
from the community copy by one line, its import.

To pull the community copies in, copy these two files from
`packages/retry/` and `scripts/` of the community repo:

- `cases.json` → `./cases.json`
- `scripts/middleware.mjs` → `./middleware.mjs`
