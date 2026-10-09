--!strict
--- The transport: everything that leaves the server.
---
--- All of it lives in ONE spawned flusher. A request yields only its own coroutine, so a batch in
--- flight costs the running game nothing. Rows are batched (`maxBatch` a post) and a post is rare,
--- which keeps both HttpService's budget and the ingest's free plan far away: each post is one Worker
--- request and two database rows written, whatever it holds.
---
--- WHEN IT POSTS. Every `flushSeconds` (three minutes), and only when something waits. The flusher
--- wakes every `tickSeconds` and posts early for three reasons only (`due`): an urgent row waits, a
--- refused batch is held for its retry, or the ring is half a batch full. So the throughput under
--- load is still `maxBatch / tickSeconds`.
---
--- A REFUSED BATCH IS HELD, not put back: the ring keeps its own bound while the ingest is down, and
--- the held batch is the same rows under the same identity (the server's job id and start, and the
--- rows' own numbers), so a post that landed without its answer is ignored by the ingest rather than
--- stored twice. After `maxTries` posts the batch is counted lost.
---
--- THE FIRST WAKE IS STAGGERED. A publish or a surge starts many servers in the same second, and a
--- fleet whose flushers wake together posts together for its whole life. The first wait is the job
--- id's hash within the tick (`stagger`), so the fleet spreads its posts across the minute and keeps
--- them spread.
---
--- An empty destination is COLLECT-ONLY: the ring still fills and reads back, and nothing is sent.
const Hash = require("./Hash")
const Ring = require("./Ring")
const Services = require("./Services")

const Pipe = {}

--> The envelope's version, which the ingest stores beside every batch.
Pipe.SCHEMA_VERSION = 1
--> Seconds between a refused post and the next one while draining.
Pipe.CLOSE_RETRY_SECONDS = 2
--> Seconds between looks at an empty ring while draining.
Pipe.CLOSE_POLL_SECONDS = 0.25

--> Seconds before the flusher's first wake: the job id's hash within the tick, so servers that
--> started together do not post together. Deterministic: the same server wakes at the same offset.
function Pipe.stagger(jobId: string, tickSeconds: number): number
	return Hash.str32(jobId) % math.max(1, math.floor(tickSeconds))
end

export type Config = {
	--> The ingest's URL. Empty: collect, and send nothing.
	destination: string,
	--> The name of the experience secret that holds the ingest key.
	secretName: string,
	--> The game's tag, said in every batch.
	game: string,
	--> "studio", "live", or what the game calls a server that is neither (a test place).
	env: string,
	--> The place version to say; nil reads the server's own.
	placeVersion: number?,
	--> The event a loss is reported as.
	dropEvent: string,
	maxBatch: number,
	flushSeconds: number,
	tickSeconds: number,
	maxTries: number,
	--> Seconds the shutdown drain may take in all.
	closeBudget: number,
	--> Seconds the server must be empty and silent before the drain ends early.
	closeQuiet: number,
}

export type Pipe = {
	--> Posts the held batch, or up to `maxBatch` of the oldest rows. True when the ingest took it.
	flushOnce: () -> boolean,
	--> Writes the losses since the last report into the ring, as one row.
	reportDrops: () -> (),
	--> Whether to post now, `elapsed` seconds after the last post.
	due: (elapsed: number) -> boolean,
	--> One wake of the flusher: report the losses, post if it is due.
	tick: () -> (),
	--> The flusher: waits `tickSeconds`, ticks, forever. Yields; meant to be spawned.
	run: () -> (),
	--> The shutdown drain: posts until `settled()` has held with nothing to send for `closeQuiet`
	--> seconds, or `closeBudget` is spent. Yields.
	drain: (settled: () -> boolean) -> (),
	--> Rows waiting to leave: the ring's and a held batch's.
	backlog: () -> number,
}

--> Builds one pipe over `ring`.
function Pipe.new(config: Config, ring: Ring.Ring, services: Services.Services): Pipe
	const serverStart = services.now()
	local held: { Ring.Row }? = nil
	local tries = 0
	local posted = services.clock()

	-- `jobId` is not decoration: Roblox's own logs are addressed per server job, so carrying it lets
	-- a game's rows be read beside them. `env` keeps Studio and test places out of the live data.
	const function envelope(rows: { Ring.Row }): { [string]: any }
		const server = services.server()
		return {
			schemaVersion = Pipe.SCHEMA_VERSION,
			game = config.game,
			universeId = server.universeId,
			placeId = server.placeId,
			placeVersion = config.placeVersion or server.placeVersion,
			jobId = server.jobId,
			env = config.env,
			serverStart = serverStart,
			sentAt = services.now(),
			events = rows,
		}
	end

	-- One post. Returns whether the ingest took the batch, and why not when it did not (the HTTP
	-- status, or the error: a 401 is the secret, a 400 the payload). Never raises: a transport
	-- failure is data lost, not a fault of the game.
	const function post(rows: { Ring.Row }): (boolean, string?)
		const ok, result = pcall(function(): Services.Response
			const headers: { [string]: Services.HeaderValue } = { ["content-type"] = "application/json" }
			-- A missing secret must not stop the flusher: the batch goes without a key and the ingest
			-- refuses it, which is seen as a failed post rather than as silence.
			const found, secret = pcall(services.secret, config.secretName)
			if found then
				headers["x-api-key"] = secret
			end
			return services.request(config.destination, headers, services.encode(envelope(rows)))
		end)
		if not ok then
			return false, tostring(result)
		end
		if result.Success == true then
			return true, nil
		end
		return false, `http {result.StatusCode}`
	end

	const self = {} :: Pipe

	function self.backlog(): number
		return ring.size() + (if held then #held else 0)
	end

	function self.flushOnce(): boolean
		if config.destination == "" then
			return false
		end
		local batch: { Ring.Row }
		if held then
			batch = held
		elseif ring.size() == 0 then
			return false
		else
			batch = ring.take(config.maxBatch)
		end
		const sent, why = post(batch)
		if sent then
			held = nil
			tries = 0
			return true
		end
		tries += 1
		if tries < config.maxTries then
			held = batch
			services.warn("telemetry.send_retry", { count = #batch, try = tries, reason = why })
			return false
		end
		held = nil
		tries = 0
		ring.addUnsent(#batch)
		services.warn("telemetry.send_failed", { count = #batch, dropped = ring.dropped(), reason = why })
		return false
	end

	-- The hole is reported INTO the stream: `overflow` (a full ring evicted them: the game's volume),
	-- `send_failed` (the ingest never took their batch) and `refused` (turned away at the door), with
	-- `count` for all three. A gap the data can see beats one it reads as "nothing happened".
	function self.reportDrops()
		const evicted, unsent, refused = ring.claimDropped()
		const count = evicted + unsent + refused
		if count > 0 then
			ring.emit(config.dropEvent, nil, {
				count = count,
				overflow = evicted,
				send_failed = unsent,
				refused = refused,
			})
		end
	end

	function self.due(elapsed: number): boolean
		return held ~= nil or ring.urgent() or elapsed >= config.flushSeconds or ring.size() >= config.maxBatch / 2
	end

	function self.tick()
		self.reportDrops()
		if self.due(services.clock() - posted) then
			posted = services.clock()
			self.flushOnce()
		end
	end

	function self.run()
		posted = services.clock()
		-- The first wake is the stagger; every one after is a tick.
		local wake = Pipe.stagger(services.server().jobId, config.tickSeconds)
		while true do
			services.wait(wake)
			wake = config.tickSeconds
			self.tick()
		end
	end

	-- Without the drain the tail of every session, the most interesting part, dies with the server.
	--
	-- The rows of that tail are written WHILE this runs: a leaving player's last rows come from the
	-- game's own close handlers, side by side with this one. So an empty ring is not the end: the
	-- drain goes on until `settled` has held with nothing to send for `closeQuiet` seconds, or the
	-- budget is spent. Roblox gives a closing server about 30 seconds, so the drain is bounded
	-- rather than raced against the kill. A refused post is tried again rather than given up on.
	function self.drain(settled: () -> boolean)
		if config.destination == "" then
			return
		end
		const deadline = services.clock() + config.closeBudget
		local quietSince: number? = nil
		while services.clock() < deadline do
			self.reportDrops()
			if self.backlog() > 0 then
				quietSince = nil
				if not self.flushOnce() then
					services.wait(Pipe.CLOSE_RETRY_SECONDS)
				end
			elseif settled() then
				const since = quietSince or services.clock()
				quietSince = since
				if services.clock() - since >= config.closeQuiet then
					return
				end
				services.wait(Pipe.CLOSE_POLL_SECONDS)
			else
				quietSince = nil
				services.wait(Pipe.CLOSE_POLL_SECONDS)
			end
		end
	end

	return self
end

return Pipe
