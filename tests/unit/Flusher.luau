--!strict
--- The flusher's wakes: staggered by the job id at first, then a tick apart.
const Pipe = require("@telemetryblox/Pipe")
const Ring = require("@telemetryblox/Ring")
const Spec = require("../Spec")
const World = require("@fakes/World")

const function setup(): (World.World, Ring.Ring, Pipe.Pipe)
	const world = World.new()
	const ring = Ring.new({
		size = 100,
		protectedSize = 100,
		priorities = { purchase = "urgent", telemetry_drop = "protected" },
		now = world.services.now,
	})
	return world,
		ring,
		Pipe.new({
			destination = "https://ingest.test/ingest",
			secretName = "ExampleKey",
			game = "example",
			env = "live",
			dropEvent = "telemetry_drop",
			maxBatch = 4,
			flushSeconds = 180,
			tickSeconds = 60,
			maxTries = 3,
			closeBudget = 20,
			closeQuiet = 2,
		}, ring, world.services)
end

Spec.test("the flusher wakes every minute after a staggered first wake, and posts when due", function()
	const world, ring, pipe = setup()
	ring.emit("feed", nil, {})
	-- How many posts had been made when each wake began.
	const seen: { number } = {}
	world.onWait = function()
		table.insert(seen, #world.posts)
		if #seen == 5 then
			ring.emit("feed", nil, {})
		elseif #seen == 8 then
			error("stop")
		end
	end
	Spec.equal(pcall(pipe.run), false, "the loop only ends when the spec stops it")
	-- The fake server's job id is "job-a": its stagger is 37 seconds, then a wake a minute.
	Spec.equal(world.waits, { 37, 60, 60, 60, 60, 60, 60, 60 }, "the stagger, then a minute a wake")
	-- The first row leaves once three minutes have passed (the fourth wake, at 37 + 3 * 60); the
	-- second, written after that post, leaves three minutes later, on the seventh wake.
	Spec.equal(seen, { 0, 0, 0, 0, 1, 1, 1, 2 }, "posts made by each wake")
end)

Spec.test("the stagger is the job id's, is shorter than a tick, and is the same every time", function()
	Spec.equal(Pipe.stagger("job-a", 60), 37, "pinned: the hash is the pipe's own, and never changes")
	Spec.equal(Pipe.stagger("job-b", 60), 38, "another server, another offset")
	for _, tick in { 1, 7, 60, 180 } do
		for index = 1, 20 do
			const stagger = Pipe.stagger(`job-{index}`, tick)
			Spec.truthy(stagger >= 0 and stagger < tick, `within the tick: {stagger} < {tick}`)
			Spec.equal(stagger, Pipe.stagger(`job-{index}`, tick), "deterministic")
		end
	end
	-- A tick under a second (a spec's own) still staggers to zero, never a crash on the modulo.
	Spec.equal(Pipe.stagger("job-a", 0.5), 0, "a sub-second tick")
	-- Studio has no job id: the empty string staggers to zero, and Studio never sends anyway.
	Spec.equal(Pipe.stagger("", 60), 0, "no job id")
end)

return nil
