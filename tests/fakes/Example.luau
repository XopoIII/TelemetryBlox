--!strict
--- The example game the front door's specs are written against: its vocabulary, its options, a
--- player, and that player's pseudonym.
const TelemetryBlox = require("@telemetryblox")
const World = require("./World")

const Example = {}

export type EventName = "join" | "feed" | "purchase" | "server_error" | "telemetry_drop"

Example.ENDPOINT = "https://ingest.test/ingest"
--> The pseudonym of user 123456789 under the salt below (pinned in `tests/unit/Anon.luau`).
Example.ACTOR = "u_b6143fd8f67c8ca4"

function Example.options(): TelemetryBlox.Options<EventName>
	return {
		game = "example",
		salt = "example/telemetry/actor/v1:00000000",
		secretName = "ExampleKey",
		endpoint = Example.ENDPOINT,
		events = { join = "protected", feed = "bulk", purchase = "urgent", server_error = "urgent" },
		dropEvent = "telemetry_drop",
	}
end

--> The example game's telemetry on `world`, with its options changed by `change`.
function Example.make(
	world: World.World,
	change: ((TelemetryBlox.Options<EventName>) -> ())?
): TelemetryBlox.Telemetry<EventName>
	const given = Example.options()
	if change then
		change(given)
	end
	const telemetry: TelemetryBlox.Telemetry<EventName> = TelemetryBlox.new(given, world.services)
	return telemetry
end

--> A player as the engine hands one over, as far as the library could read it. Typed `any` because
--> a spec has no Player; the library reads `UserId` and nothing else.
function Example.player(): any
	return { UserId = 123456789, Name = "Builderman", DisplayName = "TheBuilder" }
end

return Example
