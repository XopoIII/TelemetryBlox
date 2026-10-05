--!strict
--- Server errors, turned into rows. Without it a handler raising a hundred times a second after a
--- publish leaves no row and no alert, only Roblox's own error page.
---
--- IT DEDUPES BY MESSAGE. An error inside a per-frame loop fires at frame rate. A row each would
--- flood the ring, evict the rows an incident needs, and make the fix the second incident. So each
--- distinct message is reported the first few times and then on a decaying schedule (10, 100,
--- 1000...), carrying its own count. The count is the useful number anyway.
---
--- IT REPORTS, AND NEVER JUDGES. A script error is a fact about the game's code; nothing here may
--- feed a score or a sanction.
---
--- It holds no Roblox service: the front door connects `report` to `ScriptContext.Error` through the
--- `Services` seam, so the schedule and the cap are run by the specs.
const ErrorReporter = {}

export type Report = {
	--> The raised message, verbatim. Also what repeats are counted by.
	message: string,
	--> The full name of the script that raised, or "?".
	script: string,
	--> The first few frames of the stack (`headOf`).
	trace: string,
	--> How many times this message was seen in this server's life, this one included.
	count: number,
}

export type Config = {
	--> Where a report goes. Must be total and must not yield: it runs from an engine signal.
	emit: (report: Report) -> (),
	--> Reports in full this many times a distinct message before going quiet. 3 by default.
	loud: number?,
	--> Distinct messages tracked. 200 by default.
	maxDistinct: number?,
}

export type Reporter = {
	--> One raised error. Total and non-yielding.
	report: (message: string, trace: string?, where: string?) -> (),
	--> Errors seen in this server's life.
	count: () -> number,
	--> Distinct messages tracked. Reaching the cap is itself a story.
	distinct: () -> number,
}

--> Whether `count` is a power of ten from 10 up: the occurrences still reported after the loud ones.
function ErrorReporter.isMilestone(count: number): boolean
	local power = 10
	while power <= count do
		if count == power then
			return true
		end
		power *= 10
	end
	return false
end

--> Whether the occurrence numbered `count` is reported, given `loud` reported in full.
function ErrorReporter.shouldReport(count: number, loud: number): boolean
	return count <= loud or ErrorReporter.isMilestone(count)
end

--> The first `frames` lines of a stack (4 by default), joined by " | ". A whole trace is often dozens
--> of lines of engine internals; what names a bug is where it was raised and who called it.
function ErrorReporter.headOf(trace: string?, frames: number?): string
	if trace == nil or trace == "" then
		return ""
	end
	const limit = frames or 4
	const lines: { string } = {}
	for line in string.gmatch(trace, "[^\n]+") do
		table.insert(lines, line)
		if #lines >= limit then
			break
		end
	end
	return table.concat(lines, " | ")
end

--> Builds one server's reporter.
function ErrorReporter.new(config: Config): Reporter
	const loud = config.loud or 3
	const maxDistinct = config.maxDistinct or 200

	const seen: { [string]: number } = {}
	-- Counted, not measured: `#` of a table with string keys is always 0, so a cap written with it
	-- would never fire.
	local distinct = 0
	local total = 0

	const self = {} :: Reporter

	function self.count(): number
		return total
	end

	function self.distinct(): number
		return distinct
	end

	function self.report(message: string, trace: string?, where: string?)
		total += 1
		const before = seen[message]
		local tracked = before ~= nil
		-- Bounded, so an error with a unique value in every message (an id, a position) cannot grow
		-- the table without limit. Past the cap a new message is not tracked rather than not
		-- reported: it reads as first seen every time, which is noisier but never wrong.
		if not tracked and distinct < maxDistinct then
			distinct += 1
			tracked = true
		end
		const count = (before or 0) + 1
		if tracked then
			seen[message] = count
		end
		if not ErrorReporter.shouldReport(count, loud) then
			return
		end
		config.emit({
			message = message,
			script = where or "?",
			trace = ErrorReporter.headOf(trace),
			count = count,
		})
	end

	return self
end

return ErrorReporter
