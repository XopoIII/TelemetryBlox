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

> **Status: 0.4.1.** The pipe's rules are proven by 93 specs that run off Roblox on LuneBlox, and
> each of 185 small slips in the code makes the suite fail (`tests/Mutate.luau`). The Worker's 78
> tests run against Node's own SQLite, which D1 is, and a smoke gate serves the built Worker in
> local `workerd`. **What 0.4.0 changes has not yet run in a Roblox server or on Cloudflare:** the
> engine adapter (`src/RobloxServices.luau`) is checked against the Roblox API by the type gate
> only. The changelog's "Not done" says what that leaves unproven. Try it in a test place first.

## The pipe, in a game

```sh
pesde add xopoiii/telemetryblox -t roblox_server -a TelemetryBlox
```

or pin it exactly in `pesde.toml`:

```toml
[dependencies]
TelemetryBlox = { name = "xopoiii/telemetryblox", version = "=0.4.1", target = "roblox_server" }
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

`Options<EventName>`: `game`, `salt`, `secretName`, `events`, `dropEvent` are required; `endpoint`,
`environment` (what a server outside Studio is called: `"live"` by default, `"test"` for a test
place), `placeVersion`, `flushSeconds`, `tickSeconds`, `maxBatch`, `ringSize`, `protectedSize`,
`maxTries`, `closeBudget`, `closeQuiet`, `maxStringBytes` (1000), `maxDepth` (4) and `log` are optional. A wrong option is an error when the
telemetry is made, at boot: an endpoint is `https://` or empty (a plain one would carry the ingest
key in the clear), a count of rows or levels is a whole number, and `tickSeconds` never exceeds
`flushSeconds` (a slower tick would hold an urgent row longer than a regular post takes).

A priority is `"bulk"`, `"protected"` or `"urgent"`. The drop event is protected unless the game says
urgent, and cannot be bulk: the flood it reports would evict it.

### A game's own specs

Everything of Roblox the pipe touches is one table, `TelemetryBlox.Services` (the clock, `task.wait`,
the HTTP request, the secret, the player count, the close). A game passes none and gets the engine's;
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
		"telemetryblox": "github:XopoIII/TelemetryBlox#v0.4.1"
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
| `alerts` | none | Event name to `"critical"`, `"warning"`, `"info"`, or to a rule: `severity`, `when`, `per` (`"event"`, `"actor"` or a function), `text`, `cooldownSeconds`. An event outside the table sends nothing |
| `cooldownSeconds` | `{ critical: 600, warning: 1800, info: 0 }` | Seconds a repeat of each weight is held. 0: never held |
| `maxAlertsPerBatch` | 8 | Alerts one batch, or one scan, may send |
| `scan` | none | The hourly scan: for each player, the `rows` of an event, the `sum` of a context field or its `max`, and the `limit` at or over which somebody is told |
| `digest` | the events of `alerts` | `{ events, text }`, or `false` for no digest |
| `retentionDays` | 60 | Days raw batches are kept |
| `alertStateDays` | 7 | Days an alert's cool-down state is kept after it last went |
| `maxRawEvents` | 2,000,000 | Raw events kept whatever their age (about 300 MB) |
| `nightlyHourUtc` | 3 | The hourly run that is also the nightly one |
| `environments` | `live`, `studio`, `test` | What a batch may call its server. Only `live` alerts |
| `maxBodyBytes`, `maxEvents` | 1,000,000, 2000 | The bounds on a body |
| `maxBatchesPerMinute`, `maxServerBatchesPerMinute` | 1,200, 60 | How fast batches may arrive, over every server and from one (by job id). The surplus is refused with a 429, which the pipe holds and posts again without spending a try: a delay for a running server, and a loss only for a closing one still refused when its drain's budget ends. A running server posts once a tick; a closing one posts its backlog back to back, three batches and a few with the pipe's defaults |
| `marks` | `[critical]` `[warning]` `[info]` `[digest]` `[notice]` `[roblox]`, and `cut`: `...` | What starts each kind of message, and what ends a value that was cut short |
| `robloxPrefix` | `marks.roblox` and the game's name | `(kind) => string`: what starts a Roblox webhook's message, by its kind (`erasure`, `test`, `refund`, `event`, `alert`) |
| `channels` | none | More chats than the one, by name: `{ money: { token: "MONEY_BOT_TOKEN", chat: "MONEY_CHAT_ID" } }` names the two secrets of another bot and chat. An alert rule with `channel: "money"` is sent there |
| `robloxChannel` | none: every webhook to the chat | `(kind) => string \| undefined`: the channel a Roblox webhook of a kind is sent to |
| `bindings` | `DB`, `INGEST_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ALERT_TOKEN` | What the D1 binding and each secret are called |
| `erasureHint` | none | The line a right-to-erasure message ends with |

A wrong config throws when the Worker loads, not on the first batch.

### What the Worker does

| Door | |
|---|---|
| `POST /ingest` | A batch, with the key in `x-api-key`. Checks the key in constant time, bounds the body, refuses a batch from a newer pipe, stores the batch as one row, and stores it once however often it arrives |
| `GET /health` | `{ ok: true }`. With `?deep=1` and the key: live batches, the newest one's age and place version |
| `GET /retention`, `GET /anomalies` | The nightly job and the hourly scan, by hand, with the key |
| `POST /notify` | `{ "text": "..." }` with the key: a line from the game's own tools (a publish) |
| `POST /roblox-alert?token=` | Roblox's webhooks (an analytics alert, a refund, a right-to-erasure request), with the webhook token in the URL |

**Alerts are quiet by rule.** A row of the table raises its message when its batch is stored, gravest
first, ending with the place version. A repeat of the same kind inside its cool-down is held and
counted, and the next one past it says `(+N held since the last)`. A kind with no cool-down is never
held. A batch sends eight at most. A batch from Studio or a test place alerts nobody. A Telegram
outage never costs a batch: it is stored first.

**A game may keep some messages apart**, its purchases from its faults, say. `channels` names
another bot and chat by their two secrets, a rule's `channel` sends its alert there, and
`robloxChannel` does the same for a kind of Roblox webhook. The scan, the digest and a notice go to
the chat. A channel either of whose secrets is not set sends to the chat and writes
`alert_channel_unconfigured` with its name to the log, so the config can be deployed before the
secrets are put and no message is lost in between. A rule that names a channel `channels` does not
hold is a wrong config, and throws as the Worker loads.

**Every hour** the scan reads the live batches since its last run and says who stood at a limit.
**Every night** the job rolls each finished day up into `events_daily`, keeps who was first seen when
(`actors`), prunes raw batches past `retentionDays` or `maxRawEvents`, and sends yesterday in one
message.

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
| `events` (view) | One row an event: `batch_id`, `received_at`, `t`, `seq`, `event`, `actor`, `ctx` (JSON text, read with `json_extract`), and the batch's columns. **What queries read** |
| `events_daily` | The roll-up kept after pruning: `day`, `event`, `env`, `universe_id`, `events`, `actors`. The row with event `*` is the whole day, and its `actors` is the day's players |
| `actors`, `first_seen` (view) | When each player was first seen and on which place version, kept before pruning |
| `alert_state`, `alert_cursor` | The cool-downs, and where the hourly scan stopped |

Never mix `env` values in an analysis: every query says `WHERE env = 'live'`.

## Queries

A game's saved questions are its own: SQL files in its `telemetry/queries/`, run with
`npx wrangler d1 execute <database> --remote --file queries/<name>.sql`. Two examples to copy are in
`worker/queries/`: `pipe-health.sql` (is the data trustworthy at all: read it first) and `daily.sql`.

A game checks every query against an empty copy of the schema in its own gate, so one that names a
table or a column that does not exist fails there and not on launch day:

```sh
npx telemetryblox-check-queries queries
```

or in a test, with `checkQueries(directory)` and `freshDatabase()` from `telemetryblox/testing`,
which is also the D1 a game's own Worker tests stand on (Node's SQLite, which D1 is).

## The free plan

The ingest is sized for Cloudflare's free plan: a row a batch and one index (100,000 rows written a
day), one query an ingest (50 an invocation), one JSON parse and one stringify (10 ms of CPU), one
cron trigger (five an account). A server posts every three minutes when it has rows: about 480
requests and 1,900 rows written a day per server, so about fifty servers running all day is the
ceiling. Past it D1 refuses writes until midnight UTC; the pipe holds a refused batch, then counts
it lost as `send_failed`. Then: Workers Paid, or a larger `flushSeconds`.

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
