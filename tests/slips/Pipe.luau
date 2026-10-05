--!strict
--- Mutants of the pipe: each a small slip, and the rule it breaks.
--- Every `from` must occur exactly once in its file.
const Mutant = require("./Mutant")

const MUTANTS: { Mutant.Mutant } = {
	{
		file = "src/Pipe.luau",
		from = "if tries < config.maxTries then",
		to = "if tries <= config.maxTries then",
		breaks = "a batch gets maxTries posts and no more",
	},
	{
		file = "src/Pipe.luau",
		from = "\t\t\theld = batch\n",
		to = "",
		breaks = "a refused batch is held for its retry",
	},
	{
		file = "src/Pipe.luau",
		from = "ring.addUnsent(#batch)",
		to = "ring.addUnsent(0)",
		breaks = "the rows of a lost batch are counted",
	},
	{
		file = "src/Pipe.luau",
		from = "\t\t\theld = nil\n\t\t\ttries = 0\n\t\t\treturn true",
		to = "\t\t\ttries = 0\n\t\t\treturn true",
		breaks = "a batch the ingest took is let go",
	},
	{
		file = "src/Pipe.luau",
		from = "\t\theld = nil\n\t\ttries = 0\n\t\tring.addUnsent",
		to = "\t\theld = nil\n\t\tring.addUnsent",
		breaks = "the tries start again for the next batch",
	},
	{
		file = "src/Pipe.luau",
		from = "\t\tif held then\n\t\t\tbatch = held\n\t\telseif",
		to = "\t\tif false then\n\t\t\tbatch = {}\n\t\telseif",
		breaks = "the retry is the same rows, not new ones",
	},
	{
		file = "src/Pipe.luau",
		from = "batch = ring.take(config.maxBatch)",
		to = "batch = ring.take(config.maxBatch + 1)",
		breaks = "a post carries at most maxBatch rows",
	},
	{
		file = "src/Pipe.luau",
		from = "or elapsed >= config.flushSeconds",
		to = "or elapsed > config.flushSeconds",
		breaks = "a post is due at three minutes exactly",
	},
	{
		file = "src/Pipe.luau",
		from = "held ~= nil or ring.urgent()",
		to = "held ~= nil",
		breaks = "an urgent row asks for an early post",
	},
	{
		file = "src/Pipe.luau",
		from = "return held ~= nil or ring.urgent()",
		to = "return ring.urgent()",
		breaks = "a held batch is retried on the next wake",
	},
	{
		file = "src/Pipe.luau",
		from = "ring.size() >= config.maxBatch / 2",
		to = "ring.size() >= config.maxBatch",
		breaks = "half a batch waiting asks for an early post",
	},
	{
		file = "src/Pipe.luau",
		from = "ring.size() >= config.maxBatch / 2",
		to = "ring.size() > config.maxBatch / 2",
		breaks = "exactly half a batch is enough",
	},
	{
		file = "src/Pipe.luau",
		from = "\t\t\tposted = services.clock()\n\t\t\tself.flushOnce()",
		to = "\t\t\tself.flushOnce()",
		breaks = "the three minutes are counted from the last post",
	},
	{
		file = "src/Pipe.luau",
		from = "function self.tick()\n\t\tself.reportDrops()\n",
		to = "function self.tick()\n",
		breaks = "a wake reports the losses",
	},
	{
		file = "src/Pipe.luau",
		from = "services.wait(config.tickSeconds)",
		to = "services.wait(config.flushSeconds)",
		breaks = "the flusher wakes every tick",
	},
	{
		file = "src/Pipe.luau",
		from = "\t\t\tif found then\n",
		to = "\t\t\tif true then\n",
		breaks = "a missing secret sends no key header",
	},
	{
		file = "src/Pipe.luau",
		from = "if result.Success == true then",
		to = "if result.Success ~= nil then",
		breaks = "a refusal by the ingest is a failed post",
	},
	{
		file = "src/Pipe.luau",
		from = "return false, `http {result.StatusCode}`",
		to = 'return false, "http"',
		breaks = "a refusal says its status",
	},
	{
		file = "src/Pipe.luau",
		from = "placeVersion = config.placeVersion or server.placeVersion",
		to = "placeVersion = server.placeVersion",
		breaks = "the game's place version is said when given",
	},
	{
		file = "src/Pipe.luau",
		from = "env = config.env,",
		to = 'env = "live",',
		breaks = "a batch says its own environment",
	},
	{
		file = "src/Pipe.luau",
		from = "serverStart = serverStart,",
		to = "serverStart = services.now(),",
		breaks = "a retry carries the same server start, which is the batch's identity",
	},
	{
		file = "src/Pipe.luau",
		from = '\t\tif config.destination == "" then\n\t\t\treturn false\n\t\tend\n',
		to = "",
		breaks = "a pipe with no destination posts nothing",
	},
	{
		file = "src/Pipe.luau",
		from = '\t\tif config.destination == "" then\n\t\t\treturn\n\t\tend\n',
		to = "",
		breaks = "a drain with no destination returns at once",
	},
	{
		file = "src/Pipe.luau",
		from = "services.clock() + config.closeBudget",
		to = "services.clock() + config.closeBudget * 2",
		breaks = "the drain stops at its budget",
	},
	{
		file = "src/Pipe.luau",
		from = "while services.clock() < deadline do",
		to = "while services.clock() <= deadline do",
		breaks = "the drain does not start a round at the deadline",
	},
	{
		file = "src/Pipe.luau",
		from = "services.wait(Pipe.CLOSE_RETRY_SECONDS)",
		to = "services.wait(Pipe.CLOSE_POLL_SECONDS)",
		breaks = "a refused post waits two seconds before the next",
	},
	{
		file = "src/Pipe.luau",
		from = "if services.clock() - since >= config.closeQuiet then",
		to = "if services.clock() - since > config.closeQuiet then",
		breaks = "the quiet ends at its length exactly",
	},
	{
		file = "src/Pipe.luau",
		from = "\t\t\t\tquietSince = nil\n\t\t\t\tif not self.flushOnce() then",
		to = "\t\t\t\tif not self.flushOnce() then",
		breaks = "a row in the quiet starts the quiet again",
	},
	{
		file = "src/Pipe.luau",
		from = "\t\t\t\tquietSince = nil\n\t\t\t\tservices.wait(Pipe.CLOSE_POLL_SECONDS)",
		to = "\t\t\t\tservices.wait(Pipe.CLOSE_POLL_SECONDS)",
		breaks = "a player seen again starts the quiet again",
	},
	{
		file = "src/Pipe.luau",
		from = "const since = quietSince or services.clock()",
		to = "const since = services.clock()",
		breaks = "the quiet is measured from when it began",
	},
	{
		file = "src/Pipe.luau",
		from = "elseif settled() then",
		to = "elseif true then",
		breaks = "the drain waits while players are still on",
	},
	{
		file = "src/Pipe.luau",
		from = "if count > 0 then",
		to = "if count >= 0 then",
		breaks = "no loss, no drop row",
	},
	{
		file = "src/Pipe.luau",
		from = "const count = evicted + unsent + refused",
		to = "const count = evicted + unsent",
		breaks = "the drop row's count is all three causes",
	},
	{
		file = "src/Pipe.luau",
		from = "send_failed = unsent,",
		to = "send_failed = evicted,",
		breaks = "the drop row says which loss was the ingest",
	},
	{
		file = "src/Pipe.luau",
		from = "refused = refused,",
		to = "refused = 0,",
		breaks = "the drop row says the refused calls",
	},
	{
		file = "src/Pipe.luau",
		from = "return ring.size() + (if held then #held else 0)",
		to = "return ring.size()",
		breaks = "a held batch is still waiting to leave",
	},
	{
		file = "src/Pipe.luau",
		from = "Pipe.CLOSE_POLL_SECONDS = 0.25",
		to = "Pipe.CLOSE_POLL_SECONDS = 0.5",
		breaks = "the drain looks every quarter second",
	},
	{
		file = "src/Pipe.luau",
		from = "Pipe.SCHEMA_VERSION = 1",
		to = "Pipe.SCHEMA_VERSION = 2",
		breaks = "the envelope is version 1",
	},
}

return MUTANTS
