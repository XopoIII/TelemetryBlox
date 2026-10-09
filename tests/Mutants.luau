--!strict
--- The mutants tests/Mutate runs: each a small slip in the pipe, the kind a refactor could make, and
--- the rule it breaks. They are kept by the part they break, in `tests/slips/`.
const Clean = require("./slips/Clean")
const Door = require("./slips/Door")
const Mutant = require("./slips/Mutant")
const Options = require("./slips/Options")
const Parts = require("./slips/Parts")
const Pipe = require("./slips/Pipe")
const Ring = require("./slips/Ring")
const Throttle = require("./slips/Throttle")

export type Mutant = Mutant.Mutant

const MUTANTS: { Mutant } = {}
for _, list in { Ring, Pipe, Throttle, Clean, Parts, Options, Door } do
	for _, mutant in list do
		table.insert(MUTANTS, mutant)
	end
end

return MUTANTS
