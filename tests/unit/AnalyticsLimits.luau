--!strict
--- Roblox's own analytics at its limits: Roblox's caps on names, what cannot be told, what was
--- lost reported, and an analytics that has stopped.
const Analytics = require("@telemetryblox/Analytics")
const AnalyticsOptions = require("@telemetryblox/AnalyticsOptions")
const Calls = require("@telemetryblox/Calls")
const Spec = require("../Spec")
const Told = require("@fakes/Told")

type Options = Told.Options

const ALICE = Told.ALICE
const setup, calls, made = Told.setup, Told.calls, Told.made

Spec.test("a new name past Roblox's caps is refused, and a name used before is not", function()
	const s = setup(function(options: Options)
		options.limit = 120
		options.perPlayer = 20
	end)
	s.at.players = 100
	for index = 1, 100 do
		s.analytics.handle("row", ALICE, calls({ Calls.custom(`E{index}`) }))
	end
	s.analytics.handle("row", ALICE, calls({ Calls.custom("E101"), Calls.custom("E1") }))
	Spec.equal({ #s.told, s.analytics.invalid() }, { 101, 1 }, "the 101st name is refused, the first is told")
	-- the onboarding funnel is one of the ten
	for index = 1, 9 do
		s.analytics.handle("row", ALICE, calls({ Calls.funnel(`F{index}`, 1, "a") }))
	end
	s.analytics.handle("row", ALICE, calls({ Calls.funnel("F10", 1, "a"), Calls.funnel("F9", 2, "b") }))
	Spec.equal({ #s.told, s.analytics.invalid() }, { 111, 2 }, "nine funnels beside onboarding, not ten")
	for index = 1, 10 do
		s.analytics.handle("row", ALICE, calls({ Calls.economy("sink", `C{index}`, 1, 0, "T") }))
	end
	s.analytics.handle(
		"row",
		ALICE,
		calls({ Calls.economy("sink", "C11", 1, 0, "T"), Calls.economy("sink", "C10", 1, 0, "T") })
	)
	Spec.equal({ #s.told, s.analytics.invalid() }, { 122, 3 }, "ten currencies, not eleven")

	const plain = setup(function(options: Options)
		options.onboarding = nil
	end)
	for index = 1, 10 do
		plain.analytics.handle("row", ALICE, calls({ Calls.funnel(`F{index}`, 1, "a") }))
	end
	Spec.equal({ #plain.told, plain.analytics.invalid() }, { 10, 0 }, "ten funnels when there is no onboarding")
end)

Spec.test("what cannot be told costs its own call and nothing else, and never raises", function()
	const s = setup(function(options: Options)
		options.map = function(name: string, _player: Player, context: { [string]: any }): { Calls.Call }?
			if name == "flood" then
				error("the map broke")
			end
			return context.calls
		end
	end)
	s.analytics.handle("flood", ALICE, {})
	s.analytics.handle("row", ALICE, { calls = "nothing" })
	s.analytics.handle("row", ALICE, { calls = { Calls.custom(""), 5, Calls.custom("Fed") } })
	Spec.equal({ #s.told, s.analytics.invalid() }, { 1, 4 }, "the map, the list, the bad call, the number")
	Spec.equal(s.warnings[1].id, "telemetry.analytics_invalid", "said")
	Spec.truthy(string.find(s.warnings[1].context.problem, "the map raised on flood", 1, true) ~= nil, "with the row")

	const fields = setup(function(options: Options)
		options.fields = function(): Calls.Fields
			return { [4] = "x" }
		end
	end)
	fields.analytics.handle("row", ALICE, calls({ Calls.custom("Fed", 1, { [3] = "Coal" }) }))
	Spec.equal(
		made(fields),
		{ { kind = "custom", name = "Fed", value = 1, fields = { [3] = "Coal" } } },
		"told without them"
	)
	Spec.equal(fields.analytics.invalid(), 1, "the defaults are counted")

	const broken = setup()
	const raising: any = function()
		error("the service broke")
	end
	const broke = Analytics.new({
		options = AnalyticsOptions.resolve({
			map = function(): { Calls.Call }?
				return { Calls.custom("Fed") }
			end,
		}, Told.PRIORITIES),
		sink = raising,
		clock = os.clock,
		players = function(): number
			return 1
		end,
		newId = function(): string
			return "x"
		end,
		warn = function(id: string, context: { [string]: any })
			table.insert(broken.warnings, { id = id, context = context })
		end,
		report = function() end,
	})
	broke.handle("row", ALICE, {})
	broke.handle("row", ALICE, {})
	Spec.equal(#broken.warnings, 1, "a sink that raises is said once")
	Spec.equal(broken.warnings[1].id, "telemetry.analytics_sink", "as the sink's")
end)

Spec.test("what was lost is reported once a minute at most, and at once when asked", function()
	const s = setup(function(options: Options)
		options.limit = 1
		options.perPlayer = 0
	end)
	s.analytics.handle("row", ALICE, calls({ Calls.custom("A"), Calls.custom("B"), Calls.custom("") }))
	Spec.equal(s.reports, {}, "not within the first minute")
	s.at.clock = 159.999
	s.analytics.handle("row", ALICE, calls({ Calls.custom("C") }))
	Spec.equal(s.reports, {}, "not a moment before it")
	s.at.clock = 160
	s.analytics.handle("row", ALICE, calls({ Calls.custom("D") }))
	Spec.equal(s.reports, { { 2, 1 } }, "the minute's: two dropped and one invalid")
	Spec.equal({ s.analytics.dropped(), s.analytics.invalid() }, { 0, 0 }, "the counts begin again")
	s.analytics.handle("row", ALICE, calls({ Calls.custom("E") }))
	s.analytics.report(true)
	Spec.equal(s.reports, { { 2, 1 }, { 1, 0 } }, "asked for, within the minute")
	s.analytics.report(true)
	s.at.clock += 600
	s.analytics.report()
	Spec.equal(#s.reports, 2, "nothing lost, nothing reported")
end)

Spec.test("a stopped analytics tells nothing", function()
	const s = setup()
	s.analytics.stop()
	s.analytics.handle("row", ALICE, calls({ Calls.custom("A") }))
	s.analytics.tell(ALICE, { Calls.custom("A") })
	Spec.equal(#s.told, 0, "nothing")
end)

return nil
