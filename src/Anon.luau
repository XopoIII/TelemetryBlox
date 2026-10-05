--!strict
--- The player's pseudonym, made before the row exists.
---
--- Every row about a player carries an `actor`. The obvious value is the player's UserId, a Roblox
--- account's permanent public identifier, and no question a game asks of its data needs it: funnels,
--- retention and per-player arcs need only that the same player gives the same token twice. That is
--- what this returns. The transform happens at the front door, inside `emit`, so the raw id never
--- enters the ring at all: not the shutdown flush, not a read-back, not an error dump.
---
--- THIS IS PSEUDONYMISATION, NOT ANONYMISATION. Anyone holding both the salt and a candidate UserId
--- can confirm a match by recomputing it; the id space is small enough to enumerate. What it buys is
--- that the stored data no longer contains account identifiers: a leaked database, a shared query
--- result or a screenshot carries no way back to a Roblox account. It is server-side, so no client
--- can read the salt or compute anyone's token.
---
--- Two things are deliberately not done. Hashing in the ingest instead: the raw id would still cross
--- the network. Rotating the salt: a pseudonym that changes breaks retention, and every cohort resets.
---
--- The salt is per game, and that is why it is an argument: a token computed for one game cannot be
--- joined against another's data.
const Hash = require("./Hash")

const Anon = {}

--> What every token starts with. It makes tokenising idempotent (a token handed back in is returned
--> unchanged, so a row derived from another does not hash a player twice into a second person), and
--> it makes an unhashed actor visible at a glance in a raw row.
Anon.PREFIX = "u_"

export type Anonymiser = {
	--> The stable pseudonym of one actor string. A token in gives the same token out.
	token: (value: string) -> string,
	--> The same, for a value that may be absent: nil in, nil out.
	actor: (value: string?) -> string?,
}

--> Builds one game's pseudonymiser. `salt` is that game's own and is never changed: changing it makes
--> every player a new one. Convention: `"<game>/telemetry/actor/v1:<8 hex>"`.
function Anon.new(salt: string): Anonymiser
	const prefix = Anon.PREFIX

	const function token(value: string): string
		if string.sub(value, 1, #prefix) == prefix then
			return value
		end
		return prefix .. Hash.token(salt, value)
	end

	const function actor(value: string?): string?
		if value == nil then
			return nil
		end
		return token(value)
	end

	return { token = token, actor = actor }
end

return Anon
