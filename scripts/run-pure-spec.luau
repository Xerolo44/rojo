--[[
	Runs a TestEZ-style spec for a pure module (no engine access) under Lune,
	so it can be checked without Roblox Studio.

	Usage: lune run scripts/run-pure-spec.luau <module.lua> <module.spec.lua>
]]

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")

local modulePath, specPath = process.args[1], process.args[2]
assert(modulePath and specPath, "usage: run-pure-spec <module.lua> <module.spec.lua>")

local moduleName = string.match(modulePath, "([^/\\]+)%.lua$")
local moduleValue = luau.load(fs.readFile(modulePath), { debugName = modulePath })()

local failures, passes = 0, 0
local stack = {}

local function expect(actual)
	local assertion = {}
	assertion.to = assertion
	assertion.be = assertion
	function assertion.equal(expected)
		if actual ~= expected then
			error(`expected {tostring(expected)}, got {tostring(actual)}`, 2)
		end
	end
	function assertion.ok()
		if not actual then
			error(`expected a truthy value, got {tostring(actual)}`, 2)
		end
	end
	return assertion
end

local env = {
	script = { Parent = { [moduleName] = moduleValue } },
	require = function(value)
		return value
	end,
	expect = expect,
	describe = function(name, body)
		table.insert(stack, name)
		body()
		table.remove(stack)
	end,
	it = function(name, body)
		local label = table.concat(stack, " > ") .. " > " .. name
		local ok, err = pcall(body)
		if ok then
			passes += 1
			print("  ok   " .. label)
		else
			failures += 1
			print("  FAIL " .. label .. "\n       " .. tostring(err))
		end
	end,
}
setmetatable(env, { __index = _G })

local spec = luau.load(fs.readFile(specPath), { debugName = specPath, environment = env })()
spec()

print(`{passes} passed, {failures} failed`)
process.exit(if failures == 0 then 0 else 1)
