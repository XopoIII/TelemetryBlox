--!strict
--- What a game hands in: the defaults, and a wrong option as an error at boot.
const Options = require("@telemetryblox/Options")
const Spec = require("../Spec")

type EventName = "feed" | "purchase" | "telemetry_drop"

const function options(): Options.Options<EventName>
	return {
		game = "example",
		salt = "example/telemetry/actor/v1:00000000",
		secretName = "ExampleKey",
		endpoint = "https://ingest.test/ingest",
		events = { feed = "bulk", purchase = "urgent" },
		dropEvent = "telemetry_drop",
	}
end

-- A wrong option cannot be written with the types in the way, so the specs go around them.
const function with(field: string, value: any): Options.Options<EventName>
	const changed: any = options()
	changed[field] = value
	return changed
end

Spec.test("the defaults are the pipe's documented numbers", function()
	const resolved = Options.resolve(options(), false)
	Spec.equal(resolved, {
		pipe = {
			destination = "https://ingest.test/ingest",
			secretName = "ExampleKey",
			game = "example",
			env = "live",
			dropEvent = "telemetry_drop",
			maxBatch = 1000,
			flushSeconds = 180,
			tickSeconds = 60,
			maxTries = 3,
			closeBudget = 20,
			closeQuiet = 2,
		},
		ringSize = 2000,
		protectedSize = 500,
		priorities = { feed = "bulk", purchase = "urgent", telemetry_drop = "protected" },
		dropEvent = "telemetry_drop",
		salt = "example/telemetry/actor/v1:00000000",
		clean = { maxString = 1000, maxDepth = 4 },
	}, "resolved")
end)

Spec.test("what the game sets is what the pipe gets", function()
	const given = options()
	given.flushSeconds = 600
	given.tickSeconds = 30
	given.maxBatch = 500
	given.ringSize = 4000
	given.protectedSize = 250
	given.maxTries = 5
	given.closeBudget = 10
	given.closeQuiet = 1
	given.placeVersion = 42
	given.maxStringBytes = 60000
	given.maxDepth = 6
	given.environment = "test"
	const resolved = Options.resolve(given, false)
	Spec.equal({
		resolved.pipe.flushSeconds,
		resolved.pipe.tickSeconds,
		resolved.pipe.maxBatch,
		resolved.ringSize,
		resolved.protectedSize,
		resolved.pipe.maxTries,
		resolved.pipe.closeBudget,
		resolved.pipe.closeQuiet,
		resolved.pipe.placeVersion,
	}, { 600, 30, 500, 4000, 250, 5, 10, 1, 42 }, "numbers")
	Spec.equal(resolved.pipe.env, "test", "environment")
	Spec.equal(resolved.clean, { maxString = 60000, maxDepth = 6 }, "the context's limits")
end)

Spec.test("Studio never has a destination, whatever the game says, and is always called studio", function()
	Spec.equal(Options.destination("https://ingest.test/ingest", true), "", "Studio")
	Spec.equal(Options.destination("https://ingest.test/ingest", false), "https://ingest.test/ingest", "live")
	Spec.equal(Options.destination(nil, false), "", "no endpoint")
	Spec.equal(Options.environment("test", true), "studio", "Studio's name")
	Spec.equal(Options.environment("test", false), "test", "the game's name")
	Spec.equal(Options.environment(nil, false), "live", "the default")
	const inStudio = Options.resolve(options(), true)
	Spec.equal({ inStudio.pipe.destination, inStudio.pipe.env }, { "", "studio" }, "resolved in Studio")
end)

Spec.test("the drop event is protected unless the game says urgent, and never bulk", function()
	const given = options()
	given.events.telemetry_drop = "urgent"
	Spec.equal(Options.resolve(given, false).priorities.telemetry_drop, "urgent", "the game's choice stands")
	given.events.telemetry_drop = "bulk"
	Spec.throws(function()
		Options.resolve(given, false)
	end, "the drop event cannot be bulk")
end)

Spec.test("a missing or empty name is an error that says which", function()
	for _, field in { "game", "salt", "secretName", "dropEvent" } do
		Spec.throws(function()
			Options.resolve(with(field, nil), false)
		end, `TelemetryBlox: \`{field}\` must be a non-empty string`)
		Spec.throws(function()
			Options.resolve(with(field, ""), false)
		end, `TelemetryBlox: \`{field}\` must be a non-empty string`)
		Spec.throws(function()
			Options.resolve(with(field, 5), false)
		end, `TelemetryBlox: \`{field}\` must be a non-empty string`)
	end
end)

Spec.test("a number that is not positive is an error that says which", function()
	const fields = {
		"flushSeconds",
		"tickSeconds",
		"maxBatch",
		"ringSize",
		"protectedSize",
		"maxTries",
		"closeBudget",
		"closeQuiet",
		"maxStringBytes",
		"maxDepth",
	}
	for _, field in fields do
		for _, bad in { 0, -1, 0 / 0, math.huge, "60" } do
			Spec.throws(function()
				Options.resolve(with(field, bad), false)
			end, `TelemetryBlox: \`{field}\` must be a positive number`)
		end
	end
	-- The smallest positive number is taken as given.
	Spec.equal(Options.resolve(with("closeQuiet", 0.25), false).pipe.closeQuiet, 0.25, "a fraction is fine")
end)

Spec.test("a vocabulary that is not names and priorities is an error", function()
	Spec.throws(function()
		Options.resolve(with("events", nil), false)
	end, "`events` must be a table")
	Spec.throws(function()
		Options.resolve(with("events", { feed = "loud" }), false)
	end, "`events` holds feed = loud")
	Spec.throws(function()
		Options.resolve(with("events", { "feed" }), false)
	end, "`events` holds 1 = feed")
	-- A name that is not a string, with a priority that is one.
	Spec.throws(function()
		Options.resolve(with("events", { "bulk" }), false)
	end, "`events` holds 1 = bulk")
end)

Spec.test("an environment is a short lowercase word, and never studio", function()
	for _, bad in { "Live", "", "live server", "9lives", "seventeen_letters", 5 } do
		Spec.throws(function()
			Options.resolve(with("environment", bad), false)
		end, "`environment` must be a short lowercase word")
	end
	Spec.throws(function()
		Options.resolve(with("environment", "studio"), false)
	end, '`environment` cannot be "studio"')
	Spec.equal(Options.resolve(with("environment", "test-2_b"), false).pipe.env, "test-2_b", "digits, dash, underscore")
	Spec.equal(Options.resolve(with("environment", "sixteen_letters_"), false).pipe.env, "sixteen_letters_", "sixteen")
	Spec.throws(function()
		Options.resolve(with("endpoint", 5), false)
	end, "`endpoint` must be a string")
end)

return nil
