--!strict
--- The front door: `emit` is total, no player id leaves the server, and Studio never sends.
const Example = require("@fakes/Example")
const Spec = require("../Spec")
const TelemetryBlox = require("@telemetryblox")
const World = require("@fakes/World")

type EventName = Example.EventName

const ENDPOINT, ACTOR = Example.ENDPOINT, Example.ACTOR
const make, player = Example.make, Example.player

Spec.test("a row about a player carries their pseudonym, and a row about nobody carries none", function()
	const world = World.new()
	const telemetry = make(world)
	telemetry.emit("join", player(), { locale = "en-us" })
	telemetry.emit("feed", nil, { pieces = 3 })
	telemetry.emit("feed")
	Spec.equal(telemetry.recent(), {
		{ seq = 1, t = 1_800_000_000, event = "join", actor = ACTOR, ctx = { locale = "en-us" } },
		{ seq = 2, t = 1_800_000_000, event = "feed", ctx = { pieces = 3 } },
		{ seq = 3, t = 1_800_000_000, event = "feed", ctx = {} },
	}, "rows")
	Spec.equal(telemetry.actorOf(123456789), ACTOR, "the same pseudonym, asked for by id")
	Spec.equal(telemetry.actorOf(123456788) ~= ACTOR, true, "another player, another pseudonym")
	Spec.equal(telemetry.drops(), 0, "nothing refused")
end)

Spec.test("what leaves the server holds no user id and no name", function()
	const world = World.new()
	const telemetry = make(world)
	telemetry.emit("join", player(), { locale = "en-us" })
	telemetry.emit("purchase", player(), { robux = 25 })
	Spec.equal(telemetry.flush(), true, "posted")
	const body = world.posts[1].body
	Spec.equal(string.find(body, "123456789", 1, true), nil, "no user id")
	Spec.equal(string.find(body, "Builderman", 1, true), nil, "no name")
	Spec.equal(string.find(body, "TheBuilder", 1, true), nil, "no display name")
	Spec.equal(select(2, string.gsub(body, ACTOR, "")), 2, "the pseudonym, once a row")
	-- The envelope names the server and never a player.
	const envelope = world.posts[1].envelope
	envelope.events = nil
	Spec.equal(envelope, {
		schemaVersion = 1,
		game = "example",
		universeId = "111",
		placeId = "222",
		placeVersion = 7,
		jobId = "job-a",
		env = "live",
		serverStart = 1_800_000_000,
		sentAt = 1_800_000_000,
	}, "envelope")

	-- The negative case, so the check above is seen to bite: a context is the game's own, and an id
	-- the game writes into one by hand does leave.
	telemetry.emit("feed", nil, { leak = 123456789 })
	telemetry.flush()
	Spec.truthy(string.find(world.posts[2].body, "123456789", 1, true) ~= nil, "a hand-written id is found")
end)

Spec.test("emit never raises and never yields, whatever it is given", function()
	const world = World.new()
	const telemetry = make(world)
	const emit: any = telemetry.emit
	const nothing: any = nil
	const names: { any } = { 5, true, {}, function() end, "", "no_such_event", 0 / 0, "feed" }
	const players: { any } =
		{ 5, "player", true, {}, { UserId = "abc" }, function() end, coroutine.create(function() end) }
	const contexts: { any } = { 5, "context", true, function() end }
	local calls, refused = 0, 0
	const function try(name: any, who: any, context: any, taken: boolean)
		const thread = coroutine.create(emit)
		const ok = coroutine.resume(thread, name, who, context)
		Spec.equal(ok, true, "emit raised")
		Spec.equal(coroutine.status(thread), "dead", "emit yielded")
		calls += 1
		if not taken then
			refused += 1
		end
	end
	try(nothing, nothing, nothing, false)
	for _, name in names do
		try(name, nothing, nothing, name == "feed")
		for _, who in players do
			try(name, who, nothing, false)
			for _, context in contexts do
				try(name, who, context, false)
			end
		end
	end
	for _, context in contexts do
		try("feed", nothing, context, false)
	end
	Spec.equal(calls, 293, "every combination was tried")
	Spec.equal(refused, 292, "all but the one good call")
	Spec.equal(telemetry.drops(), 292, "each refusal is counted")
	Spec.equal(#telemetry.recent(), 1, "and the good call is a row")
end)

Spec.test("a context with values no batch can carry still makes its row, without them", function()
	const world = World.new()
	const telemetry = make(world)
	const context: { [any]: any } = { coins = 5, nan = 0 / 0, fn = function() end, [1] = "x" }
	telemetry.emit("feed", nil, context)
	Spec.equal(telemetry.recent()[1].ctx, { coins = 5 }, "the row, cleaned")
	Spec.equal(telemetry.drops(), 0, "it was not refused")
end)

Spec.test("a listener hears every row written, and only those", function()
	const world = World.new()
	const telemetry = make(world)
	const heard: { any } = {}
	const stop = telemetry.onEmit(function(name: EventName, who: Player?, context: TelemetryBlox.Context)
		table.insert(heard, { name = name, who = who, context = context })
	end)
	const builder = player()
	telemetry.emit("purchase", builder, { robux = 25 })
	const refuse: any = telemetry.emit
	refuse("no_such_event", nil, {})
	Spec.equal(#heard, 1, "a refused call is not a row")
	Spec.equal(heard[1].name, "purchase", "name")
	Spec.equal(heard[1].who == builder, true, "the player, as given")
	Spec.equal(heard[1].context, { robux = 25 }, "context")
	stop()
	telemetry.emit("feed")
	Spec.equal(#heard, 1, "stopped")
	stop()
	Spec.equal(#telemetry.recent(), 2, "both rows were written")
end)

Spec.test("a listener that raises costs itself, never the caller or the other listeners", function()
	const world = World.new()
	const telemetry = make(world)
	local heard = 0
	telemetry.onEmit(function()
		error("listener broke")
	end)
	telemetry.onEmit(function()
		heard += 1
	end)
	telemetry.emit("feed")
	Spec.equal(heard, 1, "the second listener still heard")
	Spec.equal(#telemetry.recent(), 1, "the row was written")
	Spec.equal(telemetry.drops(), 0, "and not counted refused")
	Spec.equal(world.warnings[1].id, "telemetry.listener", "said in the log")
	Spec.equal(world.warnings[1].context.event, "feed", "with the event")
end)

Spec.test("Studio collects and never sends; a live server with the same options sends", function()
	const studio = World.new()
	studio.studio = true
	studio.players = 0
	const inStudio = make(studio)
	inStudio.emit("purchase", player(), { robux = 25 })
	Spec.equal(inStudio.destination, "", "no destination")
	Spec.equal(inStudio.flush(), false, "a flush sends nothing")
	inStudio.drain()
	inStudio.start()
	studio.closers[1]()
	Spec.equal(#studio.posts, 0, "nothing left the server")
	Spec.equal(studio.waits, {}, "and the close waited for nothing")
	Spec.equal(#inStudio.recent(), 1, "the row is still read back")

	const live = World.new()
	const onServer = make(live)
	onServer.emit("purchase", player(), { robux = 25 })
	Spec.equal(onServer.destination, ENDPOINT, "the endpoint")
	Spec.equal(onServer.flush(), true, "sent")
	Spec.equal(live.posts[1].url, ENDPOINT, "to the endpoint")
	Spec.equal(#onServer.recent(), 0, "and no longer waiting")
end)

Spec.test("a live server with no endpoint only collects", function()
	const world = World.new()
	const telemetry = make(world, function(given: TelemetryBlox.Options<EventName>)
		given.endpoint = nil
	end)
	telemetry.emit("feed")
	Spec.equal(telemetry.destination, "", "no destination")
	Spec.equal(telemetry.flush(), false, "nothing sent")
	Spec.equal(#world.posts, 0, "no post")
	Spec.equal(telemetry.backlog(), 1, "the row waits")
end)

Spec.test("a test place is said as the game names it, and a live server as live", function()
	const world = World.new()
	const telemetry = make(world, function(given: TelemetryBlox.Options<EventName>)
		given.environment = "test"
		given.placeVersion = 31
	end)
	telemetry.emit("feed")
	telemetry.flush()
	Spec.equal({ world.posts[1].envelope.env, world.posts[1].envelope.placeVersion }, { "test", 31 }, "as named")
end)

return nil
