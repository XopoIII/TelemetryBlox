--!strict
--- The ring: bounded, oldest out first, and a tier the bulk stream cannot evict.
const Ring = require("@telemetryblox/Ring")
const Spec = require("../Spec")

const PRIORITIES: { [string]: Ring.Priority } = {
	feed = "bulk",
	purchase = "urgent",
	session = "protected",
}

const function ring(size: number, protectedSize: number): (Ring.Ring, { now: number })
	const time = { now = 1000 }
	return Ring.new({
		size = size,
		protectedSize = protectedSize,
		priorities = PRIORITIES,
		now = function(): number
			return time.now
		end,
	}),
		time
end

const function names(rows: { Ring.Row }): string
	const out: { string } = {}
	for _, row in rows do
		table.insert(out, `{row.event}#{row.seq}`)
	end
	return table.concat(out, " ")
end

Spec.test("a row carries its number, its time, its actor and its context", function()
	const r, time = ring(10, 10)
	r.emit("feed", "u_a", { pieces = 3 })
	time.now = 1005
	r.emit("session", nil, {})
	Spec.equal(r.recent(), {
		{ seq = 1, t = 1000, event = "feed", actor = "u_a", ctx = { pieces = 3 } },
		{ seq = 2, t = 1005, event = "session", ctx = {} },
	}, "rows")
	Spec.equal(r.size(), 2, "size")
end)

Spec.test("a full bulk ring drops its oldest row and counts it", function()
	const r = ring(3, 10)
	for _ = 1, 3 do
		r.emit("feed", nil, {})
	end
	Spec.equal(r.dropped(), 0, "exactly full loses nothing")
	Spec.equal(r.size(), 3, "full")
	r.emit("feed", nil, {})
	r.emit("feed", nil, {})
	Spec.equal(r.size(), 3, "still bounded")
	Spec.equal(r.dropped(), 2, "two evicted")
	Spec.equal(names(r.recent()), "feed#3 feed#4 feed#5", "the oldest went")
end)

Spec.test("urgent and protected rows survive a flood of bulk rows, which evicts only itself", function()
	const r = ring(5, 5)
	r.emit("purchase", "u_a", { robux = 25 })
	r.emit("session", "u_a", {})
	for _ = 1, 100 do
		r.emit("feed", "u_a", {})
	end
	Spec.equal(r.size(), 7, "five bulk rows and the two kept apart")
	const evicted, unsent, refused = r.claimDropped()
	Spec.equal({ evicted, unsent, refused }, { 95, 0, 0 }, "only bulk rows were lost")
	const batch = r.take(3)
	Spec.equal(names(batch), "purchase#1 session#2 feed#98", "the kept rows leave first")
	Spec.equal(batch[1].ctx.robux, 25, "the purchase is whole")
end)

Spec.test("the protected ring is bounded too, by its own size", function()
	const r = ring(5, 2)
	r.emit("purchase", nil, {})
	r.emit("session", nil, {})
	Spec.equal(r.dropped(), 0, "exactly full")
	r.emit("purchase", nil, {})
	Spec.equal(r.dropped(), 1, "one evicted")
	Spec.equal(names(r.recent()), "session#2 purchase#3", "its own oldest went")
	-- An event the vocabulary gives no priority waits with the bulk rows.
	r.emit("unlisted", nil, {})
	Spec.equal(names(r.take(10)), "session#2 purchase#3 unlisted#4", "unlisted is bulk")
end)

Spec.test("take hands over the oldest rows, at most as many as asked, and they are gone", function()
	const r = ring(10, 10)
	for _ = 1, 4 do
		r.emit("feed", nil, {})
	end
	Spec.equal(names(r.take(3)), "feed#1 feed#2 feed#3", "oldest first")
	Spec.equal(r.size(), 1, "one left")
	Spec.equal(names(r.take(3)), "feed#4", "the rest")
	Spec.equal(names(r.take(3)), "", "nothing left")
	Spec.equal(r.size(), 0, "empty")
	-- The numbering goes on: a row's number is never used twice on a server.
	r.emit("feed", nil, {})
	Spec.equal(names(r.recent()), "feed#5", "numbering continues")
end)

Spec.test("take fills from the protected ring first and tops up from the bulk", function()
	const r = ring(10, 10)
	r.emit("feed", nil, {})
	r.emit("session", nil, {})
	r.emit("feed", nil, {})
	r.emit("session", nil, {})
	r.emit("session", nil, {})
	Spec.equal(names(r.take(2)), "session#2 session#4", "protected only, the batch is full")
	Spec.equal(names(r.take(2)), "session#5 feed#1", "then the bulk")
	Spec.equal(names(r.take(2)), "feed#3", "what is left")
end)

Spec.test("an urgent row waiting is said until a take has carried it, and bulk rows never say it", function()
	const r = ring(10, 10)
	Spec.equal(r.urgent(), false, "nothing waits")
	r.emit("feed", nil, {})
	r.emit("session", nil, {})
	Spec.equal(r.urgent(), false, "bulk and protected rows are not urgent")
	r.emit("purchase", nil, {})
	r.emit("purchase", nil, {})
	Spec.equal(r.urgent(), true, "an urgent row waits")
	r.take(2)
	Spec.equal(r.urgent(), true, "one urgent row is still waiting")
	r.take(1)
	Spec.equal(r.urgent(), false, "all carried, though a bulk row still waits")
	Spec.equal(r.size(), 1, "the bulk row")
end)

Spec.test("recent is a copy, newest last, of as many rows as asked", function()
	const r = ring(10, 10)
	r.emit("feed", nil, {})
	r.emit("purchase", nil, {})
	r.emit("feed", nil, {})
	Spec.equal(names(r.recent()), "feed#1 purchase#2 feed#3", "both tiers, by number")
	Spec.equal(names(r.recent(2)), "purchase#2 feed#3", "the newest two")
	Spec.equal(names(r.recent(0)), "", "none")
	Spec.equal(names(r.recent(99)), "feed#1 purchase#2 feed#3", "no more than there are")
	table.clear(r.recent())
	Spec.equal(r.size(), 3, "clearing the copy clears nothing")
end)

Spec.test("housekeeping never moves or loses a waiting row", function()
	-- Fill past the compaction point, then read, round after round: a spent row the move left
	-- behind, or a waiting row it ate, shows up in the very next take.
	const r = ring(5, 2)
	local emitted = 0
	for round = 1, 10 do
		for _ = 1, 23 do
			emitted += 1
			r.emit("feed", nil, {})
		end
		Spec.equal(r.size(), 5, `bounded, round {round}`)
		const want = {}
		for index = emitted - 4, emitted do
			table.insert(want, `feed#{index}`)
		end
		Spec.equal(names(r.take(10)), table.concat(want, " "), `the newest five, round {round}`)
	end
	r.emit("session", nil, {})
	emitted += 1
	r.emit("feed", nil, {})
	emitted += 1
	Spec.equal(names(r.take(5)), `session#{emitted - 1} feed#{emitted}`, "protected first, after the housekeeping")
end)

Spec.test("the three losses are counted apart, and a claim zeroes them", function()
	const r = ring(1, 1)
	r.emit("feed", nil, {})
	r.emit("feed", nil, {})
	r.addUnsent(40)
	r.refuse()
	r.refuse()
	Spec.equal(r.dropped(), 43, "all three")
	const evicted, unsent, refused = r.claimDropped()
	Spec.equal({ evicted, unsent, refused }, { 1, 40, 2 }, "apart")
	Spec.equal(r.dropped(), 0, "claimed")
	const again, againUnsent, againRefused = r.claimDropped()
	Spec.equal({ again, againUnsent, againRefused }, { 0, 0, 0 }, "claimed once")
end)

return nil
