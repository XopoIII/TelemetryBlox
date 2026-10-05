--!strict
--- Server errors as rows: loud at first, then one row an order of magnitude, and bounded.
const ErrorReporter = require("@telemetryblox/ErrorReporter")
const Spec = require("../Spec")

const function reporter(
	config: { loud: number?, maxDistinct: number? }?
): (ErrorReporter.Reporter, { ErrorReporter.Report })
	const reports: { ErrorReporter.Report } = {}
	const settings: { loud: number?, maxDistinct: number? } = config or {}
	return ErrorReporter.new({
		emit = function(report: ErrorReporter.Report)
			table.insert(reports, report)
		end,
		loud = settings.loud,
		maxDistinct = settings.maxDistinct,
	}),
		reports
end

Spec.test("the occurrences reported are the first three and each power of ten", function()
	const reported: { number } = {}
	for count = 1, 1200 do
		if ErrorReporter.shouldReport(count, 3) then
			table.insert(reported, count)
		end
	end
	Spec.equal(reported, { 1, 2, 3, 10, 100, 1000 }, "the schedule")
	Spec.equal(ErrorReporter.isMilestone(1), false, "one is not a milestone")
	Spec.equal(ErrorReporter.isMilestone(10), true, "ten is")
	Spec.equal(ErrorReporter.isMilestone(20), false, "twenty is not")
	Spec.equal(ErrorReporter.isMilestone(10000), true, "ten thousand is")
	Spec.equal(ErrorReporter.shouldReport(4, 5), true, "a louder reporter")
	Spec.equal(ErrorReporter.shouldReport(6, 5), false, "past its loud ones")
end)

Spec.test("the head of a stack is its first four lines, joined", function()
	Spec.equal(ErrorReporter.headOf("a\nb\nc\nd\ne\nf"), "a | b | c | d", "four by default")
	Spec.equal(ErrorReporter.headOf("a\nb\nc", 2), "a | b", "as many as asked")
	Spec.equal(ErrorReporter.headOf("a\n\nb"), "a | b", "blank lines are skipped")
	Spec.equal(ErrorReporter.headOf("only"), "only", "one line")
	Spec.equal(ErrorReporter.headOf(""), "", "nothing")
	Spec.equal(ErrorReporter.headOf(nil), "", "no trace at all")
end)

Spec.test("an error storm is a handful of rows, each with its count", function()
	const errors, reports = reporter()
	for _ = 1, 150 do
		errors.report("attempt to index nil", "Script:12\nScript:40", "Server.World")
	end
	Spec.equal(errors.count(), 150, "all were seen")
	Spec.equal(errors.distinct(), 1, "one message")
	Spec.equal(#reports, 5, "five rows")
	Spec.equal(reports[1], {
		message = "attempt to index nil",
		script = "Server.World",
		trace = "Script:12 | Script:40",
		count = 1,
	}, "the first")
	Spec.equal({ reports[2].count, reports[3].count, reports[4].count, reports[5].count }, { 2, 3, 10, 100 }, "counts")
end)

Spec.test("each message is counted on its own, and a missing script reads as a question mark", function()
	const errors, reports = reporter()
	errors.report("one", nil, nil)
	errors.report("two", "t", "S")
	errors.report("one", nil, nil)
	Spec.equal(errors.distinct(), 2, "two messages")
	Spec.equal(reports[1], { message = "one", script = "?", trace = "", count = 1 }, "no script, no trace")
	Spec.equal(reports[2].count, 1, "the other message starts at one")
	Spec.equal(reports[3].count, 2, "the first message goes on")
end)

Spec.test("past the cap a new message is still reported, as first seen every time", function()
	const errors, reports = reporter({ maxDistinct = 2, loud = 1 })
	errors.report("a")
	errors.report("b")
	errors.report("c")
	errors.report("c")
	errors.report("a")
	Spec.equal(errors.distinct(), 2, "the table stopped growing")
	Spec.equal(errors.count(), 5, "every error was seen")
	-- "c" is not tracked, so both of its occurrences read as the first; "a" is, so its second is quiet.
	const said: { string } = {}
	for _, report in reports do
		table.insert(said, `{report.message}{report.count}`)
	end
	Spec.equal(said, { "a1", "b1", "c1", "c1" }, "reports")
end)

return nil
