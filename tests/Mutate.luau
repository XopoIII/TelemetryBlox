--!strict
--- Mutation adequacy of the suite: is the checker strong enough? Each mutant in tests/Mutants is a
--- small, plausible slip in the arithmetic, the kind a refactor could make. The suite runs once per
--- mutant and must fail; a mutant that survives shows a rule no spec proves.
---
---     luneblox run tests/Mutate --yes             (every mutant; well under a second each)
---     luneblox run tests/Mutate --yes -- Band     (only the mutants of files matching "Band")
---
--- Every mutant's `from` must occur exactly once in its file, so a change to the code that moves it
--- fails here loudly instead of testing nothing. The source is always put back, even on an error.
const fs = require("@lune/fs")
const process = require("@lune/process")

const Mutants = require("./Mutants")

type Mutant = Mutants.Mutant

const function count(text: string, pattern: string): number
	local found, start = 0, 1
	while true do
		const first, last = string.find(text, pattern, start, true)
		if first == nil then
			return found
		end
		found += 1
		start = (last :: number) + 1
	end
end

const function suitePasses(): boolean
	const result = process.exec("luneblox", { "run", "tests/Run", "--yes" })
	return result.ok
end

local only: string? = nil
for _, arg in process.args do
	if string.sub(arg, 1, 1) ~= "-" then
		only = arg
	end
end
-- Every chosen mutant must still match its code before any runs, so a stale one fails at once.
const chosen: { [number]: Mutant } = {}
for index, mutant in Mutants do
	if only == nil or string.find(mutant.file, only :: string, 1, true) then
		const occurrences = count(fs.readFile(mutant.file), mutant.from)
		assert(occurrences == 1, `mutant {index} ({mutant.file}): its code occurs {occurrences} times, not once`)
		chosen[index] = mutant
	end
end

const survivors: { Mutant } = {}
local ran = 0
for index, mutant in Mutants do
	if chosen[index] == nil then
		continue
	end
	const original = fs.readFile(mutant.file)
	const first, last = string.find(original, mutant.from, 1, true)
	fs.writeFile(
		mutant.file,
		string.sub(original, 1, (first :: number) - 1) .. mutant.to .. string.sub(original, (last :: number) + 1)
	)
	const ok, passed = pcall(suitePasses)
	fs.writeFile(mutant.file, original)
	assert(ok, `mutant {index}: the suite could not run: {passed}`)
	ran += 1
	print(`{if passed then "SURVIVED" else "killed  "} {index} {mutant.file}: {mutant.breaks}`)
	if passed then
		table.insert(survivors, mutant)
	end
end

assert(ran > 0, "no mutant ran: a check that checks nothing is not green")
print(`{ran - #survivors} of {ran} mutants killed`)
process.exit(if #survivors == 0 then 0 else 1)
