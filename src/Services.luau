--!strict
--- The seam: everything of Roblox the library uses, reached through one bundle.
---
--- These types are ours and deliberately narrow. The library only ever calls what is listed here, so
--- the specs hand in fakes (`tests/fakes/`) with a clock they move and an ingest they script, and the
--- real adapter (`RobloxServices`) translates to the engine. The ring, the batching, the retry and the
--- drain are therefore run off Roblox, by the VM a game runs them with.

--> What the ingest answered: Roblox's `RequestAsync` result, as far as the pipe reads it.
export type Response = {
	Success: boolean,
	StatusCode: number,
}

--> Which server this is. `jobId` is empty in Studio.
export type Server = {
	universeId: string,
	placeId: string,
	placeVersion: number,
	jobId: string,
}

--> A request header's value: plain text, or the opaque `Secret` that `HttpService:GetSecret` returns.
export type HeaderValue = string | Secret

export type Services = {
	--> `RunService:IsStudio()`. Studio never sends.
	isStudio: () -> boolean,
	--> Unix seconds (`os.time`): what a row and a batch are stamped with.
	now: () -> number,
	--> Seconds that only move forward (`os.clock`): what intervals are measured with.
	clock: () -> number,
	--> `task.wait`. Yields.
	wait: (seconds: number) -> (),
	--> `task.spawn`.
	spawn: (fn: () -> ()) -> (),
	--> Read when a batch is built, not when the library is required.
	server: () -> Server,
	--> `HttpService:GetSecret(name)`. Raises when the experience has no such secret, or in Studio.
	secret: (name: string) -> HeaderValue,
	--> One POST of a JSON body. Yields; raises on a transport failure.
	request: (url: string, headers: { [string]: HeaderValue }, body: string) -> Response,
	--> `HttpService:JSONEncode`.
	encode: (value: any) -> string,
	--> Players on this server now: the shutdown drain ends once it is zero and nothing more comes.
	playerCount: () -> number,
	--> `game:BindToClose`.
	onClose: (fn: () -> ()) -> (),
	--> `ScriptContext.Error`, with the raising script as its full name ("?" when the engine gave none).
	onError: (fn: (message: string, trace: string, where: string) -> ()) -> (),
	--> Where the pipe says a post failed: the server's log.
	warn: (id: string, context: { [string]: any }) -> (),
}

return nil
