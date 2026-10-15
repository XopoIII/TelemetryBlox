--!strict
--- The analytics options a game hands in: a mistake is an error at boot.
const AnalyticsOptions = require("@telemetryblox/AnalyticsOptions")
const Calls = require("@telemetryblox/Calls")
const Spec = require("../Spec")

type Options = AnalyticsOptions.Options<string>

const PRIORITIES: { [string]: any } = { join = "protected", leave = "protected", lost = "urgent", feed = "bulk" }

const function given(change: ((Options) -> ())?): Options
	const options: Options = {
		map = function(): { Calls.Call }?
			return nil
		end,
	}
	if change then
		change(options)
	end
	return options
end

Spec.test("fills the defaults: half of what Roblox allows, and no onboarding", function()
	const resolved = AnalyticsOptions.resolve(given(), PRIORITIES)
	Spec.equal(
		{ resolved.limit, resolved.perPlayer, resolved.steps, resolved.leaveEvent, resolved.dropEvent },
		{ 60, 10, {}, nil, nil }
	)
end)

Spec.test("keeps what a game gives, at Roblox's own limits", function()
	const resolved = AnalyticsOptions.resolve(
		given(function(options: Options)
			options.onboarding = { "joined", "fed" }
			options.leaveEvent = "leave"
			options.dropEvent = "lost"
			options.limit = 120
			options.perPlayer = 0
		end),
		PRIORITIES
	)
	Spec.equal(
		{ resolved.limit, resolved.perPlayer, resolved.steps, resolved.leaveEvent, resolved.dropEvent },
		{ 120, 0, { joined = 1, fed = 2 }, "leave", "lost" }
	)
	Spec.equal(
		AnalyticsOptions.resolve(
			given(function(options: Options)
				options.perPlayer = 20
				options.limit = 1
				options.dropEvent = "join"
			end),
			PRIORITIES
		).perPlayer,
		20
	)
	const hundred = {}
	for index = 1, 100 do
		hundred[index] = `s{index}`
	end
	Spec.equal(
		AnalyticsOptions.resolve(
			given(function(options: Options)
				options.onboarding = hundred
			end),
			PRIORITIES
		).steps.s100,
		100,
		"a hundred steps"
	)
end)

Spec.test("refuses what is wrong, and says what", function()
	const hundredOne = {}
	for index = 1, 101 do
		hundredOne[index] = `s{index}`
	end
	const holed: any = { "a", "b" }
	holed.extra = "c"
	const zeroed: any = { "a" }
	zeroed[0] = "z"
	const halved: any = { "a" }
	halved[1.5] = "z"
	const cases: { { any } } = {
		{
			function(o: any)
				o.map = nil
			end,
			"analytics `map` must be a function",
		},
		{
			function(o: any)
				o.fields = 5
			end,
			"analytics `fields` must be a function",
		},
		{
			function(o: any)
				o.onboarding = "joined"
			end,
			"analytics `onboarding` must be a list of step names",
		},
		{
			function(o: any)
				o.onboarding = holed
				o.onboarding = zeroed
				o.onboarding = halved
			end,
			"analytics `onboarding` must be a list of step names",
		},
		{
			function(o: any)
				o.onboarding = { "a", "" }
			end,
			"analytics onboarding step 2 must be a non-empty string",
		},
		{
			function(o: any)
				o.onboarding = { "a", 5 }
			end,
			"analytics onboarding step 2 must be a non-empty string",
		},
		{
			function(o: any)
				o.onboarding = { "a", "b", "a" }
			end,
			"analytics onboarding step a is listed twice",
		},
		{
			function(o: any)
				o.onboarding = hundredOne
			end,
			"analytics `onboarding` has more than 100 steps",
		},
		{
			function(o: any)
				o.leaveEvent = "left"
			end,
			"analytics `leaveEvent` left is not in `events`",
		},
		{
			function(o: any)
				o.dropEvent = "gone"
			end,
			"analytics `dropEvent` gone is not in `events`",
		},
		{
			function(o: any)
				o.dropEvent = "feed"
			end,
			"the analytics drop event cannot be bulk",
		},
		{
			function(o: any)
				o.limit = 121
			end,
			"analytics `limit` must be a whole number from 1 to 120",
		},
		{
			function(o: any)
				o.limit = 0
			end,
			"analytics `limit` must be a whole number from 1 to 120",
		},
		{
			function(o: any)
				o.limit = 2.5
			end,
			"analytics `limit` must be a whole number from 1 to 120",
		},
		{
			function(o: any)
				o.perPlayer = 21
			end,
			"analytics `perPlayer` must be a whole number from 0 to 20",
		},
		{
			function(o: any)
				o.perPlayer = -1
			end,
			"analytics `perPlayer` must be a whole number from 0 to 20",
		},
	}
	for _, case in cases do
		Spec.throws(function()
			AnalyticsOptions.resolve(given(case[1]), PRIORITIES)
		end, case[2])
	end
	const nothing: any = nil
	Spec.throws(function()
		AnalyticsOptions.resolve(nothing, PRIORITIES)
	end, "the analytics options must be a table")
end)

return nil
