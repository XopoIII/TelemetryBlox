--!strict
--- Mutants of the context copy: each a small slip, and the rule it breaks.
--- Every `from` must occur exactly once in its file.
const Mutant = require("./Mutant")

const MUTANTS: { Mutant.Mutant } = {
	{
		file = "src/Clean.luau",
		from = "if #text <= limit then",
		to = "if #text < limit then",
		breaks = "a string exactly at the limit is whole",
	},
	{
		file = "src/Clean.luau",
		from = "if following < 0x80 or following >= 0xC0 then",
		to = "if following < 0x80 then",
		breaks = "a cut before a character keeps what came before it",
	},
	{
		file = "src/Clean.luau",
		from = "if following < 0x80 or following >= 0xC0 then",
		to = "if true then",
		breaks = "a cut never splits a character",
	},
	{
		file = "src/Clean.luau",
		from = "return if Clean.finite(value) then value else nil",
		to = "return value",
		breaks = "a NaN or an infinity is left out",
	},
	{
		file = "src/Clean.luau",
		from = "return value == value and value ~= math.huge and value ~= -math.huge",
		to = "return value == value and value ~= math.huge",
		breaks = "minus infinity is not finite",
	},
	{
		file = "src/Clean.luau",
		from = "return value == value and value ~= math.huge and value ~= -math.huge",
		to = "return value ~= math.huge and value ~= -math.huge",
		breaks = "NaN is not finite",
	},
	{
		file = "src/Clean.luau",
		from = "return value == value and value ~= math.huge and value ~= -math.huge",
		to = "return value == value and value ~= -math.huge",
		breaks = "infinity is not finite",
	},
	{
		file = "src/Clean.luau",
		from = 'elseif kind == "table" and depth < limits.maxDepth then',
		to = 'elseif kind == "table" and depth <= limits.maxDepth then',
		breaks = "tables are kept to four levels",
	},
	{
		file = "src/Clean.luau",
		from = "out[index] = if value == nil then false else value",
		to = "out[index] = value",
		breaks = "a dropped array element keeps its place",
	},
	{
		file = "src/Clean.luau",
		from = 'for key, value in context do\n\t\tif type(key) == "string" then',
		to = "for key, value in context do\n\t\tif true then",
		breaks = "a context key is a string",
	},
	{
		file = "src/Clean.luau",
		from = 'for key, value in source do\n\t\tif type(key) == "string" then',
		to = "for key, value in source do\n\t\tif true then",
		breaks = "a nested key is a string",
	},
	{
		file = "src/Clean.luau",
		from = "return Clean.cut(value, limits.maxString)",
		to = "return value",
		breaks = "a long string is cut",
	},
	{
		file = "src/Clean.luau",
		from = "return Clean.cut(value, limits.maxString)",
		to = "return Clean.cut(value, Clean.MAX_STRING)",
		breaks = "a string is cut at the limit the game set",
	},
	{
		file = "src/Clean.luau",
		from = 'elseif kind == "table" and depth < limits.maxDepth then',
		to = 'elseif kind == "table" and depth < Clean.MAX_DEPTH then',
		breaks = "tables are kept to the depth the game set",
	},
	{
		file = "src/Clean.luau",
		from = "const within = limits or Clean.DEFAULTS",
		to = "const within = Clean.DEFAULTS",
		breaks = "the limits handed in are the ones the copy is made under",
	},
	{
		file = "src/Clean.luau",
		from = "Clean.MAX_DEPTH = 4",
		to = "Clean.MAX_DEPTH = 5",
		breaks = "four levels by default",
	},
	{
		file = "src/Clean.luau",
		from = "Clean.MAX_STRING = 1000",
		to = "Clean.MAX_STRING = 1001",
		breaks = "a string keeps 1000 bytes",
	},
	{
		file = "src/Clean.luau",
		from = "if length > 0 then",
		to = "if length > 1 then",
		breaks = "an array of one is an array",
	},
	{
		file = "src/Clean.luau",
		from = "out[key] = kept(value, 1, within)",
		to = "out[key] = kept(value, 2, within)",
		breaks = "the context is level one",
	},
	{
		file = "src/Clean.luau",
		from = "return copy(value, depth + 1, limits)",
		to = "return copy(value, depth, limits)",
		breaks = "each nested table is a level deeper",
	},
	{
		file = "src/Clean.luau",
		from = "return copy(value, depth + 1, limits)",
		to = "return value",
		breaks = "the row's copy is its own",
	},
	{
		file = "src/Clean.luau",
		from = 'elseif kind == "boolean" then\n\t\treturn value\n',
		to = 'elseif kind ~= "table" then\n\t\treturn value\n',
		breaks = "what cannot be written as JSON is left out",
	},
}

return MUTANTS
