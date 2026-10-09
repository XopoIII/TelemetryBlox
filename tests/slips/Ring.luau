--!strict
--- Mutants of the ring: each a small slip, and the rule it breaks.
--- Every `from` must occur exactly once in its file.
const Mutant = require("./Mutant")

const MUTANTS: { Mutant.Mutant } = {
	{
		file = "src/Ring.luau",
		from = "if waiting(tier) > (if kept then config.protectedSize else config.size) then",
		to = "if waiting(tier) >= (if kept then config.protectedSize else config.size) then",
		breaks = "a ring exactly full loses nothing",
	},
	{
		file = "src/Ring.luau",
		from = "\t\t\ttier.head += 1\n\t\t\tevicted += 1\n",
		to = "\t\t\ttable.remove(tier.rows)\n\t\t\tevicted += 1\n",
		breaks = "the oldest row is the one dropped",
	},
	{
		file = "src/Ring.luau",
		from = "\t\t\ttier.head += 1\n\t\t\tevicted += 1\n",
		to = "\t\t\tevicted += 1\n",
		breaks = "an evicted row stops waiting",
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
		from = "drain(bulk, batch, max - took)",
		to = "drain(bulk, batch, max)",
		breaks = "a batch is at most as many rows as asked",
	},
	{
		file = "src/Ring.luau",
		from = "const took = drain(protected, batch, max)\n\t\tdrain(bulk, batch, max - took)",
		to = "const took = drain(bulk, batch, max)\n\t\tdrain(protected, batch, max - took)",
		breaks = "the protected rows leave first",
	},
	{
		file = "src/Ring.luau",
		from = "if waiting(protected) == 0 then",
		to = "if waiting(protected) == 0 and waiting(bulk) == 0 then",
		breaks = "the urgent flag falls once the urgent rows are carried, whatever bulk waits",
	},
	{
		file = "src/Ring.luau",
		from = "if waiting(protected) == 0 then",
		to = "if true then",
		breaks = "an urgent row still waiting keeps asking",
	},
	{
		file = "src/Ring.luau",
		from = "const count = math.min(waiting(t), want)",
		to = "const count = math.min(waiting(t), want + 1)",
		breaks = "take hands over no more than asked",
	},
	{
		file = "src/Ring.luau",
		from = "\tt.head += count\n",
		to = "\tt.head += count - 1\n",
		breaks = "a taken row is gone from the ring",
	},
	{
		file = "src/Ring.luau",
		from = "for index = 0, count - 1 do",
		to = "for index = 1, count do",
		breaks = "a take is the oldest rows, not the newest",
	},
	{
		file = "src/Ring.luau",
		from = "table.move(t.rows, t.head, last, 1)",
		to = "table.move(t.rows, t.head + 1, last, 1)",
		breaks = "housekeeping loses no waiting row",
	},
	{
		file = "src/Ring.luau",
		from = "for index = last - t.head + 2, last do",
		to = "for index = last - t.head + 3, last do",
		breaks = "housekeeping leaves no spent row behind",
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
		from = "\t\tunsent += count\n",
		to = "\t\tunsent += 1\n",
		breaks = "every row of a lost batch is counted",
	},
}

return MUTANTS
