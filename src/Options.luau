--!strict
--- What a game hands in, once, and what the library makes of it.
---
--- Everything that is the game's own is here and nowhere else in the library: where its ingest is,
--- what its key's secret is called, its tag, its vocabulary, its salt. `resolve` checks the options
--- when the game starts, loudly, so a mistake in them is an error at boot and never a silence in the
--- data; nothing after it can raise into the game.
const Pipe = require("./Pipe")
const Ring = require("./Ring")

const Options = {}

--> The defaults. The intervals are sized for an ingest on Cloudflare's free plan: a post every three
--> minutes is 480 requests a day per server, against 100,000.
Options.DEFAULTS = table.freeze({
	flushSeconds = 180,
	tickSeconds = 60,
	maxBatch = 1000,
	ringSize = 2000,
	protectedSize = 500,
	maxTries = 3,
	closeBudget = 20,
	closeQuiet = 2,
})

export type Options<Name> = {
	--> The game's tag, said in every batch; the ingest refuses a batch tagged for another game.
	game: string,
	--> The pseudonym's salt: this game's own, and never changed (see `Anon`).
	salt: string,
	--> The name of the experience secret that holds the ingest key (`HttpService:GetSecret`).
	secretName: string,
	--> The ingest's full URL (`https://<worker host>/ingest`). Nil or empty: collect, send nothing.
	endpoint: string?,
	--> The vocabulary: every event the game may write, and how each waits (see `Ring.Priority`).
	events: { [Name]: Ring.Priority },
	--> The event the pipe reports its own losses as. Protected unless `events` says urgent.
	dropEvent: Name,
	--> What a server outside Studio is called: "live" by default, "test" for a test place. Only a
	--> "live" batch raises an alert. Studio is always "studio".
	environment: string?,
	--> The place version to say; the server's own (`game.PlaceVersion`) by default.
	placeVersion: number?,
	--> Seconds between posts.
	flushSeconds: number?,
	--> Seconds between the flusher's wakes: how soon an urgent row leaves.
	tickSeconds: number?,
	--> Rows a post carries at most.
	maxBatch: number?,
	--> Rows the bulk ring holds.
	ringSize: number?,
	--> Rows the protected ring holds.
	protectedSize: number?,
	--> Posts a batch gets before it is counted lost.
	maxTries: number?,
	--> Seconds the shutdown drain may take.
	closeBudget: number?,
	--> Seconds the server must be empty and silent before the drain ends early.
	closeQuiet: number?,
	--> Where the pipe says a post failed. `warn` by default.
	log: ((id: string, context: { [string]: any }) -> ())?,
}

export type Resolved = {
	pipe: Pipe.Config,
	ringSize: number,
	protectedSize: number,
	priorities: { [string]: Ring.Priority },
	dropEvent: string,
	salt: string,
}

const PRIORITIES: { [string]: boolean } = { bulk = true, protected = true, urgent = true }

const function text(value: unknown, name: string): string
	if type(value) ~= "string" or value == "" then
		error(`TelemetryBlox: \`{name}\` must be a non-empty string`, 0)
	end
	return value
end

const function positive(value: unknown, fallback: number, name: string): number
	if value == nil then
		return fallback
	end
	if type(value) ~= "number" or value ~= value or value <= 0 or value == math.huge then
		error(`TelemetryBlox: \`{name}\` must be a positive number`, 0)
	end
	return value
end

--> Where batches go: nowhere in Studio, nowhere without an endpoint.
function Options.destination(endpoint: string?, isStudio: boolean): string
	if isStudio or endpoint == nil then
		return ""
	end
	return endpoint
end

--> What a batch calls its server. Studio is "studio" whatever the game says.
function Options.environment(environment: string?, isStudio: boolean): string
	if isStudio then
		return "studio"
	end
	return environment or "live"
end

--> Checks `options` and fills the defaults. Raises on the first one that is wrong.
function Options.resolve(options: Options<any>, isStudio: boolean): Resolved
	const environment = options.environment
	if environment ~= nil then
		if type(environment) ~= "string" or string.match(environment, "^%l[%l%d_-]*$") == nil or #environment > 16 then
			error("TelemetryBlox: `environment` must be a short lowercase word", 0)
		end
		if environment == "studio" then
			error('TelemetryBlox: `environment` cannot be "studio": Studio is told apart by the engine', 0)
		end
	end
	if options.endpoint ~= nil and type(options.endpoint) ~= "string" then
		error("TelemetryBlox: `endpoint` must be a string", 0)
	end
	if type(options.events) ~= "table" then
		error("TelemetryBlox: `events` must be a table of event names and their priorities", 0)
	end

	const priorities: { [string]: Ring.Priority } = {}
	for name, priority in options.events do
		if type(name) ~= "string" or PRIORITIES[priority] ~= true then
			error(`TelemetryBlox: \`events\` holds {tostring(name)} = {tostring(priority)}`, 0)
		end
		priorities[name] = priority
	end

	const dropEvent = text(options.dropEvent, "dropEvent")
	if priorities[dropEvent] == "bulk" then
		error("TelemetryBlox: the drop event cannot be bulk: the flood it reports would evict it", 0)
	end
	priorities[dropEvent] = priorities[dropEvent] or "protected"

	const defaults = Options.DEFAULTS
	return {
		pipe = {
			destination = Options.destination(options.endpoint, isStudio),
			secretName = text(options.secretName, "secretName"),
			game = text(options.game, "game"),
			env = Options.environment(environment, isStudio),
			placeVersion = options.placeVersion,
			dropEvent = dropEvent,
			maxBatch = positive(options.maxBatch, defaults.maxBatch, "maxBatch"),
			flushSeconds = positive(options.flushSeconds, defaults.flushSeconds, "flushSeconds"),
			tickSeconds = positive(options.tickSeconds, defaults.tickSeconds, "tickSeconds"),
			maxTries = positive(options.maxTries, defaults.maxTries, "maxTries"),
			closeBudget = positive(options.closeBudget, defaults.closeBudget, "closeBudget"),
			closeQuiet = positive(options.closeQuiet, defaults.closeQuiet, "closeQuiet"),
		},
		ringSize = positive(options.ringSize, defaults.ringSize, "ringSize"),
		protectedSize = positive(options.protectedSize, defaults.protectedSize, "protectedSize"),
		priorities = priorities,
		dropEvent = dropEvent,
		salt = text(options.salt, "salt"),
	}
end

return Options
