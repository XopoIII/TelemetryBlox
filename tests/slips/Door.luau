--!strict
--- Mutants of the front door: each a small slip, and the rule it breaks.
--- Every `from` must occur exactly once in its file.
const Mutant = require("./Mutant")

const MUTANTS: { Mutant.Mutant } = {
	{
		file = "src/init.luau",
		from = 'if type(name) ~= "string" or resolved.priorities[name] == nil then',
		to = 'if type(name) ~= "string" then',
		breaks = "an event outside the vocabulary is refused",
	},
	{
		file = "src/init.luau",
		from = '\t\t\tif type(userId) ~= "number" then\n\t\t\t\treturn false\n\t\t\tend\n',
		to = "",
		breaks = "a player with no numeric id is refused",
	},
	{
		file = "src/init.luau",
		from = "actor = anon.token(tostring(userId))",
		to = "actor = tostring(userId)",
		breaks = "no user id enters a row",
	},
	{
		file = "src/init.luau",
		from = "if not ok or taken ~= true then",
		to = "if not ok then",
		breaks = "a refused call is counted",
	},
	{
		file = "src/init.luau",
		from = "const ok, taken = pcall(record, name, player, context)",
		to = "const ok, taken = true, record(name, player, context)",
		breaks = "emit cannot raise",
	},
	{
		file = "src/init.luau",
		from = "const ok, problem = pcall(listener, name, player, kept)",
		to = "const ok, problem = true, listener(name, player, kept)",
		breaks = "a listener that raises costs only itself",
	},
	{
		file = "src/init.luau",
		from = "world.warn = options.log or engine.warn",
		to = "world.warn = engine.warn",
		breaks = "a failed post is said to the game's own log",
	},
	{
		file = "src/init.luau",
		from = "const kept = Clean.context(context)",
		to = "const kept = context or {}",
		breaks = "a row keeps a clean copy of its context",
	},
	{
		file = "src/init.luau",
		from = "\t\tif started then\n\t\t\treturn\n\t\tend\n",
		to = "",
		breaks = "start works once",
	},
	{
		file = "src/init.luau",
		from = "\t\tworld.spawn(pipe.run)\n",
		to = "",
		breaks = "start spawns the flusher",
	},
	{
		file = "src/init.luau",
		from = "\t\tworld.onClose(self.drain)\n",
		to = "",
		breaks = "start binds the drain",
	},
	{
		file = "src/init.luau",
		from = "\t\tif capturing then\n\t\t\treturn\n\t\tend\n",
		to = "",
		breaks = "errors are captured once",
	},
	{
		file = "src/init.luau",
		from = "return world.playerCount() == 0",
		to = "return true",
		breaks = "the drain waits for the players to be gone",
	},
	{
		file = "src/init.luau",
		from = "\t\tpipe.reportDrops()\n\t\treturn pipe.flushOnce()",
		to = "\t\treturn pipe.flushOnce()",
		breaks = "a flush says the losses in its batch",
	},
	{
		file = "src/init.luau",
		from = "table.remove(listeners, index)",
		to = "table.remove(listeners, index + 1)",
		breaks = "a stopped listener hears nothing more",
	},
	{
		file = "src/init.luau",
		from = "return anon.token(tostring(userId))",
		to = "return tostring(userId)",
		breaks = "the pseudonym asked for by id is a pseudonym",
	},
	{
		file = "src/init.luau",
		from = "self.destination = resolved.pipe.destination",
		to = 'self.destination = options.endpoint or ""',
		breaks = "the destination said is where batches really go",
	},
	{
		file = "src/init.luau",
		from = "write(event, nil, report)",
		to = "write(event, nil, {})",
		breaks = "an error row carries its message, script, trace and count",
	},
	{
		file = "src/init.luau",
		from = 'if type(event) ~= "string" or resolved.priorities[event] == nil then',
		to = 'if type(event) ~= "string" then',
		breaks = "an error event outside the vocabulary is an error at boot",
	},
	{
		file = "src/init.luau",
		from = "for _, listener in listeners do",
		to = "for _, listener in {} do",
		breaks = "a listener hears every row",
	},
}

return MUTANTS
