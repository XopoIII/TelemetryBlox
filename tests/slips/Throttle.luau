--!strict
--- Mutants of the pipe's answer to a 429 or a 5xx: each a small slip, and the rule it breaks.
--- Every `from` must occur exactly once in its file.
const Mutant = require("./Mutant")

const MUTANTS: { Mutant.Mutant } = {
	{
		file = "src/Pipe.luau",
		from = "if askingForTime(status) and waits < Pipe.MAX_WAITS then",
		to = "if false then",
		breaks = "an answer asking for time does not cost a try",
	},
	{
		file = "src/Pipe.luau",
		from = "if askingForTime(status) and waits < Pipe.MAX_WAITS then",
		to = "if status == Pipe.TOO_MANY_REQUESTS and waits < Pipe.MAX_WAITS then",
		breaks = "a 5xx waits like a 429, not only a 429",
	},
	{
		file = "src/Pipe.luau",
		from = "if askingForTime(status) and waits < Pipe.MAX_WAITS then",
		to = "if status ~= nil and waits < Pipe.MAX_WAITS then",
		breaks = "only a 429 or a 5xx waits: a 4xx costs a try",
	},
	{
		file = "src/Pipe.luau",
		from = "if askingForTime(status) and waits < Pipe.MAX_WAITS then",
		to = "if askingForTime(status) then",
		breaks = "the waits of one batch are bounded",
	},
	{
		file = "src/Pipe.luau",
		from = "if askingForTime(status) and waits < Pipe.MAX_WAITS then",
		to = "if askingForTime(status) and waits <= Pipe.MAX_WAITS then",
		breaks = "a batch waits ten posts, not eleven",
	},
	{
		file = "src/Pipe.luau",
		from = "\t\t\twaits += 1\n",
		to = "",
		breaks = "a wait is counted",
	},
	{
		file = "src/Pipe.luau",
		from = "Pipe.MAX_WAITS = 10",
		to = "Pipe.MAX_WAITS = 9",
		breaks = "a batch waits ten posts, not nine",
	},
	{
		file = "src/Pipe.luau",
		from = "Pipe.TOO_MANY_REQUESTS = 429",
		to = "Pipe.TOO_MANY_REQUESTS = 503",
		breaks = "the status that waits is 429",
	},
	{
		file = "src/Pipe.luau",
		from = "\t\t\twaits = 0\n\t\t\theld = nil\n",
		to = "\t\t\theld = nil\n",
		breaks = "the waits start again once a batch is taken",
	},
	{
		file = "src/Pipe.luau",
		from = "\t\twaits = 0\n\t\theld = nil\n\t\ttries = 0\n\t\tring.addUnsent",
		to = "\t\theld = nil\n\t\ttries = 0\n\t\tring.addUnsent",
		breaks = "the waits start again once a batch is lost",
	},
	{
		file = "src/Pipe.luau",
		from = "return false, `http {result.StatusCode}`, result.StatusCode",
		to = "return false, `http {result.StatusCode}`, nil",
		breaks = "the status of a refusal reaches the rule",
	},
	{
		file = "src/Pipe.luau",
		from = "\t\t\t\treason = lastReason,\n",
		to = "",
		breaks = "a loss names why the last post failed",
	},
	{
		file = "src/Pipe.luau",
		from = "\t\t\tlastReason = nil\n",
		to = "",
		breaks = "a post the ingest takes clears the remembered reason",
	},
}

return MUTANTS
