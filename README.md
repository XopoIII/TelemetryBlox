# TelemetryBlox

**A Roblox game server's telemetry pipe, and the Cloudflare Worker that receives it and tells the
owner what is worth telling.**

One call on the server writes a row: `telemetry.emit("purchase", player, { robux = 25 })`. It returns
at once, never yields and cannot raise. The rows wait in a bounded ring and leave in batches for an
ingest of the game's own, a Cloudflare Worker with a D1 database, where they are read with SQL. The
same Worker sends the rows that matter (an error, a failed save, a purchase) to a Telegram chat.

TelemetryBlox is two things in one repository:

- **A pesde package**, `xopoiii/telemetryblox`, target `roblox_server`: the pipe. Luau in `src/`.
- **A Worker**, TypeScript in `worker/`, as an npm package a game installs **by git tag** and
  deploys as a project of its own: its own Worker name, its own D1 database, its own secrets.
  Nothing is shared between two games' deployments but this code.

It was built and used inside a live game before it became a package, and holds nothing of any
game: every event name, endpoint, secret's name, alert rule and threshold is handed in.

> **Status: 0.8.6.** The pipe's rules and Roblox's analytics are proven by 119 specs that run off
> Roblox on LuneBlox, and each of 226 small slips in the code makes the suite fail
> (`tests/Mutate.luau`). The Worker's 100
> tests run against Node's own SQLite, which D1 is, and a smoke gate serves the built Worker in
> local `workerd`. **The engine adapter has not run in a Roblox server here:**
> `src/RobloxServices.luau`, which posts the batches and makes the `AnalyticsService` calls, is
> checked against the Roblox API by the type gate only. The changelog's "Not done" says what that leaves unproven. Try it in a test place first.

## The pipe, in a game

```sh
pesde add xopoiii/telemetryblox -t roblox_server -a TelemetryBlox
```

or pin it exactly in `pesde.toml`:

```toml
[dependencies]
TelemetryBlox = { name = "xopoiii/telemetryblox", version = "=0.8.6", target = "roblox_server" }
```

It has no dependencies. The experience needs **Allow HTTP Requests** on.

### The event name is a type

A game declares its vocabulary as a union of string literals, in one module, and makes its telemetry
with that type. A name outside the union then does not compile: not in `emit`, not in the table of
priorities, not in a listener.

```lua
-- server/Telemetry.luau: the only module of the game that knows TelemetryBlox.
local TelemetryBlox = require(path.to.TelemetryBlox)

export type EventName = "join" | "leave" | "feed" | "purchase" | "save_failed" | "server_error" | "telemetry_drop"

local options: TelemetryBlox.Options<EventName> = {
	game = "example",
	-- This game's own, and never changed: changing it makes every player a new one in the data.
	salt = "example/telemetry/actor/v1:5d0c41aa",
	-- The Worker's /ingest. Nil or "" collects and sends nothing.
	endpoint = "https://example-telemetry.<account>.workers.dev/ingest",
	-- The NAME of the experience secret that holds the ingest key; never the key.
	secretName = "ExampleTelemetryKey",
	-- Every event, and how it waits.
	events = {
		join = "protected",
		leave = "protected",
		feed = "bulk",
		purchase = "urgent",
		save_failed = "urgent",
		server_error = "urgent",
		telemetry_drop = "protected",
	},
	-- What the pipe reports its own losses as.
	dropEvent = "telemetry_drop",
}

-- The two annotations carry the vocabulary. Without the one on the result, names are unchecked.
local telemetry: TelemetryBlox.Telemetry<EventName> = TelemetryBlox.new(options)

return telemetry
```

```lua
-- First, before anything that could raise.
Telemetry.captureErrors("server_error")
Telemetry.start()

Telemetry.emit("purchase", player, { robux = 25, key = "boost" })
Telemetry.emit("feed", nil, { food = "leaf" }) -- a row about no player
Telemetry.emit("purchse", player) -- does not compile
```

`tests/consumer/Game.luau` is this, in full, type-checked under both solvers;
`tests/consumer/Misuse.luau` holds eight misuses that must fail to compile, and the type gate checks
that each does.

### What `emit` promises

- **It returns at once, never yields and cannot raise, whatever it is given.** A call it can make
  nothing of (a name outside the vocabulary, a number where the player belongs, a context that is
  not a table) is counted as refused and said in the next drop row.
- **No player id leaves the server.** A row about a player carries `u_` and 16 hex digits: a salted
  pseudonym made before the row exists. The same player gives the same pseudonym every time; another
  game's salt gives another. The library never reads a player's name. What a game writes into a
  context itself is the game's: the library does not read it.
- **A row keeps a clean copy of its context.** Strings (cut at 1000 bytes, never inside a
  character), finite numbers, booleans and tables of these to four levels. A NaN, an infinity, an
  Instance or a function is left out of its row, which still lands. Both limits are the game's to
  set (`maxStringBytes`, `maxDepth`): a game whose rows carry a whole error message raises the
  first, and its posts grow by as much.

### How the rows leave

| | |
|---|---|
| A post | every 180 s (`flushSeconds`), and only when something waits; at most 1000 rows (`maxBatch`) |
| Sooner, on the next 60 s wake (`tickSeconds`) | an `urgent` row waits, a refused batch is held, or half a batch waits |
| The bulk ring | 2000 rows (`ringSize`), oldest dropped first |
| The protected ring | 500 rows (`protectedSize`) that the bulk stream cannot evict: `protected` and `urgent` events |
| A refused batch | held and sent again as the same rows, 3 posts in all (`maxTries`), then counted lost |
| A batch answered 429 | the ingest asking for time: held and sent again on the next wake without spending a try, for up to 10 posts of one batch; past that a 429 costs a try like any refusal. The log says `try = 0` for a batch that has only waited |
| A loss | written into the stream as one row of `dropEvent`: `count`, and its parts `overflow` (a full ring), `send_failed` (the ingest never took the batch), `refused` (a call of no use) |
| Shutdown | the drain posts what waits, waits for the leaving players' last rows, and ends once the server has been empty and silent for 2 s (`closeQuiet`) or 20 s have passed (`closeBudget`) |
| Studio | never sends. The ring still fills, so `recent()` reads back |
| The first wake | staggered within one tick by the hash of the server's job id, so a fleet that started together does not post together |

### The API

`TelemetryBlox.new(options, services?)` returns a `Telemetry<EventName>`:

| | |
|---|---|
| `emit(name, player?, context?)` | writes one row |
| `onEmit(listener) -> stop` | hears every row as it is written: `(name, player?, context)`. A second sink (Roblox's own analytics) is built on it. A listener must not yield |
| `captureErrors(event)` | reports every server error as a row of `event`: `message`, `script`, `trace`, `count`. Deduplicated by message: the first three, then the 10th, 100th, 1000th. Each reported one is also said to `log` under the event's name, with its `script`, `message` and `count` |
| `start()` | spawns the flusher and binds the shutdown drain |
| `actorOf(userId) -> string` | the pseudonym a player's rows carry, for a row that names a player who is not on this server |
| `recent(count?) -> { Row }` | a copy of the rows still waiting: `{ seq, t, event, actor?, ctx }` |
| `drops()`, `backlog()` | rows lost since the last drop row; rows waiting to leave |
| `flush() -> boolean`, `drain()` | one post now; the shutdown drain by hand. Both yield |
| `destination` | where batches go; `""` when this server only collects |
| `analytics(options, sink?) -> Analytics` | tells Roblox's own analytics what every row about a player means ("Roblox's own analytics", below) |

`Options<EventName>`: `game`, `salt`, `secretName`, `events`, `dropEvent` are required; `endpoint`,
`environment` (what a server outside Studio is called: `"live"` by default, `"test"` for a test
place), `placeVersion`, `flushSeconds`, `tickSeconds`, `maxBatch`, `ringSize`, `protectedSize`,
`maxTries`, `closeBudget`, `closeQuiet`, `maxStringBytes` (1000), `maxDepth` (4) and `log` are optional. A wrong option is an error when the
telemetry is made, at boot: an endpoint is `https://` or empty (a plain one would carry the ingest
key in the clear), a count of rows or levels is a whole number, and `tickSeconds` never exceeds
`flushSeconds` (a slower tick would hold an urgent row longer than a regular post takes).

A priority is `"bulk"`, `"protected"` or `"urgent"`. The drop event is protected unless the game says
urgent, and cannot be bulk: the flood it reports would evict it.

### Roblox's own analytics

Roblox's Creator Hub draws an onboarding funnel, recurring funnels, progression paths, an economy
and custom events for a game that tells `AnalyticsService`, broken down by platform, OS, age, gender
and three custom fields of the game's. `telemetry.analytics(options)` tells it from the rows the
game already writes: the game says, in one pure function, which calls a row about a player is, and
the kit makes them within Roblox's limits.

```lua
local Calls = TelemetryBlox.Calls

local analytics = telemetry.analytics({
	-- What a row about a player is told as. Pure: plain data in, a list of calls out.
	map = function(name: EventName, player: Player, context): { TelemetryBlox.AnalyticsCall }?
		if name == "join" then
			return { Calls.onboarding("joined"), Calls.custom("Join") }
		elseif name == "feed" then
			return {
				Calls.custom("Fed", context.pieces, { [3] = context.food }),
				Calls.economy("sink", "Food", context.pieces, context.left, "Gameplay", context.food),
			}
		end
		return nil
	end,
	-- The three custom fields every call of this player carries, unless the call says its own.
	fields = function(player: Player): TelemetryBlox.AnalyticsFields
		return { [1] = "Desktop", [2] = "New" }
	end,
	-- FROZEN once published: Roblox keys a step by its number. Only ever add at the end.
	onboarding = { "joined", "fed" },
	leaveEvent = "leave",          -- a visit ends with it: the player is forgotten
	dropEvent = "analytics_drop",  -- what was lost, as a row: `dropped`, `invalid`
})
```

| Kind | Built with | Roblox's call |
|---|---|---|
| custom | `Calls.custom(name, value?, fields?)` | `LogCustomEvent`; `value` is 1 when left out |
| progression | `Calls.progression(path, "start" \| "complete" \| "fail", level, levelName?, fields?)` | `LogProgressionStartEvent`, `...CompleteEvent`, `...FailEvent` |
| funnel | `Calls.funnel(funnel, step, stepName, session?, fields?)` | `LogFunnelStepEvent` |
| onboarding | `Calls.onboarding(step, fields?)` | `LogOnboardingFunnelStepEvent`, numbered by the step's place in `onboarding` |
| economy | `Calls.economy("source" \| "sink", currency, amount, balance, transaction, item?, fields?)` | `LogEconomyEvent` |
| journey | `Calls.journey(journey, node, session?, fields?)` | `LogJourneyEvent` |

What the kit holds to:

- **A budget.** Roblox allows a server 120 calls a minute and 20 more a player, and loses the rest
  unseen. The kit holds to `limit` (60) and `perPlayer` (10) more for each player on the server,
  in any sixty seconds; a call past it is dropped and counted, never queued. Neither may be set
  above Roblox's own.
- **Calls Roblox could take.** A call is checked before it is made: names are non-empty, numbers
  finite, a level whole from 1, a funnel step whole from 1 to 100, an amount above 0, a field one of
  three and a non-empty string. One that is not is refused, counted as invalid and said to `log`
  once.
- **Roblox's caps.** A new custom event name past the 100th, a funnel past the 10th (the onboarding
  funnel is one) or a currency past the 10th is refused, and a name used before is told as ever.
- **An onboarding step once a visit.** A step the budget refused is not marked, so it is told the
  next time it comes. A step outside `onboarding` is refused.
- **A funnel's run.** A funnel step with no `session` is of the player's current run of that
  funnel, and step 1 opens a new one (`<job id>-<n>`): a recurring funnel needs no id of the game's.
- **Nothing can hurt the game.** A map or a `fields` that raises costs its own row and is counted as
  invalid. Each call to the engine runs on its own thread under pcall. `emit` stays total.
- **What was lost is a row.** At most once a minute and in the shutdown drain, a row of `dropEvent`
  says how many calls were `dropped` and how many were `invalid`.
- **Studio tells nobody**, and neither does a `Services` bundle without `analytics`. A spec passes a
  sink of its own, the second argument, and reads the calls it was handed.

`Analytics`: `tell(player, calls)` for a fact the game writes no row of, `forget(player)`,
`dropped()` and `invalid()` (not yet reported), `stop()`. A second `analytics` call raises, as
does an option that is wrong.

### A game's own specs

Everything of Roblox the pipe touches is one table, `TelemetryBlox.Services` (the clock, `task.wait`,
the HTTP request, the secret, the player count, the close, Roblox's analytics). A game passes none and gets the engine's;
a spec passes its own as the second argument of `new` and moves the clock itself.
`tests/fakes/World.luau` is such a table.

## The Worker, in a game

A game's `telemetry/` folder:

```
telemetry/
  package.json      depends on this repository by tag
  wrangler.jsonc    the Worker's name, the D1 binding, the cron
  src/config.ts     the game's alert table, thresholds, retention
  src/index.ts      export default createWorker(config)
  test/             the game's own tests of its table
  queries/          the game's saved questions, one .sql a question
```

```json
{
	"name": "example-telemetry",
	"private": true,
	"type": "module",
	"scripts": {
		"test": "node --test test/",
		"queries": "telemetryblox-check-queries queries",
		"deploy": "wrangler deploy"
	},
	"dependencies": {
		"telemetryblox": "github:XopoIII/TelemetryBlox#v0.8.6"
	},
	"devDependencies": {
		"wrangler": "4.147.0"
	}
}
```

```ts
// src/config.ts
import { field, short, type WorkerConfig } from "telemetryblox";

export const config: WorkerConfig = {
	game: "Example", // said in every message
	tag: "example", // the `game` option of the Luau side, when it differs
	alerts: {
		save_failed: "critical", // the shortest rule: a weight
		telemetry_drop: "warning",
		purchase: { severity: "info", text: (event, who) => `Purchase: ${short(field(event.ctx, "key"))}, player ${who}` },
		server_error: {
			severity: "critical",
			per: (event) => short(field(event.ctx, "message"), 60), // one alert a message
			text: (event) => `Server error in ${short(field(event.ctx, "script"), 80)}: ${short(field(event.ctx, "message"))}`,
		},
		receipt: { severity: "warning", when: (event) => field(event.ctx, "outcome") === "unknown", per: "actor" },
	},
	scan: [{ name: "rejects", event: "net_reject", measure: "sum", field: "count", missing: 1, limit: 200 }],
	retentionDays: 60,
};
```

```ts
// src/index.ts
import { createWorker } from "telemetryblox";
import { config } from "./config.ts";

export default createWorker(config);
```

```jsonc
// wrangler.jsonc
{
	"name": "example-telemetry",
	"main": "src/index.ts",
	"compatibility_date": "2026-10-01",
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "example-telemetry",
			"database_id": "<printed by wrangler d1 create>",
			"migrations_dir": "node_modules/telemetryblox/worker/migrations"
		}
	],
	// One trigger, every hour, off the hour: the free plan allows five an account.
	"triggers": { "crons": ["17 * * * *"] },
	"observability": { "enabled": true }
}
```

The package is the JavaScript built into `worker/dist` and committed; a tag is its release. The
migrations, the example queries and the testing helpers ride in the same package.

### The config

| Field | Default | |
|---|---|---|
| `game` | required | The name said in every message |
| `tag` | `game` | The game's tag as its server says it. A batch tagged for another game is refused |
| `alerts` | none | Event name to `"critical"`, `"warning"`, `"info"`, or to a rule: `severity`, `when`, `per` (`"event"`, `"actor"` or a function), `text`, `cooldownSeconds`, `channel`, `burst` (`{ count, seconds }`). An event outside the table sends nothing |
| `cooldownSeconds` | `{ critical: 600, warning: 1800, info: 0 }` | Seconds a repeat of each weight is held. 0: never held |
| `maxAlertsPerBatch` | 8 | Alerts one batch, or one scan, may send |
| `scan` | none | The hourly scan: for each player, the `rows` of an event, the `sum` of a context field or its `max`, and the `limit` at or over which somebody is told |
| `digest` | the events of `alerts` | `{ events, text }`, or `false` for no digest |
| `retentionDays` | 60 | Days raw batches are kept |
| `alertStateDays` | 7 | Days an alert's cool-down state is kept after it last went |
| `maxRawEvents` | 2,000,000 | Raw events kept once rolled up, whatever their age (about 300 MB). D1 holds this plus the day being collected, and the sum must fit the plan: on the free plan's 500 MB, a game sending more than about a million events a day sets it lower |
| `nightlyHourUtc` | 3 | The hourly run that is also the nightly one |
| `nightlyReadWarn` | 2,000,000 | Rows of D1 a night may read before it sends a warning (two fifths of the free plan's day) |
| `environments` | `live`, `studio`, `test` | What a batch may call its server. Only `live` alerts |
| `maxBodyBytes`, `maxEvents` | 1,000,000, 2000 | The bounds on a body |
| `maxBatchesPerMinute`, `maxServerBatchesPerMinute` | 1,200, 60 | How fast batches may arrive, over every server and from one (by job id). The surplus is refused with a 429, which the pipe holds and posts again without spending a try: a delay for a running server, and a loss only for a closing one still refused when its drain's budget ends. A running server posts once a tick; a closing one posts its backlog back to back, three batches and a few with the pipe's defaults |
| `marks` | `[critical]` `[warning]` `[info]` `[digest]` `[notice]` `[roblox]`, and `cut`: `...` | What starts each kind of message, and what ends a value that was cut short |
| `robloxPrefix` | `marks.roblox` and the game's name | `(kind) => string`: what starts a Roblox webhook's message, by its kind (`erasure`, `test`, `refund`, `event`, `alert`) |
| `channels` | none | More chats than the one, by name: `{ money: { token: "MONEY_BOT_TOKEN", chat: "MONEY_CHAT_ID" } }` names the two secrets of another bot and chat. An alert rule with `channel: "money"` is sent there |
| `robloxChannel` | none: every webhook to the chat | `(kind) => string \| undefined`: the channel a Roblox webhook of a kind is sent to |
| `bindings` | `DB`, `INGEST_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ALERT_TOKEN`, `ANNOUNCE_WEBHOOK` | What the D1 binding and each secret are called |
| `erasureHint` | none | The line a right-to-erasure message ends with |

A wrong config throws when the Worker loads, not on the first batch.

### What the Worker does

| Door | |
|---|---|
| `POST /ingest` | A batch, with the key in `x-api-key`. Checks the key in constant time, bounds the body, refuses a batch from a newer pipe, stores the batch as one row, and stores it once however often it arrives |
| `GET /health` | `{ ok: true }`. With `?deep=1` and the key: live batches, the newest one's age and place version |
| `GET /retention`, `GET /anomalies` | The nightly job and the hourly scan, by hand, with the key |
| `POST /notify` | `{ "text": "..." }` with the key: a line from the game's own tools (a publish) |
| `POST /announce` | `{ "title": "...", "text": "...", "url"?: "https://..." }` with the key: a release told to the players, one embed to the game's Discord webhook. Nobody is pinged; the title and the lines are cut to Discord's 256 and 4,096. 503 without the webhook's secret, 502 with Discord's status when it refuses |
| `POST /roblox-alert?token=` | Roblox's webhooks (an analytics alert, a refund, a right-to-erasure request), with the webhook token in the URL |

**Alerts are quiet by rule.** A row of the table raises its message when its batch is stored, gravest
first, ending with the place version. A repeat of the same kind inside its cool-down is held and
counted, and the next one past it says `(+N held since the last)`. A kind with no cool-down is never
held. A batch sends eight at most. A batch from Studio or a test place alerts nobody. A Telegram
outage never costs a batch: it is stored first.

**A fault that is expected now and then can wait for a crowd.** A rule's `burst: { count, seconds }`
counts its rows from every server together, and sends only from the batch that takes a window to
`count`, saying `(N within S s)`; the rest of that window is quiet, and the next window starts over
with the rows that open it. The cool-down then applies as to any alert. A retried write that a
storage service refuses for a moment is the case: one is noise, a hundred in ten minutes is an
outage. The window is kept in `alert_state` beside the cool-downs, so no migration is added.

**A game may keep some messages apart**, its purchases from its faults, say. `channels` names
another bot and chat by their two secrets, a rule's `channel` sends its alert there, and
`robloxChannel` does the same for a kind of Roblox webhook. The scan, the digest and a notice go to
the chat. A channel either of whose secrets is not set sends to the chat and writes
`alert_channel_unconfigured` with its name to the log, so the config can be deployed before the
secrets are put and no message is lost in between. A rule that names a channel `channels` does not
hold is a wrong config, and throws as the Worker loads.

**Every hour** the scan reads the live batches since its last run and says who stood at a limit,
and the size wall takes the batches past `maxRawEvents` that the night has rolled up: never the day
being collected, nor a batch `actors` has not read. When those alone are over the budget, the night
says so as a warning, since past the plan's size D1 refuses the ingest: that insert answers 507
`storage_full`, any other fault 500.
**Every night** the job rolls each finished day up into `events_daily`, keeps who was first seen when
(`actors`), prunes raw batches past `retentionDays` or `maxRawEvents`, and sends yesterday in one
message. It expands each event about twice: `actors` reads the batches after its cursor, and the
roll-up the days after the last one rolled up, per event and as a whole from one expansion. Each
event expanded is a row read, and past D1's free plan's five million a day D1 refuses the ingest
too, so a night that reads more than `nightlyReadWarn` says so as a warning.

## Setting a game up

Nothing below is done by this repository; each game does it once for itself.

```sh
cd telemetry
npm install

# 1. The database. Paste the id it prints into wrangler.jsonc.
npx wrangler d1 create example-telemetry
npx wrangler d1 migrations apply example-telemetry --remote

# 2. The Worker.
npx wrangler deploy

# 3. The three secrets of the Worker. Each asks for its value; none is ever written in a file.
npx wrangler secret put INGEST_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put ALERT_TOKEN        # only for Roblox's webhooks; any long random string

# 4. Is it up, and does the key open it?
curl -s https://example-telemetry.<account>.workers.dev/health
curl -s -H "x-api-key: $TELEMETRY_INGEST_KEY" "https://example-telemetry.<account>.workers.dev/health?deep=1"
```

A later version of the kit: bump the tag in `package.json`, `npm install`, run
`npx wrangler d1 migrations apply example-telemetry --remote` again (it applies only what the
database has not seen), and deploy.

### The ingest key lives in three places, and they must match

| Where | What it is called | Set with |
|---|---|---|
| The game's local env file, git-ignored (the copy of record) | `TELEMETRY_INGEST_KEY`, say | by hand: `openssl rand -hex 32` |
| The Worker's secret | `INGEST_KEY` (`bindings.ingestKey`) | `npx wrangler secret put INGEST_KEY` |
| The experience's secret, read by `HttpService:GetSecret` | the game's `secretName` | Creator Hub, the experience's Secrets, or Open Cloud's secrets API |

The experience's secret has a **domain**: the Worker's exact host, with no scheme and no path
(`example-telemetry.<account>.workers.dev`). An empty or wrong domain raises no error: the engine
refuses to hand the secret over, the batch goes with no key, and every post is answered 401, which
looks exactly like "no data yet". `GetSecret` does not work in Studio, which is one reason Studio
never sends; a green playtest is no evidence that the pipe works.

Order matters when redoing it: point the game at the ingest last. A game pointed at an ingest that
does not answer fills its protected ring with drop rows.

### The bot's token and the chat's id

1. In Telegram, `@BotFather`, `/newbot`: it gives the **bot token**.
2. Write anything to the bot (or add it to a group), then open
   `https://api.telegram.org/bot<token>/getUpdates`: `chat.id` in the answer is the **chat id**. A
   bot that already has a webhook answers 409 until `deleteWebhook` is called.
3. Set both as secrets of the Worker (step 3 above). They are never written in a repository, in a
   game's env file or in the experience's secrets.
4. Try it: `curl -s -X POST -H "x-api-key: $TELEMETRY_INGEST_KEY" --data '{"text":"hello"}' https://<worker host>/notify`.

A channel of `channels` is set up the same way, with a bot and a chat of its own and the two secret
names the game gave it in the config.

Without them the Worker writes what it would have sent to its log (`alert_unconfigured`) and
everything else works as before.

### The players' Discord channel

1. In Discord, the channel's settings, Integrations, Webhooks, New Webhook: copy its URL. An
   Announcement channel lets other servers follow it.
2. `npx wrangler secret put ANNOUNCE_WEBHOOK` (or the name of `bindings.announceWebhook`) and paste
   the URL. It holds the webhook's token: it is never written in a repository, a chat or a log line.
3. Try it: `curl -s -X POST -H "x-api-key: $TELEMETRY_INGEST_KEY" --data '{"title":"Hello","text":"A first post"}' https://<worker host>/announce`.

## The wire

A batch is one JSON object, posted with `content-type: application/json` and the key in `x-api-key`:

```json
{
	"schemaVersion": 1,
	"game": "example",
	"universeId": "111",
	"placeId": "222",
	"placeVersion": 7,
	"jobId": "<game.JobId; in Studio a made-up one, `studio-<guid>`>",
	"env": "live",
	"serverStart": 1800000000,
	"sentAt": 1800000035,
	"events": [
		{ "seq": 2, "t": 1800000030, "event": "purchase", "actor": "u_b6143fd8f67c8ca4", "ctx": { "robux": 25 } },
		{ "seq": 1, "t": 1800000000, "event": "feed", "ctx": {} }
	]
}
```

`seq` numbers a server's rows from 1; `t` is Unix seconds; `actor` is absent for a row about no
player. The protected rows of a batch come first. Roblox encodes an empty context as `[]`, which the
Worker reads as `{}`. **A batch's identity is `(jobId, serverStart, the smallest seq)`**: a batch sent
again carries the same three and is stored once.

JSON has no value that is both an array and an object. A context table with an array part and named
fields is whole in the row's copy (`recent()`, a listener), and the encoder decides what leaves:
Roblox's `JSONEncode` is documented to write the array part alone, and nothing here has run it. Give a
field that must be stored a table of its own.

`tests/wire/batch.json` is one such batch, and both halves are checked against it: a spec proves the
pipe posts exactly it, and a test proves the Worker stores exactly it.

The Worker answers `200 { ok, accepted, skipped, duplicate }`, `401` (the key), `413` (the body),
`400 { error: "invalid_envelope", detail }`, `429 { error: "rate_limited" }` (batches arrive faster
than `maxBatchesPerMinute` or `maxServerBatchesPerMinute`; the pipe holds the batch and sends it
again without spending a try) or `500` (the insert failed; the pipe sends it again).

**When the wire changes, the Worker goes first.** The ingest reads every `schemaVersion` up to its
own and refuses a newer one with a `400`, and a refused batch is lost after `maxTries` posts. So a
release that raises the version is deployed as a Worker before any game server that posts it is
published: an updated Worker reads an older pipe's batches, and an older Worker does not read a newer
pipe's. A release that leaves the version as it is (it is 1) can go out in either order.

### The tables

| | |
|---|---|
| `batches` | One row a batch: `id`, `received_at`, `env`, `schema_version`, `universe_id`, `place_id`, `place_version`, `job_id`, `server_start`, `first_seq`, `last_seq`, `n`, `events` (the JSON array). One unique index, on `(job_id, server_start, first_seq)` |
| `events` (view) | One row an event: `batch_id`, `received_at`, `t`, `seq`, `event`, `actor`, `ctx` (JSON text, read with `json_extract`), and the batch's columns. Every batch kept: a query over it costs the whole history |
| `events_day`, `events_week` (views) | The same rows, of the batches received in the last 26 hours and the last 8 days, reached by the index on `received_at` before an event is expanded. **What queries read** |
| `events_daily` | The roll-up kept after pruning: `day`, `event`, `env`, `universe_id`, `events`, `actors`. The row with event `*` is the whole day, and its `actors` is the day's players |
| `actors`, `first_seen` (view) | When each player was first seen and on which place version, kept before pruning |
| `alert_state`, `alert_cursor` | The cool-downs, and where the hourly scan stopped |

Never mix `env` values in an analysis: every query says `WHERE env = 'live'`.

## Queries

A game's saved questions are its own: SQL files in its `telemetry/queries/`, run with
`npx wrangler d1 execute <database> --remote --file queries/<name>.sql`. Two examples to copy are in
`worker/queries/`: `pipe-health.sql` (is the data trustworthy at all: read it first) and `daily.sql`.

A query reads `events_day` or `events_week`, not `events`. D1 counts every event a query expands as
a row read, and `events` expands every batch kept whatever the query's `WHERE t` says; on the free
plan's 5,000,000 rows a day, a game with two million events kept could ask two such questions a
day. A window's views reach their batches by the index on `received_at`, so a question costs the
window's rows. A question that needs more than a week reads `events_daily`, or `events` with
`received_at` narrowed in its own `WHERE`.

A game checks every query against an empty copy of the schema in its own gate, so one that names a
table or a column that does not exist fails there and not on launch day:

```sh
npx telemetryblox-check-queries queries
```

or in a test, with `checkQueries(directory)` and `freshDatabase()` from `telemetryblox/testing`,
which is also the D1 a game's own Worker tests stand on (Node's SQLite, which D1 is).

### Reading a local copy

The cheapest question is one D1 never sees. `telemetryblox-mirror` keeps a SQLite file on the
developer's machine with the kit's own schema, and brings it up to the database by primary key: a
batch already in the copy is never read again, so a pull costs one row a new batch (a few thousand a
day for a small game), plus the small tables `events_daily` and `actors` whole. Every saved query
then runs on the copy unchanged, with any SQLite of 3.38 or later (`sqlite3 copy.sqlite <
queries/day.sql`), as often as it is asked, for nothing. Run it where the game's wrangler config is:

```sh
npx telemetryblox-mirror <database> .mirror/<database>.sqlite
# mirror: 412 new batches, 433 rows read on D1 in 5 queries; newest batch received ..., 2 min ago
```

The copy keeps what D1's retention prunes, so its history only grows; it holds pseudonyms and
nothing else of a player, and still belongs in `.gitignore`. `WRANGLER` overrides how wrangler is
run. In code, `openMirror(file)`, `pull(db, remote)` and `wranglerRemote(database)` from
`telemetryblox/mirror`.

## The free plan

The ingest is sized for Cloudflare's free plan: a row a batch and one index (100,000 rows written a
day), one query an ingest (50 an invocation), one JSON parse and one stringify (10 ms of CPU), one
cron trigger (five an account). A server posts every three minutes when it has rows: about 480
requests and 1,900 rows written a day per server, so about fifty servers running all day is the
ceiling. Past it D1 refuses writes until midnight UTC; the pipe holds a refused batch, then counts
it lost as `send_failed`. Then: Workers Paid, or a larger `flushSeconds`.

Reads: 5,000,000 rows a day, and an expanded event is a row. The Worker's own jobs read the hour's
batches and the last two days'; what spends the reads is the questions a game asks, and that is
what `events_day` and `events_week` are for, and what a local copy spends nothing of ("Reading a
local copy"). Past the limit D1 refuses the ingest's inserts as well, so a day of questions asked of
D1 itself can lose that day's rows.

## Development

```sh
rokit install      # the pinned Luau toolchain
npm ci             # the Worker's tools
lefthook install   # the git hooks
```

| | |
|---|---|
| `sh scripts/run-tests.sh` | The pipe's specs, on LuneBlox |
| `luneblox run tests/Mutate --yes` | Every mutant must fail the suite |
| `sh scripts/type-check.sh` | luau-lsp, both solvers, and the misuses that must not compile |
| `sh scripts/check-worker.sh` | The Worker: tsc, Biome, `worker/dist` is what `worker/src` builds, its tests, the example queries |
| `npm run build` | Builds `worker/src` into `worker/dist`; commit the result |
| `sh scripts/check-package.sh` | The pesde archive carries all of `src/` |
| `lefthook run pre-commit --all-files` | Every pre-commit gate over the whole tree |

See [CLAUDE.md](CLAUDE.md) for the rules and [CHANGELOG.md](CHANGELOG.md) for what is and is not done.

## License

MIT. See [LICENSE](LICENSE).
