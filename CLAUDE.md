# TelemetryBlox - working notes

TelemetryBlox is a Roblox game server's telemetry pipe and the Cloudflare Worker that receives it.
It was extracted from a live game and is used by the owner's games in two ways: the pipe as
a pinned pesde package (`xopoiii/telemetryblox`, target `roblox_server`), and the Worker as an npm
package installed from this repository by git tag, which each game deploys as a project of its own.

## Everything here is written in English

Code, comments, identifiers, docs, commit messages, PR bodies. `scripts/check-english.sh` enforces it on
every commit. Conversation with the owner may be in another language; nothing in another language
lands in the repository. Plain ASCII: a character outside it is built from an escape.

## The tree is at zero

- No lint warnings, no type errors, no formatting drift, in Luau and in TypeScript alike. A warning
  is a failure: one that is tolerated once stops being read.
- Every `.luau` file starts with `--!strict` on line 1 and never opts out (`scripts/check-strict.sh`).
- No Luau file is over 300 lines (`scripts/check-file-size.sh`). A file that reaches the cap is split
  into modules, not exempted.
- The same gates run in lefthook (pre-commit, pre-push) and in CI (`.github/workflows/checks.yaml`).

## The kit holds nothing of a game

This is the reason the repository exists, and the rule a change is checked against first.

- A game's event names, its endpoint, the name of its secret, its tag, its salt, its alert table,
  its cool-downs, its scan thresholds, its retention and the names of its bindings are **options**
  (`src/Options.luau`) and **config** (`worker/src/config.ts`). No module names a game's event.
- The pipe's own rows (the drop row, an error row) are written under names the game gives.
- Nothing touches `game` at require time. The engine is reached only through `src/Services.luau`,
  and only `src/RobloxServices.luau` implements it.
- No game's content lands here: no event vocabulary, no query about a game's rows, no account or
  database id, no host name of a deployed Worker.

## Telemetry must never be able to hurt the game

- `emit` returns at once, never yields and cannot raise, whatever it is given. Nothing is added to
  its path that could.
- The ring is bounded and drops its oldest; what is lost is counted and reported into the stream.
- No player id leaves the server: the pseudonym is made before the row exists. `src/Hash.luau` is
  pinned by exact tokens in `tests/unit/Anon.luau`; a change that moves one makes every player of
  every game a new one, and is not made.
- In the Worker a batch is stored before an alert is thought about, and every alert path catches.

## Secrets are never here

- The ingest key, the bot's token, the chat's id and the webhook token are Worker secrets, set by
  hand with wrangler in a game's own project. None is written in this repository, in a test, in a
  commit message or in a log line. Tests use made-up words.
- The Worker's tests never reach the network: `worker/test/helpers.mjs` puts a recorder in `fetch`'s
  place as it loads and never takes it out. A new test file imports the helpers.
- **Nothing is deployed from this repository**: no `wrangler deploy`, no D1 database, no secret.
  `wrangler dev --local` and `wrangler deploy --dry-run` in a scratch folder are fine.

## Rules are proven, not argued

- What is pure is kept apart from the engine, so every rule of the pipe is a spec that runs without
  Roblox, over a fake server whose clock the spec moves (`tests/fakes/World.luau`).
- Specs are strict: exact values, the negative case beside the positive one, no vacuous passes.
- A new rule lands with its spec and with a mutant in `tests/slips/`: the spec is seen failing
  against the broken line before it is trusted. `luneblox run tests/Mutate --yes` must kill every
  mutant. A mutant must not be able to hang the suite: the fake server refuses a runaway.
- A spec is never loosened to make it pass.
- The Worker's tests (`worker/test/`) run the built Worker against Node's SQLite, which D1 is. A new
  rule there lands with its test, and the test is seen failing against the broken line once.
- What cannot run here (the engine adapter, a deployed Worker) is said to be unproven, in the
  changelog's "Not done", rather than covered by a fake that proves the fake.
- `tests/consumer/Game.luau` uses the whole public API and is type-checked under both solvers;
  `tests/consumer/Misuse.luau` must fail on exactly its marked lines. Both change with the API, and
  the README's example after them.

## Dependencies

- **No runtime dependencies**, on either side. `src/` is plain Luau; `worker/src` uses the Workers
  runtime and nothing else.
- **Latest stable versions only.** Every tool and CI action is pinned exactly to its latest stable
  release at the time it is added or bumped (check with `gh release view -R owner/repo`, `npm view
  <package> version`). Never a prerelease, and never a pin copied from a sibling repo without
  checking. Luau tools are in `rokit.toml`; Node tools in `package.json` and `package-lock.json`.
- **The lock names the public registry only.** `package-lock.json` is made with
  `npm install --registry=https://registry.npmjs.org/`; `scripts/check-lockfile.sh` refuses any
  other host. `overrides` in `package.json` lift a tool's own dependency past a known advisory
  (`npm audit` reports nothing), and `allowScripts` names the one install script that may run.
- **LuneBlox is ours** (XopoIII/LuneBlox). When TelemetryBlox needs something from it, the change is
  made there and flagged to the owner, not worked around here.

## Modern Luau: the version Roblox runs

- **`const`** for every binding that is never reassigned, including requires, module tables and
  functions (`const function`). `local` only for a binding that really is reassigned.
- **String requires**: `require("./Sibling")` between modules and `require("@self/Module")` in
  `init.luau`, so the same files load in Roblox and on LuneBlox.
- **The new type solver.** `scripts/type-check.sh` runs luau-lsp with `LuauSolverV2`, as Studio
  checks games, and checks the consumer files under the old solver too.
- No cast to `any` to silence a type. `TelemetryBlox.new` takes `Options<any>` on purpose: the old
  solver widens a union of string literals when it infers a generic, so the game's annotations carry
  the vocabulary.

## Architecture in one breath

The pipe (`src/`):

- `Hash`, `Anon`: the pseudonym. `Clean`: the copy of a context a row keeps.
- `Ring`: the two bounded tiers and the loss counters. `Pipe`: batches, retries, the flusher, the
  drain. `ErrorReporter`: the schedule server errors are reported on.
- `Options`: what a game hands in, checked. `Services`, `RobloxServices`: the engine, behind a table.
- `init.luau`: the front door, `TelemetryBlox.new`, and the re-exported types.

The Worker (`worker/`):

- `src/config.ts`: the config, its defaults and its checks. `src/ingest.ts`: the key, the bounds,
  the one insert. `src/alerts.ts`: the table, the cool-down gate, the sender. `src/scan.ts`: the
  hourly scan and the digest. `src/retention.ts`: the roll-up and the pruning. `src/roblox.ts`:
  Roblox's webhooks. `src/index.ts`: `createWorker`, `createKit`, the doors and the cron.
- `dist/`: `src` built by `npm run build`, committed. It is what a game runs.
- `migrations/`: the schema. A change is a new numbered file, never an edit of an applied one.
- `testing/`, `bin/`: what a game's own tests and gate use. Plain JavaScript: Node will not strip
  types under node_modules.

## The two halves agree

The wire format is written three times: `Pipe.luau` builds it, `ingest.ts` reads it, and README.md
says it ("The wire"). One file holds them together: `tests/wire/batch.json`. `tests/unit/Wire.luau`
proves the pipe posts exactly that batch, and `worker/test/ingest.test.mjs` proves the Worker stores
exactly it. A change to the format changes the fixture, both halves and the README in one pull
request, with a new `SCHEMA_VERSION` when an old Worker could not read a new batch.

## Distribution

- **The pipe:** pesde only (`pesde.toml` and `pesde.lock`). `scripts/check-package.sh` checks that
  the built archive carries every file of `src/`.
- **The Worker:** this repository at a tag, as an npm git dependency
  (`github:XopoIII/TelemetryBlox#vX.Y.Z`). `package.json` is `private`, so it cannot be published to
  the npm registry by mistake; its `files` keep the Luau side out of a game's `node_modules`.
  `scripts/check-worker.sh` fails when `worker/dist` is not what `worker/src` builds.
- **Not shipped:** a Wally package, an `.rbxm`, roblox-ts typings, an npm registry package.
- **A release** carries one version in `pesde.toml`, `pesde.lock`, `package.json`,
  `package-lock.json` and `README.md` (the status line, the two pesde lines and the git tag in the
  game's `package.json`), and its entry in `CHANGELOG.md`.

## Releasing

The version bump, the built `worker/dist` and the changelog entry are part of the pull request, not
of this list.

1. Merge the pull request with a merge commit (`gh pr merge <n> --merge`), then check out `main` and
   pull.
2. On the merged `main`, run `sh scripts/check-package.sh`, `sh scripts/run-tests.sh`,
   `luneblox run tests/Mutate --yes` and `sh scripts/check-worker.sh`. All must pass there, not only
   on the branch.
3. Tag and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`. **The tag is the Worker's
   release**: a game's `package.json` names it, and what the tag holds in `worker/dist` is what
   that game deploys. A tag is never moved.
4. Create the GitHub Release: `gh release create vX.Y.Z --title "TelemetryBlox X.Y.Z" --notes-file <notes>`.
   The notes hold, in order: a summary line, the changelog entry's sections, **Evidence** (the spec
   count, the mutants killed, the Worker's test count, the gates that passed, anything run in a game
   or on Cloudflare, and anything that was not), **Known, not fixed** when there is something, and
   **Install** (the pesde line and the git dependency line).
5. Publish the pipe: `pesde publish --yes` (after `pesde auth login` once per machine). A published
   version cannot be replaced, so it comes after the tag and the release. Nothing is published to
   npm.
6. In each game's own repository: pin the new pesde version, bump the tag in `telemetry/package.json`,
   run the migrations (`npx wrangler d1 migrations apply <database> --remote`) and deploy the game's
   Worker.

## Commits

- A plain declarative English subject, no conventional-commit prefix.
- The body says what changed and why, in prose.
- A closing "Checked:" paragraph lists what was run and what it reported.
- One commit a step; never commit with the gate red, never bypass a hook.

## Commands

| Command | What it does |
|---|---|
| `rokit install` | Installs the pinned Luau toolchain (`rokit.toml`) |
| `npm ci` | Installs the Worker's pinned tools (`package-lock.json`) |
| `lefthook install` | Installs the git hooks |
| `sh scripts/run-tests.sh` | Runs the pipe's suite on LuneBlox (`tests/Run.luau`) |
| `luneblox run tests/Mutate --yes` | Mutation adequacy: every mutant must fail the suite (`-- Pipe` for one file) |
| `sh scripts/type-check.sh` | `luau-lsp analyze` over `src` and `tests`, the consumer under the old solver, and the misuses that must fail |
| `selene src tests` | Lint |
| `stylua --check src tests` | Format check (`stylua src tests` to fix) |
| `sh scripts/check-strict.sh` | `--!strict` gate |
| `sh scripts/check-file-size.sh` | 300-line gate |
| `sh scripts/check-english.sh` | English-only gate |
| `sh scripts/check-package.sh` | The pesde archive carries all of `src/` (`pesde publish --dry-run`) |
| `sh scripts/check-lockfile.sh` | Every package in `package-lock.json` is fetched from registry.npmjs.org |
| `sh scripts/check-worker.sh` | The Worker: `tsc`, Biome, `worker/dist` against a fresh build, its tests, the example queries |
| `npm run build` | Builds `worker/src` into `worker/dist` |
| `npm test` | Builds, then runs the Worker's tests |
| `npx biome check --write` | Formats the Worker's TypeScript and JavaScript |
| `lefthook run pre-commit --all-files` | Every pre-commit gate over the whole tree |
