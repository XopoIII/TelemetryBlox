--!strict
--- The bounded buffer every row waits in. Kept apart from the transport (`Pipe`) so that writing a row
--- costs the game one table insert: no network, no yield.
---
--- THE RULE: telemetry must never be able to hurt the game. When the ingest is down the ring drops its
--- OLDEST rows and counts the loss, so a dead backend cannot grow memory without bound, and a hole in
--- the data reads as a hole (the drop report), not as a zero.
---
--- TWO TIERS. One drop-oldest ring makes every row equally losable, and a game's rows are never
--- equal: a frequent row would evict the rare ones that matter (an error, a purchase) under load. So
--- the rows a game names `protected` or `urgent` wait in a second, small ring the bulk stream cannot
--- evict: the noise can only ever evict itself. An `urgent` row also asks the pipe for an early post.
const Ring = {}

export type Context = { [string]: any }

--> How a row is treated while it waits: evictable by the bulk stream, kept apart from it, or kept
--> apart and sent on the next tick.
export type Priority = "bulk" | "protected" | "urgent"

export type Row = {
	--> The row's number on this server, from 1. With the server's job id and start it names the row.
	seq: number,
	--> Unix seconds when it was written.
	t: number,
	event: string,
	--> The player's pseudonym (`Anon`); nil for a row about no player.
	actor: string?,
	ctx: Context,
}

export type Config = {
	--> Rows the bulk ring holds before it drops its oldest.
	size: number,
	--> Rows the protected ring holds before it drops its oldest.
	protectedSize: number,
	--> Each event's priority. An event not listed is bulk.
	priorities: { [string]: Priority },
	--> Unix seconds.
	now: () -> number,
}

export type Ring = {
	--> Appends one row. Total and non-yielding.
	emit: (event: string, actor: string?, ctx: Context) -> (),
	--> Rows waiting, both tiers.
	size: () -> number,
	--> Takes up to `max` of the oldest rows out, the protected ones first.
	take: (max: number) -> { Row },
	--> A copy of the newest `count` rows waiting (all of them by default), oldest first.
	recent: (count: number?) -> { Row },
	--> Whether an urgent row is waiting.
	urgent: () -> boolean,
	--> Rows lost since the last claim: evicted, never taken by the ingest, or refused at the door.
	dropped: () -> number,
	--> Counts the rows of a batch the ingest never took.
	addUnsent: (count: number) -> (),
	--> Counts one row refused at the door (a name outside the vocabulary, an argument of no use).
	refuse: () -> (),
	--> Reads the three loss counters and zeroes them: evicted, unsent, refused.
	claimDropped: () -> (number, number, number),
}

-- Moves up to `want` of the oldest rows of `source` onto `batch`. Returns how many moved.
const function move(source: { Row }, batch: { Row }, want: number): number
	const count = math.min(#source, want)
	for index = 1, count do
		batch[#batch + 1] = source[index]
	end
	table.move(source, count + 1, #source, 1)
	for _ = 1, count do
		table.remove(source)
	end
	return count
end

--> Builds one ring.
function Ring.new(config: Config): Ring
	const bulk: { Row } = {}
	const protected: { Row } = {}
	local seq = 0
	local urgent = false
	-- Losses since the last claim, by cause, because the causes are different stories: a full ring is
	-- the game's volume, an untaken batch is the ingest, a refused row is a caller's mistake.
	local evicted, unsent, refused = 0, 0, 0

	const self = {} :: Ring

	function self.emit(event: string, actor: string?, ctx: Context)
		seq += 1
		const row: Row = { seq = seq, t = config.now(), event = event, actor = actor, ctx = ctx }
		const priority = config.priorities[event]
		const kept = priority == "protected" or priority == "urgent"
		const target = if kept then protected else bulk
		table.insert(target, row)
		if priority == "urgent" then
			urgent = true
		end
		if #target > (if kept then config.protectedSize else config.size) then
			table.remove(target, 1)
			evicted += 1
		end
	end

	function self.size(): number
		return #bulk + #protected
	end

	-- Taking the rows out (rather than peeking) is what makes a down ingest safe: a batch left in the
	-- ring while the game keeps writing would be eaten by drop-oldest while it was being retried.
	--
	-- The protected ring drains FIRST, so a saturated bulk stream cannot starve it of a post either.
	-- Order between the tiers is not kept and need not be: every row carries `seq` and `t`.
	function self.take(max: number): { Row }
		const batch: { Row } = {}
		const took = move(protected, batch, max)
		move(bulk, batch, max - took)
		-- Every urgent row rides the protected ring, so a take that emptied it has carried them all.
		if #protected == 0 then
			urgent = false
		end
		return batch
	end

	function self.recent(count: number?): { Row }
		const all: { Row } = {}
		for _, row in bulk do
			table.insert(all, row)
		end
		for _, row in protected do
			table.insert(all, row)
		end
		table.sort(all, function(a: Row, b: Row): boolean
			return a.seq < b.seq
		end)
		const want = math.min(count or #all, #all)
		const out: { Row } = {}
		for index = #all - want + 1, #all do
			table.insert(out, all[index])
		end
		return out
	end

	function self.urgent(): boolean
		return urgent
	end

	function self.dropped(): number
		return evicted + unsent + refused
	end

	function self.addUnsent(count: number)
		unsent += count
	end

	function self.refuse()
		refused += 1
	end

	-- Read and zeroed together, so the pipe can report the hole INTO the stream exactly once.
	function self.claimDropped(): (number, number, number)
		const wasEvicted, wasUnsent, wasRefused = evicted, unsent, refused
		evicted, unsent, refused = 0, 0, 0
		return wasEvicted, wasUnsent, wasRefused
	end

	return self
end

return Ring
