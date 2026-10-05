--!strict
--- The two halves agree: what the pipe posts is, to the field, the batch in `tests/wire/batch.json`,
--- and the Worker's tests ingest that same file (`worker/test/ingest.test.mjs`). A change to the wire
--- format breaks one of the two until both, and the README's "The wire", say the same.
const fs = require("@lune/fs")
const serde = require("@lune/serde")

const Example = require("@fakes/Example")
const Spec = require("../Spec")
const World = require("@fakes/World")

const FIXTURE = "tests/wire/batch.json"

Spec.test("a batch from the front door is the wire fixture, field for field", function()
	const world = World.new()
	const telemetry = Example.make(world)
	telemetry.emit("feed", Example.player(), { pieces = 3 })
	world.now += 30
	telemetry.emit("purchase", nil, { robux = 25 })
	world.now += 5
	Spec.equal(telemetry.flush(), true, "posted")
	Spec.equal(world.posts[1].envelope, serde.decode("json", fs.readFile(FIXTURE)), "the wire")
	Spec.equal(world.posts[1].headers["content-type"], "application/json", "as JSON")
end)

Spec.test("a batch that differs from the fixture in one field is seen to differ", function()
	const world = World.new()
	const telemetry = Example.make(world)
	telemetry.emit("feed", Example.player(), { pieces = 4 })
	world.now += 30
	telemetry.emit("purchase", nil, { robux = 25 })
	world.now += 5
	telemetry.flush()
	const fixture = serde.decode("json", fs.readFile(FIXTURE))
	Spec.throws(function()
		Spec.equal(world.posts[1].envelope, fixture, "the wire")
	end, 'the wire["events"][2]["ctx"]["pieces"]: expected 3, got 4')
end)

return nil
