--[[
	Pure helpers for the remote control protocol. Kept free of engine access
	so the rules (which commands and hosts are accepted) can be tested without
	Roblox Studio.
]]

local protocol = {}

protocol.version = 1

-- Only loopback hosts are accepted. The control endpoint is local, but a
-- command that points Studio at a remote server would let anything that can
-- reach the endpoint push code into the open place, so we refuse that outright.
-- Maps accepted spellings to the form used to build the server URL.
local LOOPBACK_HOSTS = {
	["localhost"] = "localhost",
	["127.0.0.1"] = "127.0.0.1",
	["::1"] = "[::1]",
	["[::1]"] = "[::1]",
}

local CONFIRM_ACTIONS = {
	Accept = true,
	Abort = true,
	Reject = true,
}

function protocol.normalizePort(port: any): (string?, string?)
	if type(port) == "number" then
		port = tostring(math.floor(port))
	end
	if type(port) ~= "string" or not string.match(port, "^%d+$") then
		return nil, "port must be a number"
	end
	local value = tonumber(port)
	if value == nil or value < 1 or value > 65535 then
		return nil, "port must be between 1 and 65535"
	end
	return tostring(value), nil
end

function protocol.normalizeHost(host: any): (string?, string?)
	if host == nil or host == "" then
		return "localhost", nil
	end
	if type(host) ~= "string" then
		return nil, "host must be a string"
	end
	local stripped = string.lower((string.gsub(host, "^https?://", "")))
	local canonical = LOOPBACK_HOSTS[stripped]
	if canonical == nil then
		return nil, `host '{host}' is not a loopback address (only localhost, 127.0.0.1 and ::1 are allowed)`
	end
	return canonical, nil
end

--[[
	Validates a command from the control endpoint. Returns a normalized copy or
	nil plus an error message. Unknown commands are rejected instead of
	ignored so the caller gets a clear answer.
]]
function protocol.validateCommand(command: any): (any?, string?)
	if type(command) ~= "table" then
		return nil, "command must be an object"
	end
	if type(command.id) ~= "string" or #command.id == 0 then
		return nil, "command id missing"
	end

	local kind = command.type
	if kind == "connect" then
		local port, portErr = protocol.normalizePort(command.port)
		if port == nil then
			return nil, portErr
		end
		local host, hostErr = protocol.normalizeHost(command.host)
		if host == nil then
			return nil, hostErr
		end
		return { id = command.id, type = "connect", host = host, port = port }, nil
	elseif kind == "disconnect" then
		return { id = command.id, type = "disconnect" }, nil
	elseif kind == "confirm" then
		if not CONFIRM_ACTIONS[command.action] then
			return nil, "confirm action must be Accept, Abort or Reject"
		end
		return { id = command.id, type = "confirm", action = command.action }, nil
	end

	return nil, `unknown command type '{tostring(kind)}'`
end

-- Poll interval: quick while the control endpoint answers, slow while nothing
-- is listening so an idle Studio doesn't spin on failed requests.
function protocol.nextPollDelay(consecutiveFailures: number): number
	if consecutiveFailures <= 0 then
		return 1
	end
	return math.min(2 * consecutiveFailures, 10)
end

return protocol
