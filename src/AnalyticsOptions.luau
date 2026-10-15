--!strict
--- What a game hands in for Roblox's own analytics, once, and what the library makes of it. As with
--- `Options`, a mistake is an error at boot and never a silence in the dashboards.
const Calls = require("./Calls")
const Ring = require("./Ring")

const AnalyticsOptions = {}

--> Half of what Roblox allows a server (120 calls a minute and 20 more a player), by default.
AnalyticsOptions.LIMIT = 60
AnalyticsOptions.PER_PLAYER = 10
--> What Roblox allows; a budget past it would only lose calls at Roblox's end.
AnalyticsOptions.ROBLOX_LIMIT = 120
AnalyticsOptions.ROBLOX_PER_PLAYER = 20
--> Steps a Roblox funnel has at most.
AnalyticsOptions.MAX_ONBOARDING = Calls.MAX_STEP

export type Options<Name> = {
	--> What a row of this player is told as: the calls, in order, or nil for none. It must not
	--> yield; one that raises costs its own row and is counted as invalid.
	map: (name: Name, player: Player, context: Ring.Context) -> { Calls.Call }?,
	--> The fields every call of this player carries unless the call says its own.
	fields: ((player: Player) -> Calls.Fields)?,
	--> The onboarding funnel's steps, in order. FROZEN once a build with them is published:
	--> Roblox keys a step by its number, so a step is only ever added at the end.
	onboarding: { string }?,
	--> The row a player's visit ends with: once its calls are made, the player is forgotten.
	leaveEvent: Name?,
	--> The row the calls lost and refused are reported as, once a minute at most and in the
	--> shutdown drain: `dropped` (past the budget) and `invalid` (no call Roblox could take).
	dropEvent: Name?,
	--> Calls in any sixty seconds, and how many more for each player on the server.
	limit: number?,
	perPlayer: number?,
}

export type Resolved = {
	map: (name: any, player: Player, context: Ring.Context) -> { Calls.Call }?,
	fields: ((player: Player) -> Calls.Fields)?,
	--> Each onboarding step's number, by its name.
	steps: { [string]: number },
	leaveEvent: string?,
	dropEvent: string?,
	limit: number,
	perPlayer: number,
}

const function count(value: unknown, fallback: number, least: number, most: number, name: string): number
	if value == nil then
		return fallback
	end
	if type(value) ~= "number" or value % 1 ~= 0 or value < least or value > most then
		error(`TelemetryBlox: analytics \`{name}\` must be a whole number from {least} to {most}`, 0)
	end
	return value
end

const function event(value: unknown, priorities: { [string]: Ring.Priority }, name: string): string?
	if value == nil then
		return nil
	end
	if type(value) ~= "string" or priorities[value] == nil then
		error(`TelemetryBlox: analytics \`{name}\` {tostring(value)} is not in \`events\``, 0)
	end
	return value
end

--> Each step's number, by its name: a list of distinct non-empty names, 100 at most.
const function steps(value: { string }?): { [string]: number }
	const found: { [string]: number } = {}
	if value == nil then
		return found
	end
	if type(value) ~= "table" then
		error("TelemetryBlox: analytics `onboarding` must be a list of step names", 0)
	end
	const length = #value
	for key in value do
		if type(key) ~= "number" or key < 1 or key > length or key % 1 ~= 0 then
			error("TelemetryBlox: analytics `onboarding` must be a list of step names", 0)
		end
	end
	if length > AnalyticsOptions.MAX_ONBOARDING then
		error(`TelemetryBlox: analytics \`onboarding\` has more than {AnalyticsOptions.MAX_ONBOARDING} steps`, 0)
	end
	for index = 1, length do
		const name = value[index]
		if type(name) ~= "string" or name == "" then
			error(`TelemetryBlox: analytics onboarding step {index} must be a non-empty string`, 0)
		end
		if found[name] then
			error(`TelemetryBlox: analytics onboarding step {name} is listed twice`, 0)
		end
		found[name] = index
	end
	return found
end

--> Checks `options` against the vocabulary's `priorities` and fills the defaults.
function AnalyticsOptions.resolve(options: Options<any>, priorities: { [string]: Ring.Priority }): Resolved
	if type(options) ~= "table" then
		error("TelemetryBlox: the analytics options must be a table", 0)
	end
	if type(options.map) ~= "function" then
		error("TelemetryBlox: analytics `map` must be a function", 0)
	end
	if options.fields ~= nil and type(options.fields) ~= "function" then
		error("TelemetryBlox: analytics `fields` must be a function", 0)
	end
	const dropEvent = event(options.dropEvent, priorities, "dropEvent")
	-- the flood of calls it reports comes with a flood of rows, which would evict a bulk one
	if dropEvent and priorities[dropEvent] == "bulk" then
		error("TelemetryBlox: the analytics drop event cannot be bulk", 0)
	end
	return {
		map = options.map,
		fields = options.fields,
		steps = steps(options.onboarding),
		leaveEvent = event(options.leaveEvent, priorities, "leaveEvent"),
		dropEvent = dropEvent,
		limit = count(options.limit, AnalyticsOptions.LIMIT, 1, AnalyticsOptions.ROBLOX_LIMIT, "limit"),
		perPlayer = count(
			options.perPlayer,
			AnalyticsOptions.PER_PLAYER,
			0,
			AnalyticsOptions.ROBLOX_PER_PLAYER,
			"perPlayer"
		),
	}
end

return AnalyticsOptions
