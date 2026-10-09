# Changelog

Every release is listed here, newest first. The format follows Keep a Changelog, and versions follow
semantic versioning. One version names both halves: the pesde package and the Worker a game installs
by the same tag.

## 0.4.0 - 2026-10-09

The wire is as it was: `schemaVersion` is 1 on both sides, the envelope and the tables are
unchanged, and no migration is added. A 0.3.0 pipe posts to a 0.4.0 Worker and a 0.4.0 pipe to a
0.3.0 Worker, so the two halves can be updated in either order.

### Added

The Worker:
- The ingest refuses a batch whose `schemaVersion` is newer than it reads, with a 400 that says so,
  instead of storing it half-understood. An older pipe keeps working against an updated Worker.
  `SCHEMA_VERSION` is exported.
- `maxBatchesPerMinute` (1,200) and `maxServerBatchesPerMinute` (60): a bound on how fast batches
  may arrive, over every server and from one, by job id. The surplus is refused with a 429. The
  counts live in the Worker's memory, so the bound costs no written rows and is per isolate,
  best-effort.
- `alertStateDays` (7): how many days an alert's cool-down state is kept after it last went. A key
  quiet for longer starts over, and its row is dropped with the night. What was a fixed week is now
  the game's to set.

The repository:
- A smoke gate (`worker/smoke/`): the committed `worker/dist` served by workerd itself, the
  runtime Cloudflare runs, with its D1 binding over real SQLite and the kit's migrations applied.
  A batch goes in through the front door, a duplicate is held off, and the health door answers from
  the data. It is part of `check-worker.sh`, so hooks and CI both run it. `miniflare` joins the dev
  dependencies for it; a game installs none of them.
- A release workflow: a pushed tag runs every gate, checks that the tag names the version,
  publishes the pesde package and makes the GitHub release from this file. It needs the repository
  secret `PESDE_TOKEN`.
- Secret scanning (gitleaks) in CI, and Dependabot for the Node tools and the CI actions.
- `scripts/check-lockfile.sh`: every package in `package-lock.json` is fetched from the public npm
  registry. It runs in pre-commit and at the head of `check-worker.sh`.

### Changed

The pipe:
- A batch the ingest answers with a 429 is held without spending one of its tries, for at most ten
  posts of one batch; past that a 429 costs a try like any other answer. Any other refusal costs a
  try as before, and a batch is still counted lost after `maxTries` of them. No request is added: a
  held batch is posted once a wake, as it was, and the drain still ends at its budget. The retry is
  logged under the same id, `telemetry.send_retry`, whose `try` is the tries spent: 0 for a batch
  that has only waited.
- The flusher's first wake is staggered within one tick by the hash of the server's job id. A
  publish or a surge starts many servers in the same second, and a fleet whose flushers wake
  together would post together for its whole life; now it spreads its posts across the tick and
  keeps them spread. The first wake comes sooner than a tick, never later, so an urgent row waits
  no longer than it did. A server's first regular post is that much later: up to
  `flushSeconds + tickSeconds - 1` seconds after the start in place of `flushSeconds`.
- The ring no longer shifts its array when a full tier drops its oldest row: a tier is an array and
  a head, eviction is a step of the head, and the spent rows are moved over once they outnumber the
  waiting ones. An emit into a full ring under a flood now costs what an emit into an empty one
  costs. What a tier holds, what it drops and what it counts are unchanged; a full tier keeps up to
  as many spent rows again until the move.
- A context table with an array part keeps its string keys too, in the row's copy: `recent()` and
  a listener now read both halves, where they read the array alone. **This is not a change on the
  wire.** JSON has no value that is both, and the encoder decides: on LuneBlox, where the specs
  run, a mixed table still leaves as its array alone, and Roblox's `HttpService:JSONEncode` is
  documented to do the same. A named field that must be stored goes in a table of its own.
- Option checks at boot are stricter. Each of these was accepted by 0.3.0 and is an error at boot
  now:
  - an `endpoint` that is not empty and does not start with `https://` (every post carries the
    ingest key in a header);
  - a `maxBatch`, `ringSize`, `protectedSize`, `maxTries`, `maxStringBytes` or `maxDepth` that is
    not a whole number;
  - a `tickSeconds` greater than `flushSeconds`.

  A game that sets none of these, or sets them to whole numbers, an https endpoint and a tick no
  longer than its flush, starts as it did. Any other game must correct its options before it
  updates.

### Fixed

The pipe:
- A Studio server no longer has an empty job id. The ingest names a batch by (job id, server
  start, first row), and two Studio servers started in the same second would share that identity.
  The engine adapter now gives a Studio server a made-up id of its own (`studio-<guid>`), one per
  server. Studio still never sends; the id is what a batch would carry, and what the stagger reads.

The Worker:
- The limiter's words said that a 429 costs a delay and that nothing in the pipe posts faster than
  the drain's retry. Neither was true of the pipe as it was: a 429 cost a try, and a drain posts
  its backlog back to back. The pipe now does the first (above), and the comments and the README
  say what the second really is.

The repository:
- CI on `main` was red from the smoke gate's merge: its lockfile resolved 56 of 87 packages from
  a private mirror, so `npm ci` failed and the Worker's gate never ran. The lock names the public
  registry only; `overrides` lift sharp and undici, which miniflare pins, past three high
  advisories (`npm audit` reports none); `allowScripts` names workerd's postinstall.

### Not done

- **Roblox's encoder has not been run on a mixed table.** `HttpService:JSONEncode({ ctx = { 1, 2,
  a = 3 } })` in Studio is the probe. The documentation says the array part alone is written, which
  is what 0.3.0 kept; if the engine does otherwise, that is what a game with such a context will
  see.
- The limiter has not run on Cloudflare: its tests run in Node and the smoke in local workerd,
  with one isolate. How many isolates share a game's traffic, and so how loose the bound is, is
  not measured.
- The stagger, the Studio job id and the 429 rule have not run in a Roblox server: the engine
  adapter is type-checked, not run.
- The release workflow has not run: this is the first tag since it was added.

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
