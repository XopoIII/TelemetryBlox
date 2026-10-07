--!strict
--- Mutants of the options: each a small slip, and the rule it breaks.
--- Every `from` must occur exactly once in its file.
const Mutant = require("./Mutant")

const MUTANTS: { Mutant.Mutant } = {
	{
		file = "src/Options.luau",
		from = "if isStudio or endpoint == nil then",
		to = "if endpoint == nil then",
		breaks = "Studio never sends",
	},
	{
		file = "src/Options.luau",
		from = "if isStudio or endpoint == nil then",
		to = "if isStudio then",
		breaks = "a server with no endpoint only collects",
	},
	{
		file = "src/Options.luau",
		from = '\tif isStudio then\n\t\treturn "studio"\n\tend\n',
		to = "",
		breaks = "Studio is always called studio",
	},
	{
		file = "src/Options.luau",
		from = 'return environment or "live"',
		to = 'return environment or "test"',
		breaks = "a server is live unless the game says otherwise",
	},
	{
		file = "src/Options.luau",
		from = 'return environment or "live"',
		to = 'return "live"',
		breaks = "the game's name for a test place is said",
	},
	{
		file = "src/Options.luau",
		from = 'priorities[dropEvent] = priorities[dropEvent] or "protected"',
		to = 'priorities[dropEvent] = "protected"',
		breaks = "the game's urgent drop event stands",
	},
	{
		file = "src/Options.luau",
		from = 'priorities[dropEvent] = priorities[dropEvent] or "protected"',
		to = 'priorities[dropEvent] = priorities[dropEvent] or "bulk"',
		breaks = "the drop event is protected by default",
	},
	{
		file = "src/Options.luau",
		from = 'if priorities[dropEvent] == "bulk" then',
		to = "if false then",
		breaks = "the drop event is never bulk",
	},
	{
		file = "src/Options.luau",
		from = "#environment > 16 then",
		to = "#environment > 15 then",
		breaks = "an environment may be sixteen letters",
	},
	{
		file = "src/Options.luau",
		from = "#environment > 16 then",
		to = "#environment > 17 then",
		breaks = "an environment is at most sixteen letters",
	},
	{
		file = "src/Options.luau",
		from = '"^%l[%l%d_-]*$"',
		to = '"^[%l%d_-]*$"',
		breaks = "an environment starts with a letter",
	},
	{
		file = "src/Options.luau",
		from = '"^%l[%l%d_-]*$"',
		to = '"^%l[%l%d_-]*"',
		breaks = "an environment is one word",
	},
	{
		file = "src/Options.luau",
		from = 'if environment == "studio" then',
		to = "if false then",
		breaks = "a game cannot call a server studio",
	},
	{
		file = "src/Options.luau",
		from = "value ~= value or value <= 0 or value == math.huge",
		to = "value ~= value or value < 0 or value == math.huge",
		breaks = "zero is not a positive number",
	},
	{
		file = "src/Options.luau",
		from = "value ~= value or value <= 0 or value == math.huge",
		to = "value <= 0 or value == math.huge",
		breaks = "NaN is not a positive number",
	},
	{
		file = "src/Options.luau",
		from = "value ~= value or value <= 0 or value == math.huge",
		to = "value ~= value or value <= 0",
		breaks = "infinity is not a usable number",
	},
	{
		file = "src/Options.luau",
		from = 'if type(value) ~= "number" or',
		to = "if",
		breaks = "a number given as text is refused",
	},
	{
		file = "src/Options.luau",
		from = 'if type(value) ~= "string" or value == "" then',
		to = 'if type(value) ~= "string" then',
		breaks = "an empty name is refused",
	},
	{
		file = "src/Options.luau",
		from = 'if type(name) ~= "string" or PRIORITIES[priority] ~= true then',
		to = "if PRIORITIES[priority] ~= true then",
		breaks = "an event name is a string",
	},
	{
		file = "src/Options.luau",
		from = 'if type(name) ~= "string" or PRIORITIES[priority] ~= true then',
		to = 'if type(name) ~= "string" then',
		breaks = "a priority is one of the three",
	},
	{
		file = "src/Options.luau",
		from = 'if options.endpoint ~= nil and type(options.endpoint) ~= "string" then',
		to = "if false then",
		breaks = "an endpoint is a string",
	},
	{
		file = "src/Options.luau",
		from = "\tflushSeconds = 180,",
		to = "\tflushSeconds = 120,",
		breaks = "a post every three minutes by default",
	},
	{
		file = "src/Options.luau",
		from = "\ttickSeconds = 60,",
		to = "\ttickSeconds = 30,",
		breaks = "a wake every minute by default",
	},
	{
		file = "src/Options.luau",
		from = "\tmaxBatch = 1000,",
		to = "\tmaxBatch = 500,",
		breaks = "a thousand rows a post by default",
	},
	{
		file = "src/Options.luau",
		from = "\tringSize = 2000,",
		to = "\tringSize = 1000,",
		breaks = "two thousand bulk rows by default",
	},
	{
		file = "src/Options.luau",
		from = "\tprotectedSize = 500,",
		to = "\tprotectedSize = 2000,",
		breaks = "five hundred protected rows by default",
	},
	{
		file = "src/Options.luau",
		from = "\tmaxTries = 3,",
		to = "\tmaxTries = 2,",
		breaks = "three posts a batch by default",
	},
	{
		file = "src/Options.luau",
		from = "\tcloseBudget = 20,",
		to = "\tcloseBudget = 30,",
		breaks = "a drain of twenty seconds by default",
	},
	{
		file = "src/Options.luau",
		from = "\tcloseQuiet = 2,",
		to = "\tcloseQuiet = 1,",
		breaks = "a quiet of two seconds by default",
	},
	{
		file = "src/Options.luau",
		from = 'maxString = positive(options.maxStringBytes, defaults.maxStringBytes, "maxStringBytes"),',
		to = "maxString = defaults.maxStringBytes,",
		breaks = "the game's string limit reaches the copy",
	},
	{
		file = "src/Options.luau",
		from = 'maxDepth = positive(options.maxDepth, defaults.maxDepth, "maxDepth"),',
		to = "maxDepth = defaults.maxDepth,",
		breaks = "the game's depth reaches the copy",
	},
	{
		file = "src/Options.luau",
		from = "placeVersion = options.placeVersion,",
		to = "placeVersion = nil,",
		breaks = "the game's place version reaches the pipe",
	},
	{
		file = "src/Options.luau",
		from = 'protectedSize = positive(options.protectedSize, defaults.protectedSize, "protectedSize"),',
		to = 'protectedSize = positive(options.ringSize, defaults.protectedSize, "protectedSize"),',
		breaks = "each ring has its own size",
	},
}

return MUTANTS
