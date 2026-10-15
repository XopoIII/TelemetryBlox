--!strict
--- The calls a game may make, and why one Roblox could not take is refused.
const Calls = require("@telemetryblox/Calls")
const Spec = require("../Spec")

Spec.test("builds each kind of call as Roblox takes it", function()
	Spec.equal(
		Calls.custom("Fed", 2, { [3] = "Coal" }),
		{ kind = "custom", name = "Fed", value = 2, fields = { [3] = "Coal" } }
	)
	Spec.equal(Calls.custom("Fed"), { kind = "custom", name = "Fed" })
	Spec.equal(
		Calls.progression("Nights", "complete", 2, "Night_2"),
		{ kind = "progression", path = "Nights", status = "complete", level = 2, levelName = "Night_2" }
	)
	Spec.equal(Calls.funnel("Shop", 1, "Opened"), { kind = "funnel", funnel = "Shop", step = 1, stepName = "Opened" })
	Spec.equal(Calls.onboarding("joined"), { kind = "onboarding", step = "joined" })
	Spec.equal(Calls.economy("sink", "Fuel", 1, 2, "Gameplay", "Stove"), {
		kind = "economy",
		flow = "sink",
		currency = "Fuel",
		amount = 1,
		balance = 2,
		transaction = "Gameplay",
		item = "Stove",
	})
	Spec.equal(
		Calls.journey("Day", "Shore", "s1"),
		{ kind = "journey", journey = "Day", node = "Shore", session = "s1" }
	)
end)

Spec.test("takes every well-made call", function()
	for index, call in
		{
			Calls.custom("Fed", 0),
			Calls.custom("Fed", -3.5),
			Calls.progression("Nights", "start", 1),
			Calls.progression("Nights", "fail", 7, "Night_7"),
			Calls.funnel("Shop", 1, "Opened", "s1"),
			Calls.funnel("Shop", 100, "Last"),
			Calls.onboarding("joined", { [1] = "a", [2] = "b", [3] = "c" }),
			Calls.economy("source", "Fuel", 0.5, 0, "Gameplay"),
			Calls.journey("Day", "Shore"),
		}
	do
		Spec.equal(Calls.problem(call), nil, `call {index}`)
	end
end)

Spec.test("refuses a call Roblox could not take, and says why", function()
	const cases: { { any } } = {
		{ "a call", "a call must be a table" },
		{ { kind = "loud" }, "no kind of call is called loud" },
		{ Calls.custom(""), "a custom event needs a name" },
		{ Calls.custom("Fed", 0 / 0), "a custom value must be a finite number" },
		{ Calls.custom("Fed", math.huge), "a custom value must be a finite number" },
		{ Calls.progression("", "start", 1), "a progression needs a path" },
		{
			{ kind = "progression", path = "N", status = "begin", level = 1 },
			"a progression's status is start, complete or fail",
		},
		{ Calls.progression("N", "start", 0), "a progression's level is a whole number from 1" },
		{ Calls.progression("N", "start", 1.5), "a progression's level is a whole number from 1" },
		{ Calls.progression("N", "start", 1, ""), "a level's name must be a non-empty string" },
		{ Calls.funnel("", 1, "a"), "a funnel step needs its funnel" },
		{ Calls.funnel("F", 0, "a"), "a funnel's step is a whole number from 1 to 100" },
		{ Calls.funnel("F", 101, "a"), "a funnel's step is a whole number from 1 to 100" },
		{ Calls.funnel("F", 2.5, "a"), "a funnel's step is a whole number from 1 to 100" },
		{ Calls.funnel("F", 1, ""), "a funnel step needs a name" },
		{ Calls.funnel("F", 1, "a", ""), "a funnel's session must be a non-empty string" },
		{ Calls.onboarding(""), "an onboarding step needs its name" },
		{
			{ kind = "economy", flow = "in", currency = "C", amount = 1, balance = 0, transaction = "T" },
			"an economy flow is source or sink",
		},
		{ Calls.economy("sink", "", 1, 0, "T"), "an economy call needs a currency" },
		{ Calls.economy("sink", "C", 0, 0, "T"), "an economy amount is a finite number above 0" },
		{ Calls.economy("sink", "C", 0 / 0, 0, "T"), "an economy amount is a finite number above 0" },
		{ Calls.economy("sink", "C", 1, -1, "T"), "an economy balance is a finite number from 0" },
		{ Calls.economy("sink", "C", 1, math.huge, "T"), "an economy balance is a finite number from 0" },
		{ Calls.economy("sink", "C", 1, 0, ""), "an economy call needs a transaction type" },
		{ Calls.economy("sink", "C", 1, 0, "T", ""), "an economy item must be a non-empty string" },
		{ Calls.journey("", "n"), "a journey call needs its journey and its node" },
		{ Calls.journey("j", ""), "a journey call needs its journey and its node" },
		{ Calls.journey("j", "n", ""), "a journey's session must be a non-empty string" },
		{ Calls.custom("Fed", 1, { [4] = "a" }), "field 4 is not 1, 2 or 3" },
		{ Calls.custom("Fed", 1, { [0] = "a" }), "field 0 is not 1, 2 or 3" },
		{ Calls.custom("Fed", 1, { [1] = "" }), "field 1 must be a non-empty string" },
		{ { kind = "custom", name = "Fed", fields = { [2] = 5 } }, "field 2 must be a non-empty string" },
		{ { kind = "custom", name = "Fed", fields = "a" }, "fields must be a table" },
	}
	for _, case in cases do
		Spec.equal(Calls.problem(case[1]), case[2], case[2])
	end
end)

Spec.test("a call's own fields go over the defaults, one by one, in a new table", function()
	const defaults = { [1] = "Crew_2", [2] = "D1_Day" }
	Spec.equal(Calls.merge(defaults, { [2] = "D3_Night", [3] = "Coal" }), { "Crew_2", "D3_Night", "Coal" })
	Spec.equal(defaults, { [1] = "Crew_2", [2] = "D1_Day" }, "the defaults are not changed")
	Spec.equal(Calls.merge(nil, nil), {}, "nothing")
	Spec.truthy(Calls.merge(defaults, nil) ~= defaults, "a copy, never the defaults themselves")
end)

return nil
