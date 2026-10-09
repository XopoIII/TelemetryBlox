--!strict
--- What a row's context may hold, and the copy that holds only that.
---
--- A context is whatever the game hands `emit`, and one bad value must not cost a batch: a NaN or an
--- infinity makes the whole batch's JSON invalid, an Instance or a function cannot be encoded at all,
--- and one huge string can push a post past the size the ingest accepts. So the row keeps a copy with
--- every such value left out, and the caller's own table is never touched or kept.
---
--- Kept: strings (cut at `maxString` bytes), finite numbers, booleans, and tables of these down to
--- `maxDepth` levels. A table keeps its array part (a dropped element's place is held by `false`)
--- and its string keys, both when it has both. Everything else is dropped from its row, silently:
--- the row itself still lands.
---
--- THE LIMITS ARE THE GAME'S TO SET (`Options.maxStringBytes`, `Options.maxDepth`): a game whose rows
--- carry long text (a whole error message, a chat line) raises the first, and pays for it in the size
--- of its posts.
const Clean = {}

--> Bytes of one string a row keeps, unless the game says otherwise.
Clean.MAX_STRING = 1000
--> Levels of nested tables a row keeps, unless the game says otherwise: the context is level 1.
Clean.MAX_DEPTH = 4

export type Limits = {
	--> Bytes of one string a row keeps.
	maxString: number,
	--> Levels of nested tables a row keeps: the context is level 1.
	maxDepth: number,
}

--> The limits a copy is made under when none are given.
Clean.DEFAULTS = table.freeze({ maxString = Clean.MAX_STRING, maxDepth = Clean.MAX_DEPTH }) :: Limits

--> Cuts `text` at `limit` bytes without splitting a UTF-8 character, which would make the JSON invalid.
function Clean.cut(text: string, limit: number): string
	if #text <= limit then
		return text
	end
	local stop = limit
	-- A byte of the form 10xxxxxx continues a character: step back until the cut falls before one starts.
	while stop > 0 do
		const following = string.byte(text, stop + 1)
		if following < 0x80 or following >= 0xC0 then
			break
		end
		stop -= 1
	end
	return string.sub(text, 1, stop)
end

--> Whether a number can be written as JSON: not NaN and not an infinity.
function Clean.finite(value: number): boolean
	return value == value and value ~= math.huge and value ~= -math.huge
end

local copy: (source: { [any]: any }, depth: number, limits: Limits) -> { [any]: any }

const function kept(value: any, depth: number, limits: Limits): any
	const kind = type(value)
	if kind == "string" then
		return Clean.cut(value, limits.maxString)
	elseif kind == "number" then
		return if Clean.finite(value) then value else nil
	elseif kind == "boolean" then
		return value
	elseif kind == "table" and depth < limits.maxDepth then
		return copy(value, depth + 1, limits)
	end
	return nil
end

function copy(source: { [any]: any }, depth: number, limits: Limits): { [any]: any }
	const out: { [any]: any } = {}
	const length = #source
	-- The array part: a dropped element would leave a hole, and a hole ends the array for the
	-- encoder, so its place is kept by `false`.
	for index = 1, length do
		const value = kept(source[index], depth, limits)
		out[index] = if value == nil then false else value
	end
	-- The string keys, in a table that has an array part too: dropping them would hide half a row.
	for key, value in source do
		if type(key) == "string" then
			out[key] = kept(value, depth, limits)
		end
	end
	return out
end

--> The copy of `context` a row keeps, under `limits` (`Clean.DEFAULTS` when none are given). Total:
--> nil gives an empty context.
function Clean.context(context: { [any]: any }?, limits: Limits?): { [string]: any }
	if context == nil then
		return {}
	end
	const within = limits or Clean.DEFAULTS
	const out: { [string]: any } = {}
	for key, value in context do
		if type(key) == "string" then
			out[key] = kept(value, 1, within)
		end
	end
	return out
end

return Clean
