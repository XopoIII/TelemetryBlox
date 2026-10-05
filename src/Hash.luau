--!strict
--- Deterministic 32-bit hash primitives, behind the player's pseudonym (`Anon`).
---
--- Pure and total: the same input gives the same output on every machine, in every run. A change to
--- any line here changes every pseudonym, which makes every player a new one in every game's data;
--- `tests/unit/Hash.luau` pins the exact tokens for that reason.
---
--- Not a cryptographic hash and never to be used as one. It is a mixer: it spreads inputs evenly and
--- hides the arithmetic relationship between neighbouring inputs, nothing more.
const Hash = {}

--> 32-bit multiply, done in 16-bit halves so every intermediate stays under 2^33 and the doubles
--> remain exact. A plain `a * b` on two 32-bit words reaches 2^64 and silently rounds, which would
--> make the result differ between machines.
function Hash.mul32(a: number, b: number): number
	const ah, al = bit32.rshift(a, 16), bit32.band(a, 0xFFFF)
	const bh, bl = bit32.rshift(b, 16), bit32.band(b, 0xFFFF)
	const mid = bit32.band(ah * bl + al * bh, 0xFFFF)
	return bit32.band(al * bl + mid * 0x10000, 0xFFFFFFFF)
end

--> An avalanche (the xorshift-multiply finalizer): one bit of input changes about half the output
--> bits, so two neighbouring user ids do not produce two neighbouring tokens.
function Hash.scramble(value: number): number
	local x = value
	x = bit32.bxor(x, bit32.rshift(x, 16))
	x = Hash.mul32(x, 0x7feb352d)
	x = bit32.bxor(x, bit32.rshift(x, 15))
	x = Hash.mul32(x, 0x846ca68b)
	x = bit32.bxor(x, bit32.rshift(x, 16))
	return x
end

--> A stable 32-bit hash of a string. Multiplier 31, so every intermediate stays under 2^53 and the
--> double arithmetic is exact.
-->
--> On its own this is a polynomial hash and it splits over concatenation, so a compound key is never
--> built by concatenating and hashing once: hash the parts and combine them with `Hash.mix`.
function Hash.str32(text: string): number
	local h = 0
	for index = 1, #text do
		h = bit32.band(h * 31 + string.byte(text, index), 0xFFFFFFFF)
	end
	return h
end

--> Combines two already-hashed words into one, with an avalanche on the way in and on the way out.
function Hash.mix(a: number, b: number): number
	return Hash.scramble(bit32.bxor(a, Hash.scramble(b)))
end

--> A 64-bit token as 16 lowercase hex digits, derived from a key and a value.
-->
--> 64 bits because a collision merges two people's rows into one player who did impossible things: at
--> 32 bits and ten thousand players the birthday bound is about 1.2%, at 64 bits about 3 in 10^12.
--> The two halves use different derivations of the key, so they are independent.
function Hash.token(key: string, value: string): string
	const k = Hash.str32(key)
	const v = Hash.str32(value)
	const hi = Hash.mix(v, k)
	const lo = Hash.mix(Hash.mix(v, Hash.scramble(k + 0x9e3779b9)), hi)
	return string.format("%08x%08x", hi, lo)
end

return Hash
