--!strict
--- A budget of calls: how many may be made in any sixty seconds. Roblox's own analytics allows a
--- server so many calls a minute and more for each player; a call past it is lost at Roblox's end,
--- unseen. This counts them here, so what does not fit is dropped and counted, never queued.
---
--- A call costs constant time: the stamps are a queue read from its head.
const Budget = {}

--> The window, in seconds.
Budget.WINDOW = 60

export type Budget = {
	--> Whether a call may be made at `now` (seconds that only move forward), which counts it if so.
	--> `extra` widens the window's limit, for the players on the server.
	take: (now: number, extra: number?) -> boolean,
	--> How many were refused since this was last asked, which sets the count back to none.
	dropped: () -> number,
}

--> A budget of `limit` calls in any `Budget.WINDOW` seconds.
function Budget.new(limit: number): Budget
	const stamps: { [number]: number } = {}
	local head, tail = 1, 0
	local refused = 0
	const self = {} :: Budget

	function self.take(now: number, extra: number?): boolean
		while head <= tail and now - stamps[head] >= Budget.WINDOW do
			stamps[head] = nil
			head += 1
		end
		if head > tail then
			head, tail = 1, 0
		end
		if tail - head + 1 >= limit + (extra or 0) then
			refused += 1
			return false
		end
		tail += 1
		stamps[tail] = now
		return true
	end

	function self.dropped(): number
		const count = refused
		refused = 0
		return count
	end

	return self
end

return Budget
