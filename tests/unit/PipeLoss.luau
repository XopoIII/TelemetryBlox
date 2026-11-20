--!strict
--- What becomes of a batch the ingest would not take: an answer that refuses it, an answer that asks
--- for time, or no answer at all. The pipe's batching, its envelope and its timing are in `Pipe.luau`.
const Pipe = require("@telemetryblox/Pipe")
const Ring = require("@telemetryblox/Ring")
const Spec = require("../Spec")
const World = require("@fakes/World")

const function config(): Pipe.Config
	return {
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
	}
end

const function setup(change: ((Pipe.Config) -> ())?): (World.World, Ring.Ring, Pipe.Pipe)
	const world = World.new()
	const ring = Ring.new({
		size = 100,
		protectedSize = 100,
		priorities = { purchase = "urgent", telemetry_drop = "protected" },
		now = world.services.now,
	})
	const settings = config()
	if change then
		change(settings)
	end
	return world, ring, Pipe.new(settings, ring, world.services)
end

--- The fake's answer for a post that never reached an ingest and never came back.
const NO_ANSWER: World.Answer = "raise"

Spec.test("a batch refused three times is counted lost, and the loss is said with its cause", function()
	const world, ring, pipe = setup()
	world.answers = { 400, 401, 403 }
	ring.emit("feed", nil, {})
	ring.emit("feed", nil, {})
	Spec.equal(pipe.flushOnce(), false, "first")
	Spec.equal(pipe.flushOnce(), false, "second")
	Spec.equal(ring.dropped(), 0, "two refusals lose nothing yet")
	Spec.equal(pipe.backlog(), 2, "still held")
	Spec.equal(pipe.flushOnce(), false, "third")
	Spec.equal(#world.posts, 3, "three posts in all")
	Spec.equal(ring.dropped(), 2, "both rows lost")
	Spec.equal(pipe.backlog(), 0, "no longer held")
	Spec.equal(world.warnings, {
		{ id = "telemetry.send_retry", context = { count = 2, try = 1, reason = "http 400" } },
		{ id = "telemetry.send_retry", context = { count = 2, try = 2, reason = "http 401" } },
		{ id = "telemetry.send_failed", context = { count = 2, dropped = 2, reason = "http 403" } },
	}, "each answer is said, and the loss names the last")

	-- The count starts again for the next batch.
	ring.emit("feed", nil, {})
	world.answers[4] = 400
	Spec.equal(pipe.flushOnce(), false, "a new batch, its first try")
	Spec.equal(world.warnings[4].context.try, 1, "tries start at one")
end)

Spec.test("with one try a refused batch is lost at once", function()
	const world, ring, pipe = setup(function(settings: Pipe.Config)
		settings.maxTries = 1
	end)
	world.answers = { 400 }
	ring.emit("feed", nil, {})
	Spec.equal(pipe.flushOnce(), false, "refused")
	Spec.equal(ring.dropped(), 1, "lost")
	Spec.equal(world.warnings[1].id, "telemetry.send_failed", "no retry said")
end)

Spec.test("a 503 or a 500 asks for time, and the loss after its waits names it", function()
	const world, ring, pipe = setup(function(settings: Pipe.Config)
		settings.maxTries = 1
	end)
	ring.emit("feed", nil, {})
	for _, status in { 429, 500, 503 } do
		table.insert(world.answers, status)
		Spec.equal(pipe.flushOnce(), false, `http {status}`)
		Spec.equal(world.warnings[#world.warnings].context.try, 0, "no try spent")
		Spec.equal({ pipe.backlog(), ring.dropped() }, { 1, 0 }, "held, not lost")
	end
	-- The waits belong to the batch, and past MAX_WAITS it costs the one try it has.
	for _ = 1, Pipe.MAX_WAITS - 3 do
		table.insert(world.answers, 503)
		pipe.flushOnce()
	end
	Spec.equal(world.warnings[Pipe.MAX_WAITS].context.try, 0, "ten waits, no try")
	table.insert(world.answers, 503)
	Spec.equal(pipe.flushOnce(), false, "the try, and the loss")
	Spec.equal(ring.dropped(), 1, "lost with its only try")
	pipe.reportDrops()
	Spec.equal(ring.recent()[1].ctx.reason, "http 503", "the loss names the 503")

	-- A post the ingest takes clears it: no loss afterwards names a reason that is not its own.
	ring.emit("feed", nil, {})
	Spec.equal(pipe.flushOnce(), true, "taken")
	ring.addUnsent(1)
	pipe.reportDrops()
	Spec.equal(ring.recent()[1].ctx.reason, nil, "no stale reason")
end)

Spec.test("a post no answer ever came back for asks for time, and the loss names the error", function()
	const world, ring, pipe = setup(function(settings: Pipe.Config)
		settings.maxTries = 1
	end)
	ring.emit("feed", nil, {})
	-- Nothing came back: a timeout, a name that would not resolve, a reset. Nothing was said about
	-- the batch, so it is not the batch's, and no try is spent on any of them.
	for _ = 1, Pipe.MAX_WAITS do
		table.insert(world.answers, NO_ANSWER)
		Spec.equal(pipe.flushOnce(), false, "no answer")
		Spec.equal(world.warnings[#world.warnings].context.try, 0, "no try spent")
		Spec.equal({ pipe.backlog(), ring.dropped() }, { 1, 0 }, "held, not lost")
	end
	-- Past MAX_WAITS it costs the one try the batch has, exactly as a held 503 does.
	table.insert(world.answers, NO_ANSWER)
	Spec.equal(pipe.flushOnce(), false, "the try, and the loss")
	Spec.equal(ring.dropped(), 1, "lost with its only try")
	pipe.reportDrops()
	const lost = ring.recent()[1]
	Spec.equal({ lost.ctx.count, lost.ctx.send_failed, lost.ctx.overflow }, { 1, 1, 0 }, "the loss counts it")
	Spec.truthy(string.find(lost.ctx.reason, "ConnectFail", 1, true) ~= nil, "the loss names the error")
end)

Spec.test("without the secret the batch still goes, with no key, and is seen refused", function()
	const world, ring, pipe = setup()
	world.secretMissing = true
	world.answers = { 401 }
	ring.emit("feed", nil, {})
	Spec.equal(pipe.flushOnce(), false, "refused by the ingest")
	Spec.equal(world.posts[1].headers, { ["content-type"] = "application/json" }, "no key header")
	Spec.equal(world.warnings[1].context.reason, "http 401", "the refusal is the reason")
end)

Spec.test("losses are written into the stream once, as one row with each cause", function()
	const _, ring, pipe = setup()
	pipe.reportDrops()
	Spec.equal(ring.size(), 0, "no loss, no row")
	ring.addUnsent(7)
	ring.refuse()
	pipe.reportDrops()
	Spec.equal(ring.recent(), {
		{
			seq = 1,
			t = 1_800_000_000,
			event = "telemetry_drop",
			ctx = { count = 8, overflow = 0, send_failed = 7, refused = 1 },
		},
	}, "the drop row")
	pipe.reportDrops()
	Spec.equal(ring.size(), 1, "said once")
end)

return nil
