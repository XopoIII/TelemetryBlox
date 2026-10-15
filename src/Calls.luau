--!strict
--- What a game may tell Roblox's own analytics: one call of each kind it has, built by a function
--- here, and checked before it is made. A call Roblox could not take is refused here, with a
--- reason, rather than sent and lost at Roblox's end.
---
--- A call's fields are Roblox's three custom fields, by number: `{ [1] = "Desktop", [3] = "Payer" }`.
--- A call's own fields override the game's default fields for its player, one by one.
const Calls = {}

--> Roblox's three custom fields, by number (1, 2 or 3); each a non-empty string.
export type Fields = { [number]: string }

export type Kind = "custom" | "progression" | "funnel" | "onboarding" | "economy" | "journey"
export type Status = "start" | "complete" | "fail"
export type Flow = "source" | "sink"

--> One call. `value` of a custom event is 1 when it is left out. An onboarding step is named, and
--> its number is its place in the game's `onboarding` list, which the kit sets as `index`. A
--> funnel step with no `session` is given the player's current run of that funnel, and a new one
--> at step 1.
export type Call =
	{ kind: "custom", name: string, value: number?, fields: Fields? }
	| { kind: "progression", path: string, status: Status, level: number, levelName: string?, fields: Fields? }
	| { kind: "funnel", funnel: string, step: number, stepName: string, session: string?, fields: Fields? }
	| { kind: "onboarding", step: string, index: number?, fields: Fields? }
	| {
		kind: "economy",
		flow: Flow,
		currency: string,
		amount: number,
		balance: number,
		transaction: string,
		item: string?,
		fields: Fields?,
	}
	| { kind: "journey", journey: string, node: string, session: string?, fields: Fields? }

--> Where the calls go: Roblox's own analytics in a game (`RobloxServices`), a recorder in a spec.
--> It is handed a copy of the call with its fields merged, a custom value, an onboarding index and
--> a funnel session filled in. It must not yield.
export type Sink = (player: Player, call: Call) -> ()

--> Roblox's funnels have at most this many steps.
Calls.MAX_STEP = 100

--> A custom event `name`, of `value` (1 when left out).
function Calls.custom(name: string, value: number?, fields: Fields?): Call
	return { kind = "custom", name = name, value = value, fields = fields }
end

--> Level `level` of the progression path `path` begun, completed or failed.
function Calls.progression(path: string, status: Status, level: number, levelName: string?, fields: Fields?): Call
	return { kind = "progression", path = path, status = status, level = level, levelName = levelName, fields = fields }
end

--> Step `step` of the recurring funnel `funnel`, called `stepName`.
function Calls.funnel(funnel: string, step: number, stepName: string, session: string?, fields: Fields?): Call
	return { kind = "funnel", funnel = funnel, step = step, stepName = stepName, session = session, fields = fields }
end

--> The onboarding step named `step`, one of the game's `onboarding` list.
function Calls.onboarding(step: string, fields: Fields?): Call
	return { kind = "onboarding", step = step, fields = fields }
end

--> `amount` of `currency` earned (`source`) or spent (`sink`), `balance` left, for what.
function Calls.economy(
	flow: Flow,
	currency: string,
	amount: number,
	balance: number,
	transaction: string,
	item: string?,
	fields: Fields?
): Call
	return {
		kind = "economy",
		flow = flow,
		currency = currency,
		amount = amount,
		balance = balance,
		transaction = transaction,
		item = item,
		fields = fields,
	}
end

--> The node `node` of the journey `journey`.
function Calls.journey(journey: string, node: string, session: string?, fields: Fields?): Call
	return { kind = "journey", journey = journey, node = node, session = session, fields = fields }
end

const function text(value: any): boolean
	return type(value) == "string" and value ~= ""
end

const function maybeText(value: any): boolean
	return value == nil or text(value)
end

const function finite(value: any): boolean
	return type(value) == "number" and value == value and math.abs(value) ~= math.huge
end

const function whole(value: any, least: number, most: number?): boolean
	return finite(value) and value % 1 == 0 and value >= least and (most == nil or value <= most)
end

--> Why `fields` cannot be sent, or nil when it can (nil fields can).
function Calls.fieldsProblem(fields: any): string?
	if fields == nil then
		return nil
	end
	if type(fields) ~= "table" then
		return "fields must be a table"
	end
	for key, value in fields do
		if key ~= 1 and key ~= 2 and key ~= 3 then
			return `field {tostring(key)} is not 1, 2 or 3`
		end
		if not text(value) then
			return `field {key} must be a non-empty string`
		end
	end
	return nil
end

const STATUSES: { [string]: boolean } = { start = true, complete = true, fail = true }
const FLOWS: { [string]: boolean } = { source = true, sink = true }

--> Why `call` cannot be made, or nil when it can. Total: it reads anything a game returns.
function Calls.problem(call: any): string?
	if type(call) ~= "table" then
		return "a call must be a table"
	end
	const kind = call.kind
	if kind == "custom" then
		if not text(call.name) then
			return "a custom event needs a name"
		elseif call.value ~= nil and not finite(call.value) then
			return "a custom value must be a finite number"
		end
	elseif kind == "progression" then
		if not text(call.path) then
			return "a progression needs a path"
		elseif STATUSES[call.status] ~= true then
			return "a progression's status is start, complete or fail"
		elseif not whole(call.level, 1) then
			return "a progression's level is a whole number from 1"
		elseif not maybeText(call.levelName) then
			return "a level's name must be a non-empty string"
		end
	elseif kind == "funnel" then
		if not text(call.funnel) then
			return "a funnel step needs its funnel"
		elseif not whole(call.step, 1, Calls.MAX_STEP) then
			return `a funnel's step is a whole number from 1 to {Calls.MAX_STEP}`
		elseif not text(call.stepName) then
			return "a funnel step needs a name"
		elseif not maybeText(call.session) then
			return "a funnel's session must be a non-empty string"
		end
	elseif kind == "onboarding" then
		if not text(call.step) then
			return "an onboarding step needs its name"
		end
	elseif kind == "economy" then
		if FLOWS[call.flow] ~= true then
			return "an economy flow is source or sink"
		elseif not text(call.currency) then
			return "an economy call needs a currency"
		elseif not finite(call.amount) or call.amount <= 0 then
			return "an economy amount is a finite number above 0"
		elseif not finite(call.balance) or call.balance < 0 then
			return "an economy balance is a finite number from 0"
		elseif not text(call.transaction) then
			return "an economy call needs a transaction type"
		elseif not maybeText(call.item) then
			return "an economy item must be a non-empty string"
		end
	elseif kind == "journey" then
		if not text(call.journey) or not text(call.node) then
			return "a journey call needs its journey and its node"
		elseif not maybeText(call.session) then
			return "a journey's session must be a non-empty string"
		end
	else
		return `no kind of call is called {tostring(kind)}`
	end
	return Calls.fieldsProblem(call.fields)
end

--> The fields of a call: `defaults`, with `own` over them, one by one. A new table.
function Calls.merge(defaults: Fields?, own: Fields?): Fields
	const merged: Fields = table.clone(defaults or {})
	for key, value in own or {} do
		merged[key] = value
	end
	return merged
end

return Calls
