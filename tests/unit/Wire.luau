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

-- WHAT THIS PROVES, AND WHAT IT DOES NOT. The row's copy keeps a mixed table's string keys beside
-- its array (`Clean`), and that is what `recent()` and a listener read. What goes out is the
-- encoder's to say, and JSON has no table that is both: the encoder HERE is LuneBlox's
-- (`serde.encode`, in the fake server), and it writes the array part alone. On Roblox the encoder
-- is `HttpService:JSONEncode` (`src/RobloxServices.luau`), which is documented to do the same and
-- has not been run by anything in this repository. So this pins LuneBlox's answer as LuneBlox's,
-- and the two facts a game can rely on whatever the engine does: the post is made, and the array
-- part arrives.
Spec.test("a mixed table is whole in the row's copy and leaves LuneBlox's encoder as its array", function()
	const world = World.new()
	const telemetry = Example.make(world)
	const mixed: { [any]: any } = { 10, 20 }
	mixed.name = "x"
	telemetry.emit("feed", nil, { mixed = mixed, plain = { name = "y" } })
	const both: { [any]: any } = { 10, 20 }
	both.name = "x"
	Spec.equal(telemetry.recent()[1].ctx, { mixed = both, plain = { name = "y" } }, "the row's copy keeps both halves")
	Spec.equal(telemetry.flush(), true, "posted: a mixed table does not cost the batch")
	Spec.truthy(string.find(world.posts[1].body, '"mixed":[10,20]', 1, true) ~= nil, "the body: the array alone")
	Spec.equal(
		world.posts[1].envelope.events[1].ctx,
		{ mixed = { 10, 20 }, plain = { name = "y" } },
		"as LuneBlox encodes it: the string key of the mixed table is not on the wire"
	)
end)

return nil
