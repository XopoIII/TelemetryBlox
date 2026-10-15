--!strict
--- The front door of Roblox's analytics: it hears the rows a game writes, tells the engine's
--- analytics outside Studio and nobody in it, and writes what it lost into the stream.
const Calls = require("@telemetryblox/Calls")
const Spec = require("../Spec")
const TelemetryBlox = require("@telemetryblox")
const World = require("@fakes/World")

type EventName = "join" | "leave" | "feed" | "analytics_drop" | "telemetry_drop"

const PLAYER: any = { UserId = 123456789 }

const function make(world: World.World): TelemetryBlox.Telemetry<EventName>
	const options: TelemetryBlox.Options<EventName> = {
		game = "example",
		salt = "example/telemetry/actor/v1:00000000",
		secretName = "ExampleKey",
		endpoint = "https://ingest.test/ingest",
		events = { join = "protected", leave = "protected", feed = "bulk", analytics_drop = "protected" },
		dropEvent = "telemetry_drop",
	}
	const telemetry: TelemetryBlox.Telemetry<EventName> = TelemetryBlox.new(options, world.services)
	return telemetry
end

const function map(name: EventName, _player: Player, context: TelemetryBlox.Context): { TelemetryBlox.AnalyticsCall }?
	if name == "join" then
		return { Calls.onboarding("joined"), Calls.funnel("Shop", 1, "Opened") }
	elseif name == "feed" then
		return { Calls.custom("Fed", context.pieces) }
	end
	return nil
end

const function analyticsOptions(): TelemetryBlox.AnalyticsOptions<EventName>
	return {
		map = map,
		fields = function(): TelemetryBlox.AnalyticsFields
			return { [1] = "Desktop" }
		end,
		onboarding = { "joined" },
		leaveEvent = "leave",
		dropEvent = "analytics_drop",
		limit = 2,
		perPlayer = 1,
	}
end

const function recorder(): (TelemetryBlox.AnalyticsSink, { TelemetryBlox.AnalyticsCall })
	const calls: { TelemetryBlox.AnalyticsCall } = {}
	return function(_player: Player, call: TelemetryBlox.AnalyticsCall)
		table.insert(calls, call)
	end, calls
end

Spec.test("every row about a player is told as the game's map says, and a row about nobody is not", function()
	const world = World.new()
	const telemetry = make(world)
	const sink, calls = recorder()
	telemetry.analytics(analyticsOptions(), sink)
	telemetry.emit("join", PLAYER)
	telemetry.emit("feed", nil, { pieces = 3 })
	Spec.equal(calls, {
		{ kind = "onboarding", step = "joined", index = 1, fields = { "Desktop" } },
		{
			kind = "funnel",
			funnel = "Shop",
			step = 1,
			stepName = "Opened",
			session = "job-a-1",
			fields = { "Desktop" },
		},
	})
	-- the row itself is written as ever
	Spec.equal(#telemetry.recent(), 2, "both rows")
end)

Spec.test("the engine's analytics is told outside Studio, and nobody in it", function()
	const world = World.new()
	const sink, calls = recorder()
	world.services.analytics = sink
	make(world).analytics(analyticsOptions()).tell(PLAYER, { Calls.custom("Fed") })
	Spec.equal(#calls, 1, "a live server tells the engine")

	const studio = World.new()
	studio.studio = true
	const quiet, none = recorder()
	studio.services.analytics = quiet
	make(studio).analytics(analyticsOptions()).tell(PLAYER, { Calls.custom("Fed") })
	Spec.equal(#none, 0, "Studio tells nobody")

	const bare = World.new()
	make(bare).analytics(analyticsOptions()).tell(PLAYER, { Calls.custom("Fed") })
	Spec.equal(#bare.warnings, 0, "a bundle with no analytics tells nobody, quietly")
end)

Spec.test("the budget is widened by the players on the server", function()
	const world = World.new()
	world.players = 2
	const sink, calls = recorder()
	const analytics = make(world).analytics(analyticsOptions(), sink)
	for _ = 1, 5 do
		analytics.tell(PLAYER, { Calls.custom("Fed") })
	end
	Spec.equal({ #calls, analytics.dropped() }, { 4, 1 }, "two and one for each of two players")
end)

Spec.test("what analytics lost is a row of its drop event, once a minute and in the drain", function()
	const world = World.new()
	const telemetry = make(world)
	const sink = recorder()
	const analytics = telemetry.analytics(analyticsOptions(), sink)
	-- three a minute: two and one for the one player
	for _ = 1, 5 do
		analytics.tell(PLAYER, { Calls.custom("Fed") })
	end
	analytics.tell(PLAYER, { Calls.custom("") })
	Spec.equal(#telemetry.recent(), 0, "not within the minute")
	world.clock += 60
	analytics.tell(PLAYER, { Calls.custom("Fed") })
	const rows = telemetry.recent()
	Spec.equal(#rows, 1, "one row")
	Spec.equal({ rows[1].event, rows[1].actor, rows[1].ctx }, { "analytics_drop", nil, { dropped = 2, invalid = 1 } })

	analytics.tell(PLAYER, { Calls.custom("Fed"), Calls.custom("Fed"), Calls.custom("Fed") })
	telemetry.drain()
	Spec.equal(world.names(1), "analytics_drop,analytics_drop", "the drain carries the rest")
	Spec.equal(world.posts[1].envelope.events[2].ctx, { dropped = 1, invalid = 0 }, "what the drain found")
end)

Spec.test("analytics is begun once, with options that are right, and stops when asked", function()
	const world = World.new()
	const telemetry = make(world)
	const options = analyticsOptions()
	options.dropEvent = "feed"
	Spec.throws(function()
		telemetry.analytics(options)
	end, "the analytics drop event cannot be bulk")
	const sink, calls = recorder()
	const analytics = telemetry.analytics(analyticsOptions(), sink)
	Spec.throws(function()
		telemetry.analytics(analyticsOptions(), sink)
	end, "analytics is already being told")
	analytics.stop()
	telemetry.emit("join", PLAYER)
	analytics.tell(PLAYER, { Calls.custom("Fed") })
	Spec.equal(#calls, 0, "nothing after stop")
	Spec.equal(#telemetry.recent(), 1, "the row is written all the same")
end)

return nil
