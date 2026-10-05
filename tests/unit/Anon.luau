--!strict
--- The pseudonym: the same player gives the same token on every machine, and never their id.
---
--- The tokens below are pinned. They were computed by this code and by Grabby Pit's copy of the hash
--- alike (2026-10-05): a change that moves one makes every player of every game a new one.
const Anon = require("@telemetryblox/Anon")
const Hash = require("@telemetryblox/Hash")
const Spec = require("../Spec")

const SALT = "example/telemetry/actor/v1:00000000"
const OTHER = "other/telemetry/actor/v1:11111111"

Spec.test("the hash's parts give the pinned words", function()
	Spec.equal(Hash.str32("abc"), 96354, "str32")
	Spec.equal(Hash.str32(""), 0, "str32 of nothing")
	Spec.equal(Hash.scramble(1), 1753845952, "scramble")
	Spec.equal(Hash.scramble(0), 0, "scramble of zero")
	-- The low 32 bits of (2^32 - 1)^2, which a plain multiply would round.
	Spec.equal(Hash.mul32(0xFFFFFFFF, 0xFFFFFFFF), 1, "mul32")
	Spec.equal(Hash.mix(1, 2), 305810056, "mix")
	Spec.equal(Hash.mix(2, 1) ~= Hash.mix(1, 2), true, "mix is ordered")
end)

Spec.test("a token is 16 hex digits, pinned for a salt and a value", function()
	Spec.equal(Hash.token(SALT, "123456789"), "b6143fd8f67c8ca4", "a user id")
	Spec.equal(Hash.token(SALT, "1"), "2d83cfbbab699b61", "id 1")
	Spec.equal(Hash.token(SALT, "2"), "413a98b1d0e370d1", "id 2")
	Spec.equal(Hash.token(SALT, "-1"), "9b4c2cc4b5b4e16f", "a test player's id")
	Spec.equal(Hash.token(SALT, "4611686018"), "8c2ff1cb4ecb25e2", "a ten-digit id")
	Spec.equal(Hash.token("", ""), "0000000041f39e5e", "nothing at all")
end)

Spec.test("another game's salt gives another token for the same player", function()
	Spec.equal(Hash.token(OTHER, "123456789"), "35cb39f414199b14", "the other game")
	Spec.equal(Hash.token(OTHER, "123456789") ~= Hash.token(SALT, "123456789"), true, "not joinable")
end)

Spec.test("an actor is the prefix and the token, and holds no digit run of the id", function()
	const anon = Anon.new(SALT)
	Spec.equal(Anon.PREFIX, "u_", "prefix")
	Spec.equal(anon.token("123456789"), "u_b6143fd8f67c8ca4", "token")
	Spec.equal(anon.actor("123456789"), "u_b6143fd8f67c8ca4", "actor")
	Spec.equal(#anon.token("123456789"), 18, "length")
	Spec.equal(string.find(anon.token("123456789"), "123456789", 1, true), nil, "the id is not in it")
	-- Stable, and different between players.
	Spec.equal(anon.token("1"), anon.token("1"), "stable")
	Spec.equal(anon.token("1") ~= anon.token("2"), true, "differs")
end)

Spec.test("a token handed back in comes out unchanged, and nothing gives nothing", function()
	const anon = Anon.new(SALT)
	Spec.equal(anon.token("u_b6143fd8f67c8ca4"), "u_b6143fd8f67c8ca4", "idempotent")
	Spec.equal(anon.token(anon.token("7")), anon.token("7"), "twice is once")
	Spec.equal(anon.actor(nil), nil, "nil in, nil out")
	-- Only the prefix marks a token: a value that merely contains it is hashed.
	Spec.equal(anon.token("xu_1"), "u_" .. Hash.token(SALT, "xu_1"), "the prefix is at the start")
	Spec.equal(anon.token("u"), "u_" .. Hash.token(SALT, "u"), "half a prefix is a value")
end)

return nil
