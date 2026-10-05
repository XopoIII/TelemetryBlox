--!strict
--- The shutdown drain: the tail of a session reaches the ingest, and the drain never outlasts its
--- budget. The fake clock moves only when the drain waits, so every duration below is exact.
const Pipe = require("@telemetryblox/Pipe")
const Ring = require("@telemetryblox/Ring")
const Spec = require("../Spec")
const World = require("@fakes/World")

const function setup(change: ((Pipe.Config) -> ())?): (World.World, Ring.Ring, Pipe.Pipe)
	const world = World.new()
	const ring = Ring.new({
		size = 100,
		protectedSize = 100,
		priorities = { telemetry_drop = "protected" },
		now = world.services.now,
	})
	const settings: Pipe.Config = {
		destination = "https://ingest.test/ingest",
		secretName = "ExampleKey",
		game = "example",
		env = "live",
		dropEvent = "telemetry_drop",
		maxBatch = 100,
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

const function total(waits: { number }): number
	local sum = 0
	for _, seconds in waits do
		sum += seconds
	end
	return sum
end

const function repeated(value: number, count: number): { number }
	return table.create(count, value)
end

const function refusals(count: number): { World.Answer }
	const answers: { World.Answer } = {}
	for index = 1, count do
		answers[index] = 503
	end
	return answers
end

const function settledWhenEmpty(world: World.World): () -> boolean
	return function(): boolean
		return world.players == 0
	end
end

Spec.test("an empty server with nothing to send is left after the quiet two seconds", function()
	const world, _, pipe = setup()
	world.players = 0
	pipe.drain(settledWhenEmpty(world))
	Spec.equal(world.waits, repeated(0.25, 8), "eight looks a quarter second apart")
	Spec.equal(#world.posts, 0, "nothing to post")
end)

Spec.test("with players still on and nothing to send the drain stops at its budget", function()
	const world, _, pipe = setup()
	pipe.drain(settledWhenEmpty(world))
	Spec.equal(total(world.waits), 20, "twenty seconds, the whole budget")
	Spec.equal(#world.waits, 80, "looking every quarter second")
	Spec.equal(#world.posts, 0, "nothing to post")
end)

Spec.test("an ingest that refuses everything costs the budget and no more", function()
	const world, ring, pipe = setup()
	world.players = 0
	world.answers = refusals(50)
	ring.emit("leave", "u_a", {})
	pipe.drain(settledWhenEmpty(world))
	Spec.equal(world.waits, repeated(2, 10), "a retry every two seconds for twenty")
	Spec.equal(#world.posts, 10, "ten posts")

	const short, shortRing, shortPipe = setup(function(settings: Pipe.Config)
		settings.closeBudget = 6
	end)
	short.answers = refusals(50)
	shortRing.emit("leave", "u_a", {})
	shortPipe.drain(settledWhenEmpty(short))
	Spec.equal(short.waits, repeated(2, 3), "a budget of six is three tries")
	Spec.equal(#short.posts, 3, "three posts")
end)

Spec.test("a refused post is tried again instead of giving the tail up", function()
	const world, ring, pipe = setup()
	world.players = 0
	world.answers = { 503 }
	ring.emit("leave", "u_a", { seconds = 10 })
	pipe.drain(settledWhenEmpty(world))
	Spec.equal(#world.posts, 2, "two posts")
	Spec.equal(world.posts[2].envelope.events, world.posts[1].envelope.events, "the same batch")
	Spec.equal(world.waits[1], 2, "two seconds before the retry")
	Spec.equal(#world.waits, 9, "then the quiet two seconds")
	Spec.equal(pipe.backlog(), 0, "sent")
	Spec.equal(ring.dropped(), 0, "nothing lost")
	Spec.equal(world.warnings[1].id, "telemetry.send_retry", "said in the log")
end)

Spec.test("rows the leaving players write during the drain are sent too", function()
	const world, ring, pipe = setup()
	ring.emit("feed", "u_a", {})
	world.onWait = function()
		-- The last player's rows land half a second in, when the ring was already emptied once.
		if #world.waits == 2 then
			ring.emit("leave", "u_a", { seconds = 90 })
			world.players = 0
		end
	end
	pipe.drain(settledWhenEmpty(world))
	Spec.equal(#world.posts, 2, "two posts")
	Spec.equal(world.names(1), "feed", "what waited at the close")
	Spec.equal(world.names(2), "leave", "what was written during it")
	Spec.equal(total(world.waits), 2.5, "half a second of players, then the quiet two")
	Spec.equal(pipe.backlog(), 0, "sent")
end)

Spec.test("a row that arrives in the quiet starts the quiet again", function()
	const world, ring, pipe = setup()
	world.players = 0
	world.onWait = function()
		if #world.waits == 4 then
			ring.emit("leave", "u_a", {})
		end
	end
	pipe.drain(settledWhenEmpty(world))
	Spec.equal(#world.posts, 1, "the late row was sent")
	Spec.equal(world.waits, repeated(0.25, 12), "one second, then two whole quiet seconds more")
end)

Spec.test("a player seen again in the quiet starts the quiet again", function()
	const world, _, pipe = setup()
	world.players = 0
	world.onWait = function()
		if #world.waits == 4 then
			world.players = 1
		elseif #world.waits == 6 then
			world.players = 0
		end
	end
	pipe.drain(settledWhenEmpty(world))
	Spec.equal(world.waits, repeated(0.25, 14), "one second, half a second of a player, two quiet seconds")
end)

Spec.test("the quiet is as long as the game says", function()
	const world, _, pipe = setup(function(settings: Pipe.Config)
		settings.closeQuiet = 0.5
	end)
	world.players = 0
	pipe.drain(settledWhenEmpty(world))
	Spec.equal(world.waits, repeated(0.25, 2), "half a second")
end)

Spec.test("with no destination the drain returns at once", function()
	const world, ring, pipe = setup(function(settings: Pipe.Config)
		settings.destination = ""
	end)
	ring.emit("leave", "u_a", {})
	pipe.drain(settledWhenEmpty(world))
	Spec.equal(world.waits, {}, "no wait")
	Spec.equal(#world.posts, 0, "no post")
	Spec.equal(ring.size(), 1, "the row is still readable")
end)

return nil
