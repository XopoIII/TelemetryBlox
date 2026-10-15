--!strict
--- An analytics core the specs can hold: a sink that writes every call down, a clock and players
--- they move, and a map that tells a row's context's `calls`.
const Analytics = require("@telemetryblox/Analytics")
const AnalyticsOptions = require("@telemetryblox/AnalyticsOptions")
const Calls = require("@telemetryblox/Calls")

const Told = {}

export type Options = AnalyticsOptions.Options<string>

export type Setup = {
	analytics: Analytics.Analytics,
	--> Every call the sink was handed, as `{ player, call }`.
	told: { { player: any, call: any } },
	reports: { { number } },
	warnings: { { id: string, context: { [string]: any } } },
	--> The clock and the players the analytics reads; a spec moves them.
	at: { clock: number, players: number },
}

Told.PRIORITIES = { row = "bulk", leave = "protected", lost = "protected", flood = "bulk" } :: { [string]: any }

--> Two players, as far as the analytics reads one: a key.
Told.ALICE = { UserId = 1 } :: any
Told.BOB = { UserId = 2 } :: any

--> An analytics core whose rows' calls are their context's `calls`, unless `change` says another map.
function Told.setup(change: ((Options) -> ())?): Setup
	const options: Options = {
		map = function(_name: string, _player: Player, context: { [string]: any }): { Calls.Call }?
			return context.calls
		end,
		onboarding = { "joined", "fed", "first_dawn" },
		leaveEvent = "leave",
		dropEvent = "lost",
	}
	if change then
		change(options)
	end
	const result = {
		told = {},
		reports = {},
		warnings = {},
		at = { clock = 100, players = 1 },
	} :: Setup
	local ids = 0
	result.analytics = Analytics.new({
		options = AnalyticsOptions.resolve(options, Told.PRIORITIES),
		sink = function(player: Player, call: Calls.Call)
			table.insert(result.told, { player = player, call = call })
		end,
		clock = function(): number
			return result.at.clock
		end,
		players = function(): number
			return result.at.players
		end,
		newId = function(): string
			ids += 1
			return `job-{ids}`
		end,
		warn = function(id: string, context: { [string]: any })
			table.insert(result.warnings, { id = id, context = context })
		end,
		report = function(dropped: number, invalid: number)
			table.insert(result.reports, { dropped, invalid })
		end,
	})
	return result
end

--> A row's context that carries `list` as its calls.
function Told.calls(list: { Calls.Call }): { [string]: any }
	return { calls = list }
end

--> The calls the sink of `run` was handed, in order.
function Told.made(run: Setup): { any }
	const out = {}
	for _, entry in run.told do
		table.insert(out, entry.call)
	end
	return out
end

return Told
