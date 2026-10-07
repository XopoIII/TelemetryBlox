--!strict
--- The front door's moving parts: the flusher and the drain `start` sets going, captured server
--- errors, and where a failed post is said.
const Example = require("@fakes/Example")
const Spec = require("../Spec")
const TelemetryBlox = require("@telemetryblox")
const World = require("@fakes/World")

type EventName = Example.EventName

const make, player = Example.make, Example.player

Spec.test("start spawns one flusher and binds one drain, however often it is called", function()
	const world = World.new()
	const telemetry = make(world)
	Spec.equal({ #world.spawned, #world.closers }, { 0, 0 }, "making it starts nothing")
	telemetry.start()
	telemetry.start()
	Spec.equal(
		{ #world.spawned, #world.closers, #world.errorHandlers },
		{ 1, 1, 0 },
		"once, and no error capture unasked"
	)

	-- The close handler is the drain: it sends what waits and ends once the server is empty.
	telemetry.emit("feed", player(), {})
	world.players = 0
	world.closers[1]()
	Spec.equal(world.names(1), "feed", "the tail was sent")
	Spec.equal(#world.waits, 8, "then the quiet two seconds")
end)

Spec.test("the drain waits for the players to be gone", function()
	const world = World.new()
	const telemetry = make(world)
	world.onWait = function()
		if #world.waits == 4 then
			world.players = 0
		end
	end
	telemetry.drain()
	Spec.equal(#world.waits, 12, "a second of players, then the quiet two")
end)

Spec.test("a captured server error is an urgent row with its message, script, trace and count", function()
	const world = World.new()
	const telemetry = make(world)
	telemetry.captureErrors("server_error")
	telemetry.captureErrors("server_error")
	Spec.equal(#world.errorHandlers, 1, "captured once")
	for _ = 1, 4 do
		world.errorHandlers[1]("attempt to index nil", "Script:12\nScript:40", "Server.World")
	end
	Spec.equal(#telemetry.recent(), 3, "the fourth is quiet")
	-- Each reported one is said to the log as well, under the event's name: what happened on this server.
	Spec.equal(world.warnings, {
		{ id = "server_error", context = { script = "Server.World", message = "attempt to index nil", count = 1 } },
		{ id = "server_error", context = { script = "Server.World", message = "attempt to index nil", count = 2 } },
		{ id = "server_error", context = { script = "Server.World", message = "attempt to index nil", count = 3 } },
	}, "the log lines")
	Spec.equal(telemetry.recent()[1], {
		seq = 1,
		t = 1_800_000_000,
		event = "server_error",
		ctx = { message = "attempt to index nil", script = "Server.World", trace = "Script:12 | Script:40", count = 1 },
	}, "the row")
	-- Urgent: it leaves on the flusher's next wake.
	telemetry.start()
	world.onWait = function(_seconds: number): ()
		error("stop")
	end
	Spec.equal(pcall(world.spawned[1]), false, "one wake")
	Spec.equal(#world.posts, 0, "the wake that stopped posted nothing")
	world.onWait = function()
		if #world.waits == 3 then
			error("stop")
		end
	end
	pcall(world.spawned[1])
	Spec.equal(world.names(1), "server_error,server_error,server_error", "sent a minute later")
end)

Spec.test("an error event outside the vocabulary is an error at boot", function()
	const world = World.new()
	const telemetry = make(world)
	const capture: any = telemetry.captureErrors
	Spec.throws(function()
		capture("crashed")
	end, "the error event crashed is not in `events`")
	Spec.throws(function()
		capture(nil)
	end, "the error event nil is not in `events`")
	Spec.equal(#world.errorHandlers, 0, "nothing was captured")
end)

Spec.test("a flush says the refused calls in the batch it sends", function()
	const world = World.new()
	const telemetry = make(world)
	const emit: any = telemetry.emit
	emit("no_such_event")
	emit("feed", 5)
	telemetry.emit("feed")
	telemetry.flush()
	Spec.equal(world.names(1), "telemetry_drop,feed", "the drop row rides along, protected")
	Spec.equal(world.posts[1].envelope.events[1].ctx, {
		count = 2,
		overflow = 0,
		send_failed = 0,
		refused = 2,
	}, "the drop row")
	Spec.equal(telemetry.drops(), 0, "claimed")
end)

Spec.test("a failed post is said where the game asks, or to the engine's log by default", function()
	const said: { string } = {}
	const world = World.new()
	world.answers = { 503 }
	const telemetry = make(world, function(given: TelemetryBlox.Options<EventName>)
		given.log = function(id: string, context: { [string]: any })
			table.insert(said, `{id} {context.reason}`)
		end
	end)
	telemetry.emit("feed")
	telemetry.flush()
	Spec.equal(said, { "telemetry.send_retry http 503" }, "the game's logger")
	Spec.equal(world.warnings, {}, "and not the default one")

	const plain = World.new()
	plain.answers = { 503 }
	const unconfigured = make(plain)
	unconfigured.emit("feed")
	unconfigured.flush()
	Spec.equal(plain.warnings[1].id, "telemetry.send_retry", "the default log")
end)

Spec.test("a row's strings are cut at the limit the game set", function()
	const world = World.new()
	const telemetry = make(world, function(given: TelemetryBlox.Options<EventName>)
		given.maxStringBytes = 5000
		given.maxDepth = 2
	end)
	telemetry.captureErrors("server_error")
	world.errorHandlers[1](string.rep("e", 6000), "", "Server.World")
	telemetry.emit("feed", nil, { note = string.rep("n", 4000), deep = { deeper = { never = 1 }, at = 2 } })
	const rows = telemetry.recent()
	Spec.equal(#rows[1].ctx.message, 5000, "an error's message past the default thousand")
	Spec.equal(#rows[2].ctx.note, 4000, "a long string whole")
	Spec.equal(rows[2].ctx.deep, { at = 2 }, "and the depth")
end)

Spec.test("a wrong option is an error when the telemetry is made", function()
	const world = World.new()
	Spec.throws(function()
		make(world, function(given: TelemetryBlox.Options<EventName>)
			given.salt = ""
		end)
	end, "TelemetryBlox: `salt` must be a non-empty string")
end)

return nil
