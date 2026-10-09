--!strict
--- What a row's context keeps: values a batch can carry, and a copy the caller cannot reach.
const Clean = require("@telemetryblox/Clean")
const Spec = require("../Spec")

Spec.test("strings, finite numbers and booleans are kept as they are", function()
	Spec.equal(Clean.context({ a = "x", b = 1.5, c = false, d = -7, e = "" }), {
		a = "x",
		b = 1.5,
		c = false,
		d = -7,
		e = "",
	}, "kept")
	Spec.equal(Clean.context(nil), {}, "nothing gives an empty context")
	Spec.equal(Clean.context({}), {}, "empty stays empty")
end)

Spec.test("a NaN and both infinities are left out, and the rest of the row stays", function()
	Spec.equal(Clean.context({ nan = 0 / 0, up = math.huge, down = -math.huge, coins = 5 }), { coins = 5 }, "left out")
	Spec.equal(Clean.finite(0 / 0), false, "NaN")
	Spec.equal(Clean.finite(math.huge), false, "infinity")
	Spec.equal(Clean.finite(-math.huge), false, "minus infinity")
	Spec.equal(Clean.finite(1e308), true, "a huge number is still a number")
	Spec.equal(Clean.finite(0), true, "zero")
end)

Spec.test("what cannot be written as JSON is left out", function()
	const context: { [any]: any } = {
		fn = function() end,
		thread = coroutine.create(function() end),
		buffer = buffer.create(4),
		kept = true,
	}
	Spec.equal(Clean.context(context), { kept = true }, "left out")
end)

Spec.test("a key that is not a string is left out", function()
	const context: { [any]: any } = { [true] = 1, name = "x" }
	Spec.equal(Clean.context(context), { name = "x" }, "boolean key")
	-- An array handed in as the context itself has no names for its values: nothing is kept.
	Spec.equal(Clean.context({ "a", "b" }), {}, "an array is not a context")
	const inner: { [any]: any } = { [true] = 1, name = "y" }
	Spec.equal(Clean.context({ inner = inner }), { inner = { name = "y" } }, "nor in a nested table")
	-- An array of one is still an array.
	Spec.equal(Clean.context({ list = { "only" } }), { list = { "only" } }, "one element")
end)

Spec.test("nested tables are copied to four levels and dropped past that", function()
	const deep = { l2 = { l3 = { l4 = { l5 = { never = 1 }, at = 4 }, at = 3 }, at = 2 }, at = 1 }
	Spec.equal(Clean.context(deep), { l2 = { l3 = { l4 = { at = 4 }, at = 3 }, at = 2 }, at = 1 }, "four levels")
	Spec.equal(Clean.MAX_DEPTH, 4, "the depth")
end)

Spec.test("an array is kept as an array, and a dropped element keeps its place as false", function()
	Spec.equal(Clean.context({ list = { 1, "two", true } }), { list = { 1, "two", true } }, "array")
	Spec.equal(Clean.context({ list = { 1, 0 / 0, 3 } }), { list = { 1, false, 3 } }, "a hole would end the array")
	-- A table with an array part keeps both: the array, and its named fields beside it.
	const mixed: { [any]: any } = { 10, 20 }
	mixed.name = "x"
	const both: { [any]: any } = { 10, 20 }
	both.name = "x"
	Spec.equal(Clean.context({ mixed = mixed }), { mixed = both }, "mixed")
	-- ...and a dropped value in either half is still dropped.
	mixed.extra = 0 / 0
	Spec.equal(Clean.context({ mixed = mixed }), { mixed = both }, "a NaN is out of both halves")
end)

Spec.test("the row's copy is its own: the caller's table is not kept and not changed", function()
	const inner = { n = 1 }
	const given = { inner = inner, bad = 0 / 0 }
	const kept = Clean.context(given)
	inner.n = 2
	given.inner = { n = 3 }
	Spec.equal(kept, { inner = { n = 1 } }, "the copy")
	Spec.equal(given.bad ~= given.bad, true, "the caller's NaN is still there")
end)

Spec.test("a long string is cut at 1000 bytes, and a short one is not", function()
	Spec.equal(Clean.MAX_STRING, 1000, "the limit")
	Spec.equal(#Clean.context({ s = string.rep("a", 1000) }).s, 1000, "at the limit")
	Spec.equal(#Clean.context({ s = string.rep("a", 1001) }).s, 1000, "one over")
	Spec.equal(Clean.cut("abcdef", 3), "abc", "plain cut")
	Spec.equal(Clean.cut("abc", 3), "abc", "exactly the limit")
	Spec.equal(Clean.cut("abc", 10), "abc", "under the limit")
end)

Spec.test("the limits handed in are the ones the copy is made under", function()
	Spec.equal(Clean.DEFAULTS, { maxString = 1000, maxDepth = 4 }, "the defaults")
	const long = string.rep("a", 5000)
	Spec.equal(#Clean.context({ s = long }, { maxString = 4000, maxDepth = 4 }).s, 4000, "a longer string")
	Spec.equal(#Clean.context({ s = long }, { maxString = 10, maxDepth = 4 }).s, 10, "a shorter one")
	Spec.equal(#Clean.context({ list = { long } }, { maxString = 7, maxDepth = 4 }).list[1], 7, "nested too")
	const deep = { l2 = { l3 = { l4 = { l5 = { l6 = { never = 1 }, at = 5 }, at = 4 }, at = 3 }, at = 2 }, at = 1 }
	Spec.equal(
		Clean.context(deep, { maxString = 1000, maxDepth = 5 }),
		{ l2 = { l3 = { l4 = { l5 = { at = 5 }, at = 4 }, at = 3 }, at = 2 }, at = 1 },
		"a level deeper"
	)
	Spec.equal(Clean.context(deep, { maxString = 1000, maxDepth = 2 }), { l2 = { at = 2 }, at = 1 }, "shallower")
	Spec.equal(Clean.context(deep, { maxString = 1000, maxDepth = 1 }), { at = 1 }, "the context alone")
end)

Spec.test("a cut never splits a UTF-8 character", function()
	-- "a", then a two-byte character (C3 A9), then "b".
	const text = "a\u{E9}b"
	Spec.equal(#text, 4, "bytes")
	Spec.equal(Clean.cut(text, 2), "a", "the cut falls inside the character: it goes whole")
	Spec.equal(Clean.cut(text, 3), "a\u{E9}", "the cut falls after it: it stays")
	Spec.equal(Clean.cut(text, 1), "a", "before it")
	-- A three-byte character (E2 82 AC) cut after its first and its second byte.
	Spec.equal(Clean.cut("\u{20AC}x", 1), "", "one byte in")
	Spec.equal(Clean.cut("\u{20AC}x", 2), "", "two bytes in")
	Spec.equal(Clean.cut("\u{20AC}x", 3), "\u{20AC}", "whole")
end)

return nil
