--!strict
--- Which Luau runtime runs the suite, and whether it is the one rokit.toml pins.
---
--- The suite is meant for LuneBlox: Lune running the Luau version Roblox runs, with Roblox's fast
--- flags. On another runtime the specs still run, but a result there checks a VM no game runs, so it
--- says so loudly instead of quietly passing.
const fs = require("@lune/fs")
const stdio = require("@lune/stdio")

const Runtime = {}

const function pinned(): string?
	if not fs.isFile("rokit.toml") then
		return nil
	end
	return string.match(fs.readFile("rokit.toml"), 'luneblox%s*=%s*"XopoIII/LuneBlox@([%w%.%-]+)"')
end

--> Warns on stderr unless this is LuneBlox at the pinned version.
function Runtime.notice()
	local name, version = string.match(_VERSION, "^(%a+) ([^+]+)")
	local expected = pinned()
	if name == "LuneBlox" and (expected == nil or expected == version) then
		return
	end
	local found = if name then `{name} {version}` else _VERSION
	stdio.ewrite(
		`{stdio.color("yellow")}This is {found}; the suite is meant for LuneBlox {expected or ""}.\n`
			.. `Results here may differ from Roblox. Run \`rokit install\` and \`luneblox run tests/Run\`.`
			.. `{stdio.color("reset")}\n`
	)
end

return Runtime
