--!strict
--- Roblox's own analytics, told what a game's rows mean. The game says, in one pure function, which
--- calls a row is (`AnalyticsOptions.map`); this makes them, within Roblox's limits:
---
--- - a call past the budget is dropped and counted, never queued (`Budget`);
--- - a call Roblox could not take is refused and counted, and said to the log once (`Calls`);
--- - past Roblox's caps (100 custom event names, 10 funnels, 10 currencies) a new name is refused;
--- - an onboarding step is made once a visit, and one the budget refused is tried again the next
---   time it comes;
--- - a funnel's run is opened at its first step, so a recurring funnel needs no session of the game's.
---
--- Nothing here yields or raises into the caller, and nothing touches the engine: the sink is handed in.
const AnalyticsOptions = require("./AnalyticsOptions")
const Budget = require("./Budget")
const Calls = require("./Calls")
const Ring = require("./Ring")

const Analytics = {}

--> Roblox's caps, past which a new name is refused here rather than lost there.
Analytics.MAX_NAMES = 100
Analytics.MAX_FUNNELS = 10
Analytics.MAX_CURRENCIES = 10
--> Seconds between two reports of what was lost.
Analytics.REPORT_SECONDS = 60

export type Config = {
	options: AnalyticsOptions.Resolved,
	sink: Calls.Sink,
	--> Seconds that only move forward.
	clock: () -> number,
	--> Players on the server now, each of whom widens the budget.
	players: () -> number,
	--> A new id, unique to this server, for a funnel's run.
	newId: () -> string,
	warn: (id: string, context: { [string]: any }) -> (),
	--> Where what was lost is reported; the front door writes it as a row of `dropEvent`.
	report: (dropped: number, invalid: number) -> (),
}

export type Analytics = {
	--> A row was written: its calls are made if it is about a player.
	handle: (name: string, player: Player?, context: Ring.Context) -> (),
	--> Makes `calls` for `player` that are not a row's.
	tell: (player: Player, calls: { Calls.Call }) -> (),
	--> Forgets what this visit of `player` was told.
	forget: (player: Player) -> (),
	--> Calls refused by the budget, and calls Roblox could not take, not yet reported.
	dropped: () -> number,
	invalid: () -> number,
	--> Reports what was lost, if a minute has passed since the last report or `now` says so.
	report: (now: boolean?) -> (),
	--> Makes no call from now on.
	stop: () -> (),
}

function Analytics.new(config: Config): Analytics
	const options = config.options
	const budget = Budget.new(options.limit)
	-- what each player was told this visit: the onboarding steps, and each funnel's run
	const onboarded: { [Player]: { [number]: boolean } } = {}
	const runs: { [Player]: { [string]: string } } = {}
	-- every name of each capped kind this server has used, and how many there are
	const names: { [string]: boolean } = {}
	const funnels: { [string]: boolean } = {}
	const currencies: { [string]: boolean } = {}
	local nameCount, currencyCount = 0, 0
	local funnelCount = if next(options.steps) ~= nil then 1 else 0
	local dropped, invalid = 0, 0
	local reported = config.clock()
	local stopped = false
	const warned: { [string]: boolean } = {}
	const self = {} :: Analytics

	const function warnOnce(id: string, detail: string)
		const key = `{id}:{detail}`
		if not warned[key] then
			warned[key] = true
			config.warn(id, { problem = detail })
		end
	end

	const function refuse(detail: string)
		invalid += 1
		warnOnce("telemetry.analytics_invalid", detail)
	end

	-- whether a capped name may be used: one used before, or a new one under the cap
	const function room(seen: { [string]: boolean }, used: number, cap: number, name: string): boolean
		return seen[name] == true or used < cap
	end

	const function one(player: Player, call: Calls.Call, defaults: Calls.Fields, now: number)
		const problem = Calls.problem(call)
		if problem then
			return refuse(problem)
		end
		local index: number? = nil
		if call.kind == "custom" then
			if not room(names, nameCount, Analytics.MAX_NAMES, call.name) then
				return refuse(`the custom event {call.name} is past Roblox's {Analytics.MAX_NAMES} names`)
			elseif not names[call.name] then
				names[call.name], nameCount = true, nameCount + 1
			end
		elseif call.kind == "funnel" then
			if not room(funnels, funnelCount, Analytics.MAX_FUNNELS, call.funnel) then
				return refuse(`the funnel {call.funnel} is past Roblox's {Analytics.MAX_FUNNELS} funnels`)
			elseif not funnels[call.funnel] then
				funnels[call.funnel], funnelCount = true, funnelCount + 1
			end
		elseif call.kind == "economy" then
			if not room(currencies, currencyCount, Analytics.MAX_CURRENCIES, call.currency) then
				return refuse(`the currency {call.currency} is past Roblox's {Analytics.MAX_CURRENCIES} currencies`)
			elseif not currencies[call.currency] then
				currencies[call.currency], currencyCount = true, currencyCount + 1
			end
		elseif call.kind == "onboarding" then
			index = options.steps[call.step]
			if index == nil then
				return refuse(`the onboarding step {call.step} is not in \`onboarding\``)
			end
			const told = onboarded[player]
			if told and told[index] then
				return
			end
		end
		if not budget.take(now, options.perPlayer * config.players()) then
			dropped += 1
			return
		end
		const made = table.clone(call)
		made.fields = Calls.merge(defaults, call.fields)
		if made.kind == "custom" then
			made.value = made.value or 1
		elseif made.kind == "onboarding" and index then
			made.index = index
			const told = onboarded[player] or {}
			told[index] = true
			onboarded[player] = told
		elseif made.kind == "funnel" and made.session == nil then
			const open = runs[player] or {}
			if made.step == 1 or open[made.funnel] == nil then
				open[made.funnel] = config.newId()
			end
			runs[player] = open
			made.session = open[made.funnel]
		end
		const ok, failure = pcall(config.sink, player, made)
		if not ok then
			warnOnce("telemetry.analytics_sink", tostring(failure))
		end
	end

	-- the game's default fields for `player`, or none when they cannot be sent
	const function defaults(player: Player): Calls.Fields
		const fields = options.fields
		if fields == nil then
			return {}
		end
		const ok, given = pcall(fields, player)
		const problem = if ok then Calls.fieldsProblem(given) else tostring(given)
		if problem then
			refuse(`the default fields: {problem}`)
			return {}
		end
		return given
	end

	const function all(player: Player, calls: any)
		if type(calls) ~= "table" then
			return refuse("calls must be a list")
		end
		const now = config.clock()
		const fields = defaults(player)
		for _, call in calls do
			one(player, call, fields, now)
		end
	end

	function self.report(now: boolean?)
		if dropped + invalid == 0 then
			return
		end
		const at = config.clock()
		if not now and at - reported < Analytics.REPORT_SECONDS then
			return
		end
		reported = at
		const lost, refused = dropped, invalid
		dropped, invalid = 0, 0
		config.report(lost, refused)
	end

	function self.handle(name: string, player: Player?, context: Ring.Context)
		if stopped or player == nil then
			return
		end
		const ok, calls = pcall(options.map, name, player, context)
		if not ok then
			refuse(`the map raised on {name}: {tostring(calls)}`)
		elseif calls ~= nil then
			all(player, calls)
		end
		if name == options.leaveEvent then
			self.forget(player)
		end
		self.report()
	end

	function self.tell(player: Player, calls: { Calls.Call })
		if not stopped then
			all(player, calls)
			self.report()
		end
	end

	function self.forget(player: Player)
		onboarded[player], runs[player] = nil, nil
	end

	function self.dropped(): number
		return dropped
	end

	function self.invalid(): number
		return invalid
	end

	function self.stop()
		stopped = true
	end

	return self
end

return Analytics
