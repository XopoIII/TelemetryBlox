--!strict
--- A budget of calls in any sixty seconds: what fits is counted, what does not is refused and counted.
const Budget = require("@telemetryblox/Budget")
const Spec = require("../Spec")

Spec.test("takes as many calls as its limit, and refuses the next", function()
	const budget = Budget.new(3)
	Spec.equal({ budget.take(0), budget.take(10), budget.take(20), budget.take(30) }, { true, true, true, false })
	Spec.equal(budget.dropped(), 1, "one refused")
	Spec.equal(budget.dropped(), 0, "the count begins again once asked")
end)

Spec.test("forgets a call sixty seconds after it, and not a moment before", function()
	const budget = Budget.new(3)
	budget.take(0)
	budget.take(10)
	budget.take(20)
	Spec.equal(budget.take(59.999), false, "the first is still in the window")
	Spec.equal(budget.take(60), true, "the first has left it")
	Spec.equal(budget.take(69.999), false, "the second is still in it")
	Spec.equal(budget.take(70), true, "the second has left it")
	Spec.equal(budget.dropped(), 2, "two refused")
end)

Spec.test("widens its limit by the extra it is given, and by no more", function()
	const budget = Budget.new(2)
	Spec.equal({ budget.take(0, 1), budget.take(0, 1), budget.take(0, 1), budget.take(0, 1) }, {
		true,
		true,
		true,
		false,
	})
	Spec.equal(budget.take(0, 2), true, "a wider window takes one more")
	Spec.equal(budget.take(0), false, "and the narrow one none")
end)

Spec.test("a refused call takes no place in the window", function()
	const budget = Budget.new(1)
	budget.take(0)
	for _ = 1, 5 do
		budget.take(30)
	end
	Spec.equal(budget.take(60), true, "only the first call was ever counted")
end)

Spec.test("keeps counting right over a long run", function()
	const budget = Budget.new(2)
	for minute = 0, 999 do
		const at = minute * 60
		Spec.equal(
			{ budget.take(at), budget.take(at + 1), budget.take(at + 2) },
			{ true, true, false },
			`minute {minute}`
		)
	end
	Spec.equal(budget.dropped(), 1000, "one refused a minute")
end)

return nil
