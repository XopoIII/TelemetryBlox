--!strict
--- The suite: every spec file, in order. A spec file runs its specs as it loads.
---
--- Everything but the engine's own adapter runs here: the ring, the batching, the retry, the drain,
--- the pseudonym and the front door, over a fake server (`tests/fakes/World.luau`) whose clock the
--- specs move. `src/RobloxServices.luau` is type-checked against the Roblox API and is not run.
---
--- Run from the repository root: `luneblox run tests/Run --yes` (or `sh scripts/run-tests.sh`).
const Runtime = require("./Runtime")
const Spec = require("./Spec")

Runtime.notice()

require("./unit/Anon")
require("./unit/Clean")
require("./unit/Ring")
require("./unit/Pipe")
require("./unit/Drain")
require("./unit/ErrorReporter")
require("./unit/Options")
require("./unit/Front")
require("./unit/Started")

Spec.finish()
