# Changelog

Every release is listed here, newest first. The format follows Keep a Changelog, and versions follow
semantic versioning. One version names both halves: the pesde package and the Worker a game installs
by the same tag.

## Unreleased

### Changed

The pipe:
- The ring no longer shifts its array when a full tier drops its oldest row: a tier is an array and
  a head, eviction is a step of the head, and the spent rows are moved over once they outnumber the
  waiting ones. An emit into a full ring under a flood now costs what an emit into an empty one
  costs.
- A context table with an array part now keeps its string keys too: a mixed table was kept as its
  array alone, and half a row could vanish without a trace.
- Option checks at boot are stricter, so a mistake is an error at boot and not a silence later:
  `endpoint` must be an `https://` URL or empty (every post carries the ingest key in a header);
  `maxBatch`, `ringSize`, `protectedSize`, `maxTries`, `maxStringBytes` and `maxDepth` must be whole
  numbers; `tickSeconds` must not exceed `flushSeconds`.

Nothing changes for a game whose options were already valid.

## 0.3.0 - 2026-10-08

### Added

The Worker:
- `channels`: more chats than the one, each named by the two secrets of its own bot and chat. An
  alert rule's `channel` sends its alert there, and `robloxChannel(kind)` a Roblox webhook of that
  kind. A game can keep its purchases and refunds apart from its faults. A channel either of whose
  secrets is not set sends to the chat and logs `alert_channel_unconfigured` with its name; a rule
  that names a channel the config does not hold fails as the Worker is made.
- `Kit.send` takes the channel as its third argument, and `Kit.robloxWebhookChannel(body)` says where
  a webhook's body goes. `robloxKind(body)` is exported: the kind a webhook's words and its channel
  both go by. `Alert` carries `channel`, and the `ChannelNames` type is exported.

Nothing changes for a game that names no channel.

## 0.2.0 - 2026-10-07

### Added

The pipe:
- `maxStringBytes` and `maxDepth` options: the limits a row's context is copied under, 1000 bytes and
  four levels as before unless the game says otherwise. A game whose rows carry a whole error message
  raises the first. `Clean.context` takes the limits as a second argument, and `Clean.DEFAULTS` holds
  the ones used without it.
- A captured server error is also said to `log`, under the event's name, with its `script`, `message`
  and `count`: the row answers whether it happens across servers, the log line what happened in this
  one. The game the pipe came from always logged it; the package had dropped the line.

The Worker:
- `robloxPrefix(kind)`: what starts a Roblox webhook's message, by its kind (`erasure`, `test`,
  `refund`, `event`, `alert`), in place of `marks.roblox` and the game's name. A game can mark an
  obligation apart from a notice.
- `marks.cut`: what ends a value that was cut short, three dots by default. `short` and
  `robloxAlertText` take it as their last argument.

### Changed

- No file names a game any more: the tests' example game is called `example`, and the notes say
  where the code came from without naming it.

## 0.1.0 - 2026-10-05

A live game's telemetry as a package: the same pipe and the same Worker, with every seam to the
game cut. Nothing in this repository names a game's event, endpoint, secret or threshold.

### Added

The pipe (`xopoiii/telemetryblox`, target `roblox_server`):

- `TelemetryBlox.new(options, services?)`: a game's telemetry. `emit(name, player?, context?)`
  writes one row, returns at once, never yields and cannot raise.
- The event name is a type: `Options<EventName>` and `Telemetry<EventName>` over a game's union of
  string literals. A name outside it does not compile, under either type solver.
- The ring (`Ring`): 2000 bulk rows, oldest dropped first, and 500 protected rows the bulk stream
  cannot evict. Each event's priority (`bulk`, `protected`, `urgent`) is the game's to say.
- The pipe (`Pipe`): a post every three minutes, sooner for an urgent row, a held batch or half a
  batch waiting; a refused batch held and sent again as the same rows, three posts in all; the
  losses written into the stream as a row of the game's `dropEvent`, by cause; a shutdown drain
  that waits for the leaving players' rows inside its budget.
- The pseudonym (`Anon`, `Hash`): a salted token made before the row exists, so no user id enters a
  row. The salt is the game's own.
- `captureErrors(event)`: server errors as rows, deduplicated by message (`ErrorReporter`).
- `onEmit`, `actorOf`, `recent`, `drops`, `backlog`, `flush`, `drain`, `destination`.
- `Services` and `RobloxServices`: everything of Roblox the pipe touches, behind one table a spec
  can replace.

The Worker (`worker/`, installed by git tag):

- `createWorker(config)`: a game's whole Worker. `POST /ingest` checks the key in constant time,
  bounds the body, and stores a batch once however often it arrives.
- Alerts to Telegram from the game's own table of events and weights, with a cool-down for each
  kind, held repeats counted into the next message, a cap on alerts a batch, and only live batches
  alerting.
- The hourly scan over the game's own thresholds (`rows`, `sum` or `max` for each player), the
  nightly roll-up, first-seen keeping and pruning, and the nightly digest.
- `/health` (and `?deep=1`), `/retention`, `/anomalies`, `/notify`, `/roblox-alert`.
- The schema as wrangler migrations (`worker/migrations`), two example queries
  (`worker/queries`), and `telemetryblox/testing` with `telemetryblox-check-queries`: a D1 over
  Node's SQLite for a game's tests, and a check that every saved query runs against the schema.

### Changed from the game's own copy

The pipe:

- The endpoint, the secret's name, the game's tag, the salt, the vocabulary and its priorities, the
  drop event's name, the intervals, the ring sizes and the place version are options. The modules
  held them as constants.
- State lives in the object `TelemetryBlox.new` returns, not in the modules: two telemetries, or a
  spec's, do not share a ring.
- A row keeps a clean copy of its context: no NaN, no infinity, nothing that is not JSON, strings
  cut at 1000 bytes. The game's own table was changed in place, and an Instance in it could cost a
  whole batch.
- A call `emit` can make nothing of is counted as `refused` and said in the drop row. It raised, or
  wrote a row no query could read.
- An urgent event is always protected; the two lists were kept apart and could disagree.
- Every Roblox service is behind `Services`. The modules called the engine directly, so nothing
  ran off Roblox.
- A batch says its `game`, and its `env` may be `"test"` as well as `"live"` and `"studio"`.
- The front door no longer writes `join` and `leave`, knows no locale, and has no `leaving`,
  `onLeave` and `leaveRow`: those rows are a game's own.

The Worker:

- The game's name, alert table, cool-downs, cap, scan thresholds, digest, retention, nightly hour,
  environments, body bounds, marks, and the names of its D1 binding and secrets are config. The
  alert rules were a `switch` over that game's events and the scan a fixed query over five of them.
- A repeat of an alert in the very second the first was sent is held. It was sent twice: the gate
  told the two apart by the row's time, which is the same for both.
- A batch that arrives twice raises its alerts once. A purchase, which is never held, was said
  twice.
- A body is bounded by its real size in bytes, not only by the length it declares.
- A batch tagged for another game is refused.
- A failed send logs the error's name, not its text: the text may quote the URL, which holds the
  bot's token.
- The key is compared by hash, in constant time, without `crypto.subtle.timingSafeEqual`, which
  only the Workers runtime has.
- Messages start with plain marks (`[critical]`) in place of emoji; a game may set its own.
- The schema is a wrangler migration in place of a file applied by hand, and a game's Worker is
  bundled from the built JavaScript in `worker/dist`.

### Not done

- **Nothing here has run on Roblox.** `src/RobloxServices.luau`, the only module that touches the
  engine, is checked by the type gate against the Roblox API and is not run by any spec:
  `GetSecret`, `RequestAsync`, `BindToClose` and `ScriptContext.Error` are reached for the first
  time in the first game that pins this package.
- **Nothing here has run on Cloudflare.** The Worker's tests run against Node's SQLite, and it was
  run once in local `workerd` with a local D1 (a batch stored once, the doors, the cron). No Worker
  was deployed, no D1 database created, no secret set, and no message sent to a chat.
- The Worker has no mutation runner of its own. 53 slips in `worker/src` were tried by hand once;
  52 failed the tests and the last is an equivalent.
- `emit` cannot know what a game writes into a context: an id or a name put there by hand leaves
  the server. The library keeps its own promise only (the actor, the envelope).
- A listener given to `onEmit` that yields makes `emit` yield. It is documented, not prevented.
- The game's event vocabulary, its coverage check (every event emitted and documented), its
  Roblox-analytics sink, its query files and its right-to-erasure script are a game's own and are
  not here. Neither is the script that sets an experience's secret through Open Cloud.
- No Wally package, no `.rbxm`, no roblox-ts typings, and no npm registry package: the Worker is
  installed from this repository by tag.
