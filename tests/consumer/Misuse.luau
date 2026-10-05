--!strict
--- Misuse of TelemetryBlox's public API that must NOT type-check, under either solver: proof that a
--- game's vocabulary is a type, and that `Game.luau` is checked against real types rather than
--- passing on `any`. `scripts/type-check.sh` expects an error on each line marked `-- error`, and no
--- other. A line marked `-- error (new solver)` is one only the new solver refuses.
const TelemetryBlox = require("@telemetryblox")

type EventName = "join" | "purchase" | "telemetry_drop"

const options: TelemetryBlox.Options<EventName> = {
	game = "example",
	salt = "example/telemetry/actor/v1:00000000",
	secretName = "ExampleTelemetryKey",
	events = { join = "bulk", purchase = "urgent", telemetry_drop = "protected" },
	dropEvent = "telemetry_drop",
}
const telemetry: TelemetryBlox.Telemetry<EventName> = TelemetryBlox.new(options)

-- The positive case beside the negative ones: a name of the vocabulary compiles.
telemetry.emit("purchase", nil, { robux = 25 })

-- A name outside the vocabulary.
telemetry.emit("purchse", nil, { robux = 25 }) -- error
-- A player's id where the player belongs: the id never reaches a row by hand.
telemetry.emit("join", 123456789) -- error
-- A context that is not a table.
telemetry.emit("join", nil, "hello") -- error

-- The pipe's own events are of the vocabulary too.
options.dropEvent = "dropped" -- error
-- A priority that does not exist.
options.events.join = "loud" -- error
-- An event outside the vocabulary cannot be given a priority.
options.events.purchse = "urgent" -- error

-- Server errors are reported under a name of the vocabulary.
telemetry.captureErrors("server_error") -- error

-- A listener hears names of the vocabulary, not any string.
telemetry.onEmit(function(name: number) -- error
	print(name)
end)

return nil
