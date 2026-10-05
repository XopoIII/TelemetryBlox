--!strict
--- A game's use of the whole public API, as the README shows it. It is checked by the type gate
--- under both solvers (`scripts/type-check.sh`) and is NOT run: it needs a Roblox server.
---
--- When the API changes, this file changes with it, and the README's example after it.
--- `Misuse.luau` beside it holds what must NOT compile.
const TelemetryBlox = require("@telemetryblox")

const Players = game:GetService("Players")

-- The vocabulary is the game's own: a union of string literals, and nothing is written outside it.
export type EventName = "join" | "leave" | "feed" | "purchase" | "save_failed" | "server_error" | "telemetry_drop"

const options: TelemetryBlox.Options<EventName> = {
	game = "example",
	-- This game's own, and never changed: changing it makes every player a new one in the data.
	salt = "example/telemetry/actor/v1:00000000",
	endpoint = "https://example-telemetry.example.workers.dev/ingest",
	secretName = "ExampleTelemetryKey",
	-- How each event waits. A name outside the union does not compile here either.
	events = {
		join = "protected",
		leave = "protected",
		feed = "bulk",
		purchase = "urgent",
		save_failed = "urgent",
		server_error = "urgent",
		telemetry_drop = "protected",
	},
	dropEvent = "telemetry_drop",
	-- Everything below is optional; these are the defaults, but for the environment's name.
	environment = if game.PlaceId == 1 then "test" else "live",
	placeVersion = game.PlaceVersion,
	flushSeconds = 180,
	tickSeconds = 60,
	maxBatch = 1000,
	ringSize = 2000,
	protectedSize = 500,
	maxTries = 3,
	closeBudget = 20,
	closeQuiet = 2,
	log = function(id: string, context: { [string]: any })
		warn(id, context)
	end,
}

const telemetry: TelemetryBlox.Telemetry<EventName> = TelemetryBlox.new(options)

-- First, before anything that could raise: the errors of a world being built matter most.
telemetry.captureErrors("server_error")
telemetry.start()

Players.PlayerAdded:Connect(function(player: Player)
	telemetry.emit("join", player, { locale = player.LocaleId })
end)
Players.PlayerRemoving:Connect(function(player: Player)
	telemetry.emit("leave", player)
end)

-- A row about no player, and a row that names a player who is not on this server by pseudonym.
telemetry.emit("feed", nil, { food = "leaf", pieces = 12 })
telemetry.emit("save_failed", nil, { what = "load", owner = telemetry.actorOf(123456789) })

-- A second sink hears every row as it is written (Roblox's own analytics, say).
const stop: () -> () = telemetry.onEmit(function(name: EventName, player: Player?, context: TelemetryBlox.Context)
	if name == "purchase" and player then
		print(player.UserId, context.robux)
	end
end)
stop()

-- Read back, for a Studio check or a spec in the game.
const rows: { TelemetryBlox.Row } = telemetry.recent(10)
for _, row in rows do
	const _seq: number, _t: number, _event: string, _actor: string? = row.seq, row.t, row.event, row.actor
	const _ctx: TelemetryBlox.Context = row.ctx
end
const _lost: number = telemetry.drops()
const _waiting: number = telemetry.backlog()
const _collecting: boolean = telemetry.destination == ""

-- By hand: one post now, and the drain `start` already bound to the server's close.
task.spawn(function()
	const _took: boolean = telemetry.flush()
	telemetry.drain()
end)

-- The parts, for a game that builds its own front door or puts a rule in a spec.
const anon: TelemetryBlox.Anonymiser = TelemetryBlox.Anon.new("example/telemetry/actor/v1:00000000")
const _token: string = anon.token("123456789")
const _kept: TelemetryBlox.Context = TelemetryBlox.Clean.context({ coins = 5, part = workspace })
const _reported: boolean = TelemetryBlox.ErrorReporter.shouldReport(10, 3)
const _where: string = TelemetryBlox.Options.destination(options.endpoint, false)
const _priority: TelemetryBlox.Priority = "urgent"

-- A game's own services, for its specs: the engine's, with a clock of its own.
const services: TelemetryBlox.Services = TelemetryBlox.RobloxServices.build()
const offline: TelemetryBlox.Telemetry<EventName> = TelemetryBlox.new(options, services)
offline.emit("feed")
