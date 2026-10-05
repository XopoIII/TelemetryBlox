--!strict
--- A server the specs can hold: the `Services` bundle over a clock they move and an ingest they
--- script. Nothing here waits or sends; a `wait` moves the clock and a `request` is written down.
const serde = require("@lune/serde")

const TelemetryBlox = require("@telemetryblox")

const World = {}

--> Posts one world takes before it calls the pipe a runaway.
World.MAX_POSTS = 200
--> And waits: a drain's whole budget is eighty quarter seconds.
World.MAX_WAITS = 500

--> What the scripted ingest does with one post: take it, refuse it with a status, or fail to connect.
export type Answer = true | number | "raise"

export type Post = {
	url: string,
	headers: { [string]: TelemetryBlox.HeaderValue },
	--> The body as it was sent.
	body: string,
	--> The body, decoded: the envelope.
	envelope: any,
}

export type Warning = { id: string, context: { [string]: any } }

export type World = {
	services: TelemetryBlox.Services,
	--> Every post made, in order.
	posts: { Post },
	--> What the ingest answers, post by post; past the end of the list it takes everything.
	answers: { Answer },
	--> Every line the pipe wrote to the log.
	warnings: { Warning },
	--> Every wait asked for, in order.
	waits: { number },
	--> Functions handed to `spawn`, `onClose` and `onError`: held, never run by the fake.
	spawned: { () -> () },
	closers: { () -> () },
	errorHandlers: { (message: string, trace: string, where: string) -> () },
	--> Run at the end of every wait, after the clock has moved: what else happens meanwhile.
	onWait: ((seconds: number) -> ())?,
	studio: boolean,
	players: number,
	--> True: the experience has no such secret, and reading it raises.
	secretMissing: boolean,
	--> Unix seconds, and the seconds that only move forward. A wait moves both.
	now: number,
	clock: number,
	--> The events of post `index`, as their names joined by commas.
	names: (index: number) -> string,
}

--> A live server with one player and an ingest that takes everything, at a known moment.
function World.new(): World
	const world = {
		posts = {},
		answers = {},
		warnings = {},
		waits = {},
		spawned = {},
		closers = {},
		errorHandlers = {},
		studio = false,
		players = 1,
		secretMissing = false,
		now = 1_800_000_000,
		clock = 50,
	} :: World

	const services = {} :: TelemetryBlox.Services

	function services.isStudio(): boolean
		return world.studio
	end

	function services.now(): number
		return world.now
	end

	function services.clock(): number
		return world.clock
	end

	function services.wait(seconds: number)
		if #world.waits >= World.MAX_WAITS then
			error("the pipe waited more often than any spec expects")
		end
		table.insert(world.waits, seconds)
		world.now += seconds
		world.clock += seconds
		if world.onWait then
			world.onWait(seconds)
		end
	end

	function services.spawn(fn: () -> ())
		table.insert(world.spawned, fn)
	end

	function services.server(): TelemetryBlox.Server
		return {
			universeId = "111",
			placeId = "222",
			placeVersion = 7,
			jobId = if world.studio then "" else "job-a",
		}
	end

	function services.secret(name: string): TelemetryBlox.HeaderValue
		if world.secretMissing then
			error(`Can't find secret with given key {name}`)
		end
		return `secret:{name}`
	end

	function services.request(
		url: string,
		headers: { [string]: TelemetryBlox.HeaderValue },
		body: string
	): TelemetryBlox.Response
		-- No spec posts this often: a pipe that does is running away, and must fail rather than hang.
		if #world.posts >= World.MAX_POSTS then
			error("the pipe posted more often than any spec expects")
		end
		table.insert(world.posts, { url = url, headers = headers, body = body, envelope = serde.decode("json", body) })
		const answer = world.answers[#world.posts]
		if answer == "raise" then
			error("HttpError: ConnectFail")
		elseif type(answer) == "number" then
			return { Success = false, StatusCode = answer }
		end
		return { Success = true, StatusCode = 200 }
	end

	function services.encode(value: any): string
		return serde.encode("json", value)
	end

	function services.playerCount(): number
		return world.players
	end

	function services.onClose(fn: () -> ())
		table.insert(world.closers, fn)
	end

	function services.onError(fn: (message: string, trace: string, where: string) -> ())
		table.insert(world.errorHandlers, fn)
	end

	function services.warn(id: string, context: { [string]: any })
		table.insert(world.warnings, { id = id, context = context })
	end

	function world.names(index: number): string
		const names: { string } = {}
		for _, row in world.posts[index].envelope.events do
			table.insert(names, row.event)
		end
		return table.concat(names, ",")
	end

	world.services = services
	return world
end

return World
