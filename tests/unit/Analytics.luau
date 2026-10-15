--!strict
--- Roblox's own analytics, told what a game's rows mean: an onboarding step once a visit, a
--- funnel's run opened at its first step, and a call past the budget dropped and counted.
const Calls = require("@telemetryblox/Calls")
const Spec = require("../Spec")
const Told = require("@fakes/Told")

type Options = Told.Options

const ALICE, BOB = Told.ALICE, Told.BOB
const setup, calls, made = Told.setup, Told.calls, Told.made

Spec.test("a row about a player is told as its calls, in order, with the fields merged", function()
	const s = setup(function(options: Options)
		options.fields = function(player: Player): Calls.Fields
			return { [1] = `Crew_{(player :: any).UserId}`, [2] = "Day" }
		end
	end)
	s.analytics.handle(
		"row",
		ALICE,
		calls({ Calls.custom("Fed", nil, { [2] = "Night", [3] = "Coal" }), Calls.custom("Hurt", 4) })
	)
	Spec.equal(s.told[1].player, ALICE, "to the player of the row")
	Spec.equal(made(s), {
		{ kind = "custom", name = "Fed", value = 1, fields = { "Crew_1", "Night", "Coal" } },
		{ kind = "custom", name = "Hurt", value = 4, fields = { "Crew_1", "Day" } },
	})
	-- the negative case: a row about nobody is told nothing, and its map is not asked
	local asked = 0
	const quiet = setup(function(options: Options)
		options.map = function(): { Calls.Call }?
			asked += 1
			return { Calls.custom("Fed") }
		end
	end)
	quiet.analytics.handle("row", nil, {})
	Spec.equal({ #quiet.told, asked }, { 0, 0 }, "nothing for a row about nobody")
	quiet.analytics.handle("row", ALICE, {})
	Spec.equal({ #quiet.told, asked }, { 1, 1 }, "the same row about a player")
end)

Spec.test("an onboarding step is numbered by its place in the list, and told once a visit", function()
	const s = setup()
	s.analytics.handle("row", ALICE, calls({ Calls.onboarding("fed"), Calls.onboarding("joined") }))
	s.analytics.handle("row", ALICE, calls({ Calls.onboarding("fed") }))
	s.analytics.handle("row", BOB, calls({ Calls.onboarding("fed") }))
	Spec.equal(made(s), {
		{ kind = "onboarding", step = "fed", index = 2, fields = {} },
		{ kind = "onboarding", step = "joined", index = 1, fields = {} },
		{ kind = "onboarding", step = "fed", index = 2, fields = {} },
	})
	Spec.equal(s.told[3].player, BOB, "another player is told their own")
	-- a step the list does not have is no step
	s.analytics.handle("row", ALICE, calls({ Calls.onboarding("swam"), Calls.onboarding("swam") }))
	Spec.equal({ #s.told, s.analytics.invalid() }, { 3, 2 }, "refused, both times")
	Spec.equal(s.warnings, {
		{
			id = "telemetry.analytics_invalid",
			context = { problem = "the onboarding step swam is not in `onboarding`" },
		},
	}, "said once")
end)

Spec.test("the leave event forgets a visit, after its own calls are made", function()
	const s = setup()
	s.analytics.handle("row", ALICE, calls({ Calls.onboarding("joined"), Calls.funnel("Shop", 1, "Opened") }))
	s.analytics.handle("leave", ALICE, calls({ Calls.onboarding("joined"), Calls.funnel("Shop", 2, "Prompt") }))
	Spec.equal(#s.told, 3, "the leave's own step was already told; its funnel step was not")
	Spec.equal(s.told[3].call.session, "job-1", "the leave's call is of the run it ends")
	s.analytics.handle("row", ALICE, calls({ Calls.onboarding("joined"), Calls.funnel("Shop", 2, "Prompt") }))
	Spec.equal(#s.told, 5, "a new visit is told again")
	Spec.equal(s.told[5].call.session, "job-2", "in a run of its own")
	-- the negative case: another row forgets nothing
	s.analytics.handle("row", ALICE, calls({ Calls.onboarding("joined") }))
	Spec.equal(#s.told, 5, "still told")
	s.analytics.forget(ALICE)
	s.analytics.tell(ALICE, { Calls.onboarding("joined") })
	Spec.equal(#s.told, 6, "forgotten by hand")
end)

Spec.test("a funnel's run opens at its first step and is each player's own", function()
	const s = setup()
	s.analytics.handle("row", ALICE, calls({ Calls.funnel("Shop", 2, "Prompt") }))
	s.analytics.handle("row", ALICE, calls({ Calls.funnel("Shop", 3, "Purchase") }))
	s.analytics.handle("row", BOB, calls({ Calls.funnel("Shop", 3, "Purchase") }))
	s.analytics.handle("row", ALICE, calls({ Calls.funnel("Shop", 1, "Opened"), Calls.funnel("Shop", 2, "Prompt") }))
	s.analytics.handle(
		"row",
		ALICE,
		calls({ Calls.funnel("Board", 2, "Read"), Calls.funnel("Shop", 3, "Purchase", "mine") })
	)
	const sessions = {}
	for _, call in made(s) do
		table.insert(sessions, call.session)
	end
	Spec.equal(sessions, { "job-1", "job-1", "job-2", "job-3", "job-3", "job-4", "mine" })
end)

Spec.test("a call past the budget is dropped and counted, and an onboarding step is tried again", function()
	const s = setup(function(options: Options)
		options.limit = 2
		options.perPlayer = 1
	end)
	s.analytics.handle("row", ALICE, calls({ Calls.custom("A"), Calls.custom("B"), Calls.custom("C") }))
	Spec.equal(#s.told, 3, "two and one for the player")
	s.analytics.handle("row", ALICE, calls({ Calls.onboarding("joined") }))
	Spec.equal({ #s.told, s.analytics.dropped() }, { 3, 1 }, "the fourth is dropped")
	s.at.players = 2
	s.analytics.handle("row", ALICE, calls({ Calls.onboarding("joined"), Calls.onboarding("joined") }))
	Spec.equal({ #s.told, s.analytics.dropped() }, { 4, 1 }, "a second player widens the budget by one")
	Spec.equal(s.told[4].call.index, 1, "the refused step, the next time it came")
	s.at.clock += 60
	s.analytics.handle(
		"row",
		ALICE,
		calls({ Calls.custom("A"), Calls.custom("B"), Calls.custom("C"), Calls.custom("D") })
	)
	Spec.equal(#s.told, 8, "a minute later the window is empty again")
end)

return nil
