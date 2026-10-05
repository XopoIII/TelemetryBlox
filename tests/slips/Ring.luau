--!strict
--- Mutants of the ring: each a small slip, and the rule it breaks.
--- Every `from` must occur exactly once in its file.
const Mutant = require("./Mutant")

const MUTANTS: { Mutant.Mutant } = {
	{
		file = "src/Ring.luau",
		from = "if #target > (if kept then config.protectedSize else config.size) then",
		to = "if #target >= (if kept then config.protectedSize else config.size) then",
		breaks = "a ring exactly full loses nothing",
	},
	{
		file = "src/Ring.luau",
		from = "table.remove(target, 1)",
		to = "table.remove(target)",
		breaks = "the oldest row is the one dropped",
	},
	{
		file = "src/Ring.luau",
		from = "\t\t\tevicted += 1\n",
		to = "",
		breaks = "an evicted row is counted",
	},
	{
		file = "src/Ring.luau",
		from = 'const kept = priority == "protected" or priority == "urgent"',
		to = 'const kept = priority == "protected"',
		breaks = "an urgent row survives a full ring",
	},
	{
		file = "src/Ring.luau",
		from = 'const kept = priority == "protected" or priority == "urgent"',
		to = 'const kept = priority == "urgent"',
		breaks = "a protected row survives a full ring",
	},
	{
		file = "src/Ring.luau",
		from = 'const kept = priority == "protected" or priority == "urgent"',
		to = "const kept = true",
		breaks = "an unlisted or bulk row waits in the bulk ring",
	},
	{
		file = "src/Ring.luau",
		from = 'if priority == "urgent" then',
		to = "if kept then",
		breaks = "a protected row does not ask for an early post",
	},
	{
		file = "src/Ring.luau",
		from = "move(bulk, batch, max - took)",
		to = "move(bulk, batch, max)",
		breaks = "a batch is at most as many rows as asked",
	},
	{
		file = "src/Ring.luau",
		from = "const took = move(protected, batch, max)\n\t\tmove(bulk, batch, max - took)",
		to = "const took = move(bulk, batch, max)\n\t\tmove(protected, batch, max - took)",
		breaks = "the protected rows leave first",
	},
	{
		file = "src/Ring.luau",
		from = "if #protected == 0 then",
		to = "if #protected == 0 and #bulk == 0 then",
		breaks = "the urgent flag falls once the urgent rows are carried, whatever bulk waits",
	},
	{
		file = "src/Ring.luau",
		from = "if #protected == 0 then",
		to = "if true then",
		breaks = "an urgent row still waiting keeps asking",
	},
	{
		file = "src/Ring.luau",
		from = "return evicted + unsent + refused",
		to = "return evicted + unsent",
		breaks = "a refused call counts as a loss",
	},
	{
		file = "src/Ring.luau",
		from = "return evicted + unsent + refused",
		to = "return evicted + refused",
		breaks = "an untaken batch counts as a loss",
	},
	{
		file = "src/Ring.luau",
		from = "\t\tevicted, unsent, refused = 0, 0, 0\n",
		to = "",
		breaks = "a claim zeroes the counters",
	},
	{
		file = "src/Ring.luau",
		from = "return wasEvicted, wasUnsent, wasRefused",
		to = "return wasEvicted, wasRefused, wasUnsent",
		breaks = "the losses are told apart by cause",
	},
	{
		file = "src/Ring.luau",
		from = "return a.seq < b.seq",
		to = "return a.seq > b.seq",
		breaks = "a read-back is oldest first",
	},
	{
		file = "src/Ring.luau",
		from = "for index = #all - want + 1, #all do",
		to = "for index = 1, want do",
		breaks = "a read-back of some rows is the newest of them",
	},
	{
		file = "src/Ring.luau",
		from = "const count = math.min(#source, want)",
		to = "const count = math.min(#source, want + 1)",
		breaks = "take hands over no more than asked",
	},
	{
		file = "src/Ring.luau",
		from = "table.move(source, count + 1, #source, 1)",
		to = "table.move(source, count, #source, 1)",
		breaks = "a taken row is gone from the ring",
	},
	{
		file = "src/Ring.luau",
		from = "\t\tunsent += count\n",
		to = "\t\tunsent += 1\n",
		breaks = "every row of a lost batch is counted",
	},
}

return MUTANTS
