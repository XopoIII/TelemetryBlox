--!strict
--- The real `Services` bundle, over the engine's services.
---
--- Nothing here runs at require time: `game` is touched only inside `build()`, so the module can be
--- required (and type-checked) anywhere.
const Calls = require("./Calls")
const Services = require("./Services")

const RobloxServices = {}

--> Roblox's own analytics: each call is made on its own thread under pcall, so it can neither yield
--> the caller nor raise into it. A call that fails is the service's to report.
function RobloxServices.analytics(): Calls.Sink
	const service = game:GetService("AnalyticsService")
	const keys = {
		Enum.AnalyticsCustomFieldKeys.CustomField01.Name,
		Enum.AnalyticsCustomFieldKeys.CustomField02.Name,
		Enum.AnalyticsCustomFieldKeys.CustomField03.Name,
	}

	const function make(player: Player, call: Calls.Call)
		const fields: { [string]: string } = {}
		for index, value in call.fields or {} do
			fields[keys[index]] = value
		end
		if call.kind == "custom" then
			service:LogCustomEvent(player, call.name, call.value or 1, fields)
		elseif call.kind == "progression" then
			if call.status == "start" then
				service:LogProgressionStartEvent(player, call.path, call.level, call.levelName, fields)
			elseif call.status == "complete" then
				service:LogProgressionCompleteEvent(player, call.path, call.level, call.levelName, fields)
			else
				service:LogProgressionFailEvent(player, call.path, call.level, call.levelName, fields)
			end
		elseif call.kind == "funnel" then
			service:LogFunnelStepEvent(player, call.funnel, call.session, call.step, call.stepName, fields)
		elseif call.kind == "onboarding" then
			service:LogOnboardingFunnelStepEvent(player, call.index or 0, call.step, fields)
		elseif call.kind == "economy" then
			const flow = if call.flow == "source"
				then Enum.AnalyticsEconomyFlowType.Source
				else Enum.AnalyticsEconomyFlowType.Sink
			service:LogEconomyEvent(
				player,
				flow,
				call.currency,
				call.amount,
				call.balance,
				call.transaction,
				call.item,
				fields
			)
		else
			service:LogJourneyEvent(player, call.journey, call.node, call.session, fields)
		end
	end

	return function(player: Player, call: Calls.Call)
		task.spawn(pcall, make, player, call)
	end
end

--> The bundle for this server. Built once, by `TelemetryBlox.new`, when a game passes none of its own.
function RobloxServices.build(): Services.Services
	const httpService = game:GetService("HttpService")
	const players = game:GetService("Players")
	const runService = game:GetService("RunService")
	const scriptContext = game:GetService("ScriptContext")

	const services = {} :: Services.Services

	function services.isStudio(): boolean
		return runService:IsStudio()
	end

	function services.now(): number
		return os.time()
	end

	function services.clock(): number
		return os.clock()
	end

	function services.wait(seconds: number)
		task.wait(seconds)
	end

	function services.spawn(fn: () -> ())
		task.spawn(fn)
	end

	-- `game.JobId` is empty in Studio, and the ingest names a batch by (job id, server start, first
	-- row): two Studio servers started in the same second would share a batch's identity, and the
	-- second one's rows would be ignored as a copy. So a Studio server gets a made-up id of its own,
	-- one per server, made here where the engine is.
	local studioJobId: string? = nil

	function services.server(): Services.Server
		local jobId = game.JobId
		if jobId == "" then
			if studioJobId == nil then
				studioJobId = `studio-{httpService:GenerateGUID(false)}`
			end
			jobId = studioJobId :: string
		end
		return {
			universeId = tostring(game.GameId),
			placeId = tostring(game.PlaceId),
			placeVersion = game.PlaceVersion,
			jobId = jobId,
		}
	end

	function services.secret(name: string): Services.HeaderValue
		return httpService:GetSecret(name)
	end

	-- `x-api-key` and `content-type` are request headers Roblox lets a game set. Nothing leaves the
	-- server until Allow HTTP Requests is on AND the secret's domain is this endpoint's host.
	function services.request(url: string, headers: { [string]: Services.HeaderValue }, body: string): Services.Response
		const response = httpService:RequestAsync({
			Url = url,
			Method = "POST",
			Headers = headers,
			Body = body,
		})
		return { Success = response.Success, StatusCode = response.StatusCode }
	end

	function services.encode(value: any): string
		return httpService:JSONEncode(value)
	end

	function services.playerCount(): number
		return #players:GetPlayers()
	end

	function services.onClose(fn: () -> ())
		game:BindToClose(fn)
	end

	function services.onError(fn: (message: string, trace: string, where: string) -> ())
		scriptContext.Error:Connect(function(message: string, trace: string, source: Instance?)
			fn(message, trace, if source then source:GetFullName() else "?")
		end)
	end

	function services.warn(id: string, context: { [string]: any })
		warn(`[TelemetryBlox] {id} {httpService:JSONEncode(context)}`)
	end

	services.analytics = RobloxServices.analytics()

	return services
end

return RobloxServices
