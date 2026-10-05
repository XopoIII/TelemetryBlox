--!strict
--- The few assertions every spec is written in.
---
--- A spec is `Spec.test(name, fn)`; inside it, checks name exact values. `equal` compares deeply and
--- reports the path of the first difference (`value.items[3].name`), so a failure says where, not
--- only that. `throws` requires an error AND checks its text, so a spec cannot pass because the code
--- failed for some other reason.
const process = require("@lune/process")
const stdio = require("@lune/stdio")

const Spec = {}

local passed, failed = 0, 0

const function render(value: any): string
	if type(value) == "string" then
		return string.format("%q", value)
	end
	return tostring(value)
end

-- Returns nil when equal, else a description of the first difference under `path`.
const function difference(actual: any, expected: any, path: string, seen: { [any]: any }): string?
	if type(actual) ~= "table" or type(expected) ~= "table" then
		if actual == expected or (actual ~= actual and expected ~= expected) then
			return nil
		end
		return `{path}: expected {render(expected)}, got {render(actual)}`
	end
	if seen[actual] == expected then
		return nil
	end
	seen[actual] = expected
	for key, value in expected do
		local problem = difference(actual[key], value, `{path}[{render(key)}]`, seen)
		if problem then
			return problem
		end
	end
	for key, value in actual do
		if expected[key] == nil then
			return `{path}[{render(key)}]: unexpected {render(value)}`
		end
	end
	return nil
end

--> Fails unless `actual` deeply equals `expected`. NaN equals NaN; tables compare by content.
function Spec.equal(actual: any, expected: any, label: string?)
	local problem = difference(actual, expected, label or "value", {})
	if problem then
		error(problem, 2)
	end
end

--> Fails unless `value` is exactly true.
function Spec.truthy(value: any, label: string?)
	if value ~= true then
		error(`{label or "value"}: expected true, got {render(value)}`, 2)
	end
end

--> Fails unless `fn` throws an error whose text contains `fragment` (plain match, not a pattern).
function Spec.throws(fn: () -> (), fragment: string)
	local ok, message = pcall(fn)
	if ok then
		error(`expected an error containing {render(fragment)}, but nothing was thrown`, 2)
	end
	local text = tostring(message)
	if not string.find(text, fragment, 1, true) then
		error(`expected an error containing {render(fragment)}, got {render(text)}`, 2)
	end
end

--> Runs one named spec and records whether it passed.
function Spec.test(name: string, fn: () -> ())
	local message = ""
	const ok = xpcall(fn, function(problem: any)
		message = debug.traceback(tostring(problem), 2)
	end)
	if ok then
		passed += 1
		return
	end
	failed += 1
	stdio.ewrite(`{stdio.color("red")}FAIL{stdio.color("reset")} {name}\n{message}\n`)
end

--> Prints the totals and exits non-zero if anything failed or nothing ran.
function Spec.finish()
	if passed + failed == 0 then
		stdio.ewrite("No specs ran: a suite that checks nothing is not green.\n")
		process.exit(1)
	end
	if failed > 0 then
		stdio.ewrite(`\n{stdio.color("red")}{failed} failed{stdio.color("reset")}, {passed} passed\n`)
		process.exit(1)
	end
	print(`{stdio.color("green")}All {passed} specs passed{stdio.color("reset")}`)
end

return Spec
