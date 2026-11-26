--[[
	Remote control: lets a local tool (for example an MCP server driven by an AI
	agent) switch which `rojo serve` this plugin is connected to.

	The plugin polls a control endpoint on 127.0.0.1 and reports its status with
	each poll; the endpoint answers with queued commands. Polling from the
	plugin side was chosen because Studio plugins cannot listen for incoming
	connections, and it keeps all state out of the DataModel so nothing ends up
	saved with the place.
]]

local HttpService = game:GetService("HttpService")

local Rojo = script:FindFirstAncestor("Rojo")
local Plugin = Rojo.Plugin
local Packages = Rojo.Packages

local Http = require(Packages.Http)
local Log = require(Packages.Log)

local Config = require(Plugin.Config)
local Version = require(Plugin.Version)
local protocol = require(script.protocol)

local RemoteControl = {}
RemoteControl.__index = RemoteControl

export type Handlers = {
	getStatus: () -> { [string]: any },
	connect: (host: string, port: string) -> (),
	disconnect: () -> (),
	confirm: (action: string) -> boolean,
}

function RemoteControl.new(options: { port: string, handlers: Handlers })
	local self = setmetatable({
		-- Identifies this Studio window to the control endpoint. A GUID per plugin
		-- load is enough: the endpoint forgets instances that stop polling.
		instanceId = HttpService:GenerateGUID(false),
		-- "localhost" matches the host Rojo itself uses, so Studio does not ask for a
		-- separate HTTP permission for this plugin.
		baseUrl = `http://localhost:{options.port}`,
		handlers = options.handlers,
		pendingResults = {},
		running = false,
		failures = 0,
	}, RemoteControl)

	return self
end

function RemoteControl:buildReport()
	local status = self.handlers.getStatus()

	return {
		protocolVersion = protocol.version,
		instanceId = self.instanceId,
		pluginVersion = Version.display(Config.version),
		placeName = game.Name,
		placeId = game.PlaceId,
		gameId = game.GameId,
		status = status,
		results = self.pendingResults,
	}
end

function RemoteControl:runCommand(rawCommand)
	local command, err = protocol.validateCommand(rawCommand)
	local id = if type(rawCommand) == "table" then rawCommand.id else nil

	if command == nil then
		Log.warn("Remote control rejected a command: {}", err)
		table.insert(self.pendingResults, { id = id, ok = false, error = err })
		return
	end

	Log.info("Remote control: {} {}", command.type, command.port or command.action or "")

	local ok, runErr = pcall(function()
		if command.type == "connect" then
			self.handlers.connect(command.host, command.port)
		elseif command.type == "disconnect" then
			self.handlers.disconnect()
		elseif command.type == "confirm" then
			if not self.handlers.confirm(command.action) then
				error("no sync is waiting for confirmation")
			end
		end
	end)

	table.insert(self.pendingResults, {
		id = command.id,
		ok = ok,
		error = if ok then nil else tostring(runErr),
	})
end

function RemoteControl:pollOnce()
	local report = self:buildReport()
	local sentResults = #self.pendingResults

	return Http.post(self.baseUrl .. "/plugin/poll", Http.jsonEncode(report)):andThen(function(response)
		-- Results are only dropped once the endpoint has seen them.
		for _ = 1, sentResults do
			table.remove(self.pendingResults, 1)
		end

		local body = Http.jsonDecode(response.body)
		if type(body) == "table" and type(body.commands) == "table" then
			for _, command in ipairs(body.commands) do
				self:runCommand(command)
			end
		end

		-- Report command results right away instead of after the next delay.
		return #self.pendingResults > 0
	end)
end

function RemoteControl:start()
	if self.running then
		return
	end
	self.running = true

	task.spawn(function()
		while self.running do
			local ok, hasMore = self:pollOnce():await()
			if ok then
				if self.failures > 0 then
					Log.trace("Remote control endpoint reachable at {}", self.baseUrl)
				end
				self.failures = 0
			else
				self.failures += 1
			end

			if not (ok and hasMore) then
				task.wait(protocol.nextPollDelay(self.failures))
			end
		end
	end)
end

function RemoteControl:stop()
	self.running = false
end

return RemoteControl
