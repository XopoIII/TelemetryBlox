--!strict
--- TelemetryBlox: the server's telemetry pipe. One call writes a row; the rows wait in a ring and
--- leave in batches for the game's own ingest (the Worker in `worker/`).
---
--- THE RULE, which is what makes `emit` safe to call inline anywhere: it returns at once, it never
--- yields and it cannot raise, whatever it is given. Nothing wraps gameplay in a pcall for its sake
--- or waits for a row to land.
---
--- THE EVENT NAME IS A TYPE. A game declares its vocabulary as a union of string literals and makes
--- its telemetry with that type; a name outside the union then does not compile:
---
---     export type EventName = "join" | "purchase" | "server_error" | "telemetry_drop"
---     const options: TelemetryBlox.Options<EventName> = { ... }
---     const telemetry: TelemetryBlox.Telemetry<EventName> = TelemetryBlox.new(options)
---     telemetry.emit("purchase", player, { robux = 25 })
---
--- NO PLAYER ID LEAVES THE SERVER. A row about a player carries a salted pseudonym, made here before
--- the row exists (`Anon`); the library never reads a player's name.
---
--- The library holds nothing of a game: the endpoint, the secret's name, the tag, the salt and every
--- event name are options, passed once. See `Options`.
const Analytics = require("@self/Analytics")
const AnalyticsOptions = require("@self/AnalyticsOptions")
const Anon = require("@self/Anon")
const Budget = require("@self/Budget")
const Calls = require("@self/Calls")
const Clean = require("@self/Clean")
const ErrorReporter = require("@self/ErrorReporter")
const Options = require("@self/Options")
const Pipe = require("@self/Pipe")
const Ring = require("@self/Ring")
const RobloxServices = require("@self/RobloxServices")
const Services = require("@self/Services")

const TelemetryBlox = {}

TelemetryBlox.Analytics = Analytics
TelemetryBlox.AnalyticsOptions = AnalyticsOptions
TelemetryBlox.Anon = Anon
TelemetryBlox.Budget = Budget
TelemetryBlox.Calls = Calls
TelemetryBlox.Clean = Clean
TelemetryBlox.ErrorReporter = ErrorReporter
TelemetryBlox.Options = Options
TelemetryBlox.Pipe = Pipe
TelemetryBlox.Ring = Ring
TelemetryBlox.RobloxServices = RobloxServices

export type Context = Ring.Context
export type Priority = Ring.Priority
export type Row = Ring.Row
export type Options<Name> = Options.Options<Name>
export type Services = Services.Services
export type Response = Services.Response
export type Server = Services.Server
export type HeaderValue = Services.HeaderValue
export type Anonymiser = Anon.Anonymiser
export type ErrorReport = ErrorReporter.Report
export type AnalyticsOptions<Name> = AnalyticsOptions.Options<Name>
export type AnalyticsCall = Calls.Call
export type AnalyticsFields = Calls.Fields
export type AnalyticsSink = Calls.Sink

--> Roblox's own analytics, as a game holds it (`Telemetry.analytics`).
export type Analytics = {
	--> Makes `calls` for `player` that are not a row's: a fact the game has that it writes no row of.
	tell: (player: Player, calls: { AnalyticsCall }) -> (),
	--> Forgets what this visit of `player` was told, as the leave event does.
	forget: (player: Player) -> (),
	--> Calls the budget refused, and calls Roblox could not take, not yet reported.
	dropped: () -> number,
	invalid: () -> number,
	--> Stops hearing rows. A call made after it does nothing.
	stop: () -> (),
}

--> Hears every row as it is written: its name, its player and the context the row keeps.
export type Listener<Name> = (name: Name, player: Player?, context: Context) -> ()

export type Telemetry<Name> = {
	--> Writes one row. `player` is nil for a row about no player. Returns at once, never yields and
	--> cannot raise: a call it can make nothing of is counted as refused and said in the drop report.
	emit: (name: Name, player: Player?, context: Context?) -> (),
	--> Hears every row as it is written. A listener must not yield, since `emit` does not; one that
	--> raises costs itself, never the caller. Returns the function that stops it.
	onEmit: (listener: Listener<Name>) -> () -> (),
	--> The pseudonym a player's rows carry, for a row that names a player who is not on this server.
	actorOf: (userId: number) -> string,
	--> A copy of the newest `count` rows still waiting (all by default), oldest first.
	recent: (count: number?) -> { Row },
	--> Rows lost since the last drop report.
	drops: () -> number,
	--> Rows waiting to leave.
	backlog: () -> number,
	--> Starts the flusher and binds the shutdown drain. A second call does nothing.
	start: () -> (),
	--> Reports every server error as a row of `event`, deduplicated by message (`ErrorReporter`):
	--> `message`, `script`, `trace`, `count`. Each reported one is also said to `log` under the
	--> event's name: the row answers "is this happening across servers", the log line answers "what
	--> happened in this one". Call it first, before anything that could raise: the errors of a world
	--> being built matter most. Raises when `event` is not in the vocabulary.
	captureErrors: (event: Name) -> (),
	--> Posts one batch now. Yields. True when the ingest took it.
	flush: () -> boolean,
	--> The shutdown drain, which `start` binds to the server's close. Yields.
	drain: () -> (),
	--> Where batches go; empty when this server only collects (Studio, or no endpoint).
	destination: string,
	--> Tells Roblox's own analytics what every row about a player means, as `options.map` says
	--> (`AnalyticsOptions`). `sink` is for a spec; a game passes none and gets `AnalyticsService`,
	--> and Studio tells nobody. Raises when an option is wrong, or on a second call.
	analytics: (options: AnalyticsOptions<Name>, sink: AnalyticsSink?) -> Analytics,
}

--> Makes a game's telemetry. `services` is for specs; a game passes none and gets the engine's.
--> Raises when an option is wrong, so a mistake is an error at boot.
-->
--> THE GAME'S TWO ANNOTATIONS CARRY THE VOCABULARY: `Options<EventName>` on what is passed in and
--> `Telemetry<EventName>` on what comes out. The function itself is written over `any` name, because
--> the old type solver widens a union of string literals to `string` when it infers a generic, and
--> a game may still be checked with it. Without the annotation on the result, names are unchecked.
function TelemetryBlox.new(options: Options<any>, services: Services?): Telemetry<any>
	const engine = services or RobloxServices.build()
	const resolved = Options.resolve(options, engine.isStudio())
	const world = table.clone(engine)
	world.warn = options.log or engine.warn

	const anon = Anon.new(resolved.salt)
	const ring = Ring.new({
		size = resolved.ringSize,
		protectedSize = resolved.protectedSize,
		priorities = resolved.priorities,
		now = world.now,
	})
	const pipe = Pipe.new(resolved.pipe, ring, world)
	const listeners: { Listener<any> } = {}

	-- The whole of a row's making. It may raise on an argument of the wrong kind (a number where a
	-- player belongs); `emit` catches that. False: the call is refused.
	const function record(name: any, player: any, context: any): boolean
		if type(name) ~= "string" or resolved.priorities[name] == nil then
			return false
		end
		if context ~= nil and type(context) ~= "table" then
			return false
		end
		local actor: string? = nil
		if player ~= nil then
			const userId = player.UserId
			if type(userId) ~= "number" then
				return false
			end
			actor = anon.token(tostring(userId))
		end
		const kept = Clean.context(context, resolved.clean)
		ring.emit(name, actor, kept)
		for _, listener in listeners do
			const ok, problem = pcall(listener, name, player, kept)
			if not ok then
				world.warn("telemetry.listener", { event = name, err = tostring(problem) })
			end
		end
		return true
	end

	const self = {} :: Telemetry<any>
	self.destination = resolved.pipe.destination

	-- Total: whatever `record` makes of its arguments, the caller hears nothing of it.
	const function write(name: any, player: any, context: any)
		const ok, taken = pcall(record, name, player, context)
		if not ok or taken ~= true then
			ring.refuse()
		end
	end

	function self.emit(name: any, player: Player?, context: Context?)
		write(name, player, context)
	end

	function self.onEmit(listener: Listener<any>): () -> ()
		table.insert(listeners, listener)
		return function()
			const index = table.find(listeners, listener)
			if index then
				table.remove(listeners, index)
			end
		end
	end

	function self.actorOf(userId: number): string
		return anon.token(tostring(userId))
	end

	function self.recent(count: number?): { Row }
		return ring.recent(count)
	end

	function self.drops(): number
		return ring.dropped()
	end

	function self.backlog(): number
		return pipe.backlog()
	end

	function self.flush(): boolean
		pipe.reportDrops()
		return pipe.flushOnce()
	end

	local told: Analytics.Analytics? = nil

	function self.analytics(given: AnalyticsOptions<any>, sink: AnalyticsSink?): Analytics
		if told then
			error("TelemetryBlox: analytics is already being told", 0)
		end
		const settings = AnalyticsOptions.resolve(given, resolved.priorities)
		const nowhere: AnalyticsSink = function() end
		local runs = 0
		const made = Analytics.new({
			options = settings,
			sink = sink or (if engine.isStudio() then nil else engine.analytics) or nowhere,
			clock = world.clock,
			players = world.playerCount,
			newId = function(): string
				runs += 1
				return `{world.server().jobId}-{runs}`
			end,
			warn = world.warn,
			report = function(dropped: number, invalid: number)
				if settings.dropEvent then
					write(settings.dropEvent, nil, { dropped = dropped, invalid = invalid })
				end
			end,
		})
		told = made
		const unhook = self.onEmit(made.handle)
		return {
			tell = made.tell,
			forget = made.forget,
			dropped = made.dropped,
			invalid = made.invalid,
			stop = function()
				made.stop()
				unhook()
			end,
		}
	end

	function self.drain()
		-- What analytics lost goes first, so the drain carries it.
		const telling = told
		if telling then
			telling.report(true)
		end
		-- It outlasts the players' own last rows: it ends once nobody is left and nothing more came.
		pipe.drain(function(): boolean
			return world.playerCount() == 0
		end)
	end

	local started = false
	function self.start()
		if started then
			return
		end
		started = true
		world.spawn(pipe.run)
		world.onClose(self.drain)
	end

	local capturing = false
	function self.captureErrors(event: any)
		if type(event) ~= "string" or resolved.priorities[event] == nil then
			error(`TelemetryBlox: the error event {tostring(event)} is not in \`events\``, 0)
		end
		if capturing then
			return
		end
		capturing = true
		const reporter = ErrorReporter.new({
			emit = function(report: ErrorReporter.Report)
				world.warn(event, { script = report.script, message = report.message, count = report.count })
				write(event, nil, report)
			end,
		})
		world.onError(reporter.report)
	end

	return self
end

return TelemetryBlox
