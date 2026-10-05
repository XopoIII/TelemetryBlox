--!strict
--- The pipe: what a post carries, when one is due, and what becomes of a batch the ingest refuses.
--- The shutdown drain is in `Drain.luau`.
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

Spec.test("a post carries the batch in its envelope, to the endpoint, with the key", function()
	const world, ring, pipe = setup()
	ring.emit("feed", "u_a", { pieces = 3 })
	world.now += 30
	ring.emit("purchase", nil, { robux = 25 })
	world.now += 5
	Spec.equal(pipe.flushOnce(), true, "taken")
	Spec.equal(#world.posts, 1, "one post")
	Spec.equal(world.posts[1].url, "https://ingest.test/ingest", "url")
	Spec.equal(world.posts[1].headers, {
		["content-type"] = "application/json",
		["x-api-key"] = "secret:ExampleKey",
	}, "headers")
	Spec.equal(world.posts[1].envelope, {
		schemaVersion = 1,
		game = "example",
		universeId = "111",
		placeId = "222",
		placeVersion = 7,
		jobId = "job-a",
		env = "live",
		serverStart = 1_800_000_000,
		sentAt = 1_800_000_035,
		events = {
			{ seq = 2, t = 1_800_000_030, event = "purchase", ctx = { robux = 25 } },
			{ seq = 1, t = 1_800_000_000, event = "feed", actor = "u_a", ctx = { pieces = 3 } },
		},
	}, "envelope")
	Spec.equal(pipe.backlog(), 0, "nothing waits")
end)

Spec.test("the game's own place version and environment are said when it gives them", function()
	const world, ring, pipe = setup(function(settings: Pipe.Config)
		settings.placeVersion = 99
		settings.env = "test"
	end)
	ring.emit("feed", nil, {})
	pipe.flushOnce()
	Spec.equal(world.posts[1].envelope.placeVersion, 99, "place version")
	Spec.equal(world.posts[1].envelope.env, "test", "environment")
end)

Spec.test("nothing waiting posts nothing, and no destination posts nothing and keeps the rows", function()
	const world, _, pipe = setup()
	Spec.equal(pipe.flushOnce(), false, "nothing to send")
	Spec.equal(#world.posts, 0, "no empty post")

	const quiet, ring, collecting = setup(function(settings: Pipe.Config)
		settings.destination = ""
	end)
	ring.emit("feed", nil, {})
	Spec.equal(collecting.flushOnce(), false, "collect only")
	Spec.equal(#quiet.posts, 0, "nothing left the server")
	Spec.equal(ring.size(), 1, "the row still waits")
end)

Spec.test("a post carries at most maxBatch rows, oldest first", function()
	const world, ring, pipe = setup()
	for _ = 1, 10 do
		ring.emit("feed", nil, {})
	end
	Spec.equal(pipe.flushOnce(), true, "first")
	Spec.equal(pipe.backlog(), 6, "six wait")
	pipe.flushOnce()
	pipe.flushOnce()
	Spec.equal(pipe.flushOnce(), false, "nothing left for a fourth")
	const sizes = { #world.posts[1].envelope.events, #world.posts[2].envelope.events, #world.posts[3].envelope.events }
	Spec.equal(sizes, { 4, 4, 2 }, "batch sizes")
	Spec.equal(world.posts[2].envelope.events[1].seq, 5, "the second batch starts where the first ended")
end)

Spec.test("a refused batch is held and sent again as the same batch", function()
	const world, ring, pipe = setup()
	world.answers = { 503 }
	ring.emit("feed", "u_a", { n = 1 })
	ring.emit("feed", "u_a", { n = 2 })
	Spec.equal(pipe.flushOnce(), false, "refused")
	Spec.equal(pipe.backlog(), 2, "held, not lost")
	Spec.equal(ring.size(), 0, "and not put back in the ring")
	Spec.equal(ring.dropped(), 0, "nothing counted lost")
	Spec.equal(world.warnings, {
		{ id = "telemetry.send_retry", context = { count = 2, try = 1, reason = "http 503" } },
	}, "said in the log")

	-- Rows written meanwhile wait their turn: the retry is the same rows and no others.
	ring.emit("feed", "u_a", { n = 3 })
	world.now += 60
	Spec.equal(pipe.flushOnce(), true, "taken the second time")
	const first, second = world.posts[1].envelope, world.posts[2].envelope
	Spec.equal(second.events, first.events, "the same rows")
	Spec.equal(
		{ second.jobId, second.serverStart, second.events[1].seq },
		{ "job-a", 1_800_000_000, 1 },
		"the same identity"
	)
	Spec.equal({ first.sentAt, second.sentAt }, { 1_800_000_000, 1_800_000_060 }, "sent a minute apart")

	-- The next batch is another one: it starts at another row.
	Spec.equal(pipe.flushOnce(), true, "the row that waited")
	Spec.equal(
		world.posts[3].envelope.events,
		{ { seq = 3, t = 1_800_000_000, event = "feed", actor = "u_a", ctx = { n = 3 } } },
		"next"
	)
	Spec.equal(pipe.backlog(), 0, "all sent")
end)

Spec.test("a batch refused three times is counted lost, and the loss is said with its cause", function()
	const world, ring, pipe = setup()
	world.answers = { 500, "raise", 401 }
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
	Spec.equal(
		world.warnings[1],
		{ id = "telemetry.send_retry", context = { count = 2, try = 1, reason = "http 500" } },
		"1"
	)
	Spec.equal(world.warnings[2].id, "telemetry.send_retry", "2")
	Spec.truthy(string.find(world.warnings[2].context.reason, "ConnectFail", 1, true) ~= nil, "the error is the reason")
	Spec.equal(world.warnings[3], {
		id = "telemetry.send_failed",
		context = { count = 2, dropped = 2, reason = "http 401" },
	}, "3")

	-- The count starts again for the next batch.
	ring.emit("feed", nil, {})
	world.answers[4] = 500
	Spec.equal(pipe.flushOnce(), false, "a new batch, its first try")
	Spec.equal(world.warnings[4].context.try, 1, "tries start at one")
end)

Spec.test("with one try a refused batch is lost at once", function()
	const world, ring, pipe = setup(function(settings: Pipe.Config)
		settings.maxTries = 1
	end)
	world.answers = { 500 }
	ring.emit("feed", nil, {})
	Spec.equal(pipe.flushOnce(), false, "refused")
	Spec.equal(ring.dropped(), 1, "lost")
	Spec.equal(world.warnings[1].id, "telemetry.send_failed", "no retry said")
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

Spec.test("a post is due every three minutes, and early only for cause", function()
	const world, ring, pipe = setup()
	Spec.equal(pipe.due(179), false, "not yet")
	Spec.equal(pipe.due(180), true, "three minutes")
	ring.emit("feed", nil, {})
	Spec.equal(pipe.due(0), false, "one bulk row is no cause")
	-- Half a batch of four is two rows.
	ring.emit("feed", nil, {})
	Spec.equal(pipe.due(0), true, "half a batch waits")
	ring.take(10)
	Spec.equal(pipe.due(0), false, "emptied")
	ring.emit("purchase", nil, {})
	Spec.equal(pipe.due(0), true, "an urgent row waits")
	world.answers = { 503 }
	pipe.flushOnce()
	Spec.equal(ring.urgent(), false, "the urgent row is in the held batch now")
	Spec.equal(pipe.due(0), true, "a held batch waits for its retry")
	pipe.flushOnce()
	Spec.equal(pipe.due(0), false, "sent: nothing is due")
end)

Spec.test("the flusher wakes every minute and posts on the third, then counts again", function()
	const world, ring, pipe = setup()
	ring.emit("feed", nil, {})
	-- How many posts had been made when each wake began.
	const seen: { number } = {}
	world.onWait = function()
		table.insert(seen, #world.posts)
		if #seen == 4 then
			ring.emit("feed", nil, {})
		elseif #seen == 8 then
			error("stop")
		end
	end
	Spec.equal(pcall(pipe.run), false, "the loop only ends when the spec stops it")
	Spec.equal(world.waits, { 60, 60, 60, 60, 60, 60, 60, 60 }, "a minute a wake")
	-- The first row leaves on the third wake; the second, written during the fourth, leaves three
	-- minutes after that post, on the sixth.
	Spec.equal(seen, { 0, 0, 0, 1, 1, 1, 2, 2 }, "posts made by each wake")
end)

Spec.test("an urgent row leaves on the next wake, not in three minutes", function()
	const world, ring, pipe = setup()
	world.clock += 60
	pipe.tick()
	Spec.equal(#world.posts, 0, "nothing to send")
	ring.emit("purchase", nil, { robux = 25 })
	world.clock += 60
	pipe.tick()
	Spec.equal(world.names(1), "purchase", "sent on the next wake")
	-- A bulk row written now waits the full three minutes from that post.
	ring.emit("feed", nil, {})
	world.clock += 179
	pipe.tick()
	Spec.equal(#world.posts, 1, "not yet")
	world.clock += 1
	pipe.tick()
	Spec.equal(world.names(2), "feed", "three minutes after the last post")
end)

Spec.test("a wake reports the losses before it posts, so the drop row rides the same batch", function()
	const world, ring, pipe = setup()
	ring.addUnsent(3)
	world.clock += 180
	pipe.tick()
	Spec.equal(world.names(1), "telemetry_drop", "the drop row was sent")
	Spec.equal(world.posts[1].envelope.events[1].ctx.send_failed, 3, "with its cause")
end)

return nil
