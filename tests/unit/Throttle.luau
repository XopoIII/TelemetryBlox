--!strict
--- A 429: the ingest asking for time. The batch is held without spending a try, for a bounded
--- number of posts, and it buys no post the pipe would not have made anyway.
const Pipe = require("@telemetryblox/Pipe")
const Ring = require("@telemetryblox/Ring")
const Spec = require("../Spec")
const World = require("@fakes/World")

const function setup(change: ((Pipe.Config) -> ())?): (World.World, Ring.Ring, Pipe.Pipe)
	const world = World.new()
	const ring = Ring.new({
		size = 100,
		protectedSize = 100,
		priorities = { purchase = "urgent", telemetry_drop = "protected" },
		now = world.services.now,
	})
	const settings: Pipe.Config = {
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
	if change then
		change(settings)
	end
	return world, ring, Pipe.new(settings, ring, world.services)
end

const function answers(status: number, count: number): { World.Answer }
	const out: { World.Answer } = {}
	for index = 1, count do
		out[index] = status
	end
	return out
end

-- The `try` each retry was logged with, in order.
const function triesSaid(world: World.World): { number }
	const out: { number } = {}
	for _, warning in world.warnings do
		if warning.id == "telemetry.send_retry" then
			table.insert(out, warning.context.try)
		end
	end
	return out
end

Spec.test("a 429 holds the batch and costs no try, and any other refusal still costs one", function()
	Spec.equal(Pipe.TOO_MANY_REQUESTS, 429, "the status")
	const world, ring, pipe = setup()
	world.answers = { 429, 429, 500, 429, 503, 500 }
	ring.emit("purchase", "u_a", { robux = 25 })
	ring.emit("feed", "u_a", {})
	Spec.equal(pipe.flushOnce(), false, "asked to wait")
	Spec.equal(pipe.backlog(), 2, "held")
	Spec.equal(ring.dropped(), 0, "nothing lost")
	Spec.equal(world.warnings, {
		{ id = "telemetry.send_retry", context = { count = 2, try = 0, reason = "http 429" } },
	}, "said in the log, with no try spent")
	for index = 2, 5 do
		Spec.equal(pipe.flushOnce(), false, `post {index}`)
	end
	Spec.equal(triesSaid(world), { 0, 0, 1, 1, 2 }, "the two real refusals each cost a try, the three 429s none")
	Spec.equal(pipe.backlog(), 2, "still held after five posts: under the old rule it was lost at the third")
	Spec.equal(ring.dropped(), 0, "and nothing is lost yet")

	-- The third real refusal is the last: maxTries is still three.
	Spec.equal(pipe.flushOnce(), false, "post 6")
	Spec.equal(#world.posts, 6, "six posts in all")
	Spec.equal(ring.dropped(), 2, "both rows lost")
	Spec.equal(pipe.backlog(), 0, "no longer held")
	Spec.equal(world.warnings[6], {
		id = "telemetry.send_failed",
		context = { count = 2, dropped = 2, reason = "http 500" },
	}, "the loss, with its cause")
	for index = 2, 6 do
		Spec.equal(world.posts[index].envelope.events, world.posts[1].envelope.events, `the same batch, post {index}`)
	end
end)

Spec.test("a batch that waited is taken whole when the ingest has room again", function()
	const world, ring, pipe = setup()
	world.answers = { 429, 429, 429 }
	ring.emit("purchase", "u_a", { robux = 25 })
	for index = 1, 3 do
		Spec.equal(pipe.flushOnce(), false, `asked to wait, post {index}`)
	end
	Spec.equal(pipe.flushOnce(), true, "taken on the fourth post")
	Spec.equal(world.posts[4].envelope.events, {
		{ seq = 1, t = 1_800_000_000, event = "purchase", actor = "u_a", ctx = { robux = 25 } },
	}, "the purchase, whole")
	Spec.equal(ring.dropped(), 0, "nothing lost")
	Spec.equal(pipe.backlog(), 0, "nothing waits")
end)

Spec.test("with one try a 429 is still held, and the first real refusal loses the batch", function()
	const world, ring, pipe = setup(function(settings: Pipe.Config)
		settings.maxTries = 1
	end)
	world.answers = { 429, 500 }
	ring.emit("feed", nil, {})
	Spec.equal(pipe.flushOnce(), false, "asked to wait")
	Spec.equal({ pipe.backlog(), ring.dropped() }, { 1, 0 }, "held, not lost")
	Spec.equal(pipe.flushOnce(), false, "refused")
	Spec.equal({ pipe.backlog(), ring.dropped() }, { 0, 1 }, "lost at once")
	Spec.equal(world.warnings[2].id, "telemetry.send_failed", "said as a loss")
end)

Spec.test("an ingest that only ever says 429 holds a batch for ten posts, then three tries, and no longer", function()
	Spec.equal(Pipe.MAX_WAITS, 10, "the bound")
	const world, ring, pipe = setup()
	world.answers = answers(429, 14)
	ring.emit("feed", nil, {})
	for index = 1, 12 do
		Spec.equal(pipe.flushOnce(), false, `post {index}`)
		Spec.equal({ pipe.backlog(), ring.dropped() }, { 1, 0 }, `held after post {index}`)
	end
	Spec.equal(triesSaid(world), { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2 }, "ten waits, then each 429 costs a try")
	Spec.equal(pipe.flushOnce(), false, "post 13")
	Spec.equal({ pipe.backlog(), ring.dropped() }, { 0, 1 }, "lost at the thirteenth post")
	Spec.equal(world.warnings[13], {
		id = "telemetry.send_failed",
		context = { count = 1, dropped = 1, reason = "http 429" },
	}, "the loss names the 429")

	-- The waits are one batch's: the next batch has its own ten.
	ring.emit("feed", nil, {})
	Spec.equal(pipe.flushOnce(), false, "the next batch, asked to wait")
	Spec.equal(world.warnings[14].context.try, 0, "its waits start again")
end)

Spec.test("the waits start again once a batch is taken", function()
	const world, ring, pipe = setup()
	world.answers = answers(429, 10)
	world.answers[11] = true
	world.answers[12] = 429
	ring.emit("feed", nil, {})
	for index = 1, 10 do
		Spec.equal(pipe.flushOnce(), false, `post {index}`)
	end
	Spec.equal(pipe.flushOnce(), true, "taken on the eleventh")
	ring.emit("feed", nil, {})
	Spec.equal(pipe.flushOnce(), false, "the next batch, asked to wait")
	Spec.equal(triesSaid(world)[11], 0, "with its own waits: no try spent")
end)

Spec.test("a batch asked to wait is posted once a wake, never more often", function()
	const world, ring, pipe = setup()
	world.answers = answers(429, 3)
	ring.emit("feed", nil, {})
	ring.emit("feed", nil, {})
	ring.emit("feed", nil, {})
	-- How many posts had been made when each wake began.
	const seen: { number } = {}
	world.onWait = function()
		table.insert(seen, #world.posts)
		if #seen == 6 then
			error("stop")
		end
	end
	Spec.equal(pcall(pipe.run), false, "the loop only ends when the spec stops it")
	Spec.equal(world.waits, { 37, 60, 60, 60, 60, 60 }, "the stagger, then a minute a wake")
	-- Three rows of a batch of four are an early post, on the first wake. Each 429 is answered by
	-- one post on the next wake and nothing in between; the fourth post is taken.
	Spec.equal(seen, { 0, 1, 2, 3, 4, 4 }, "one post a wake while it waits, none once it is taken")
	Spec.equal(ring.dropped(), 0, "nothing lost")
end)

Spec.test("a closing server asked to wait three times still sends its tail", function()
	const world, ring, pipe = setup()
	world.players = 0
	world.answers = answers(429, 3)
	ring.emit("purchase", "u_a", { robux = 25 })
	pipe.drain(function(): boolean
		return world.players == 0
	end)
	Spec.equal(#world.posts, 4, "four posts")
	Spec.equal(world.posts[4].envelope.events, world.posts[1].envelope.events, "the same batch")
	Spec.equal({ world.waits[1], world.waits[2], world.waits[3] }, { 2, 2, 2 }, "two seconds before each retry")
	Spec.equal(#world.waits, 11, "then the quiet two seconds, a quarter at a time")
	Spec.equal({ pipe.backlog(), ring.dropped() }, { 0, 0 }, "sent, nothing lost")
end)

Spec.test("an ingest that says 429 to the end costs a closing server its budget and no more", function()
	const world, ring, pipe = setup()
	world.players = 0
	world.answers = answers(429, 50)
	ring.emit("purchase", "u_a", { robux = 25 })
	pipe.drain(function(): boolean
		return world.players == 0
	end)
	Spec.equal(world.waits, table.create(10, 2), "a retry every two seconds for twenty")
	Spec.equal(#world.posts, 10, "ten posts, as for any refusal")
	Spec.equal({ pipe.backlog(), ring.dropped() }, { 1, 0 }, "the batch is still held when the budget ends")
end)

return nil
