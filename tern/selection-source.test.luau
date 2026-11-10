local selectionSource = require("./selection-source")

local checks = 0
local function equal(actual, expected)
	assert(actual == expected, "expected " .. tostring(expected) .. ", got " .. tostring(actual))
	checks += 1
end

local agent = { pane = 1, kind = "agent", tab = 10 }
local peek = { pane = 2, kind = "file", tab = 10 }
local function fixture(panes, ranges, chat)
	local cx = { session = {} }
	function cx.session:panes()
		return panes
	end

	function cx.session:selection()
		return chat and { pane = agent.pane, text = chat } or nil
	end

	function cx.session:read(id)
		return { kind = "file", selection = ranges[id] }
	end

	return cx
end

-- The keyboard still belongs to OMP, but the selected quote belongs to a file pane.
do
	local cx = fixture({ agent, peek }, { [peek.pane] = { anchor = 2, head = 18 } })
	equal(selectionSource(cx, agent, 10).pane, peek.pane)
end

-- A current chat selection wins over a retained selection in a background file.
do
	local cx = fixture({ agent, peek }, { [peek.pane] = { anchor = 2, head = 18 } }, "chat quote")
	equal(selectionSource(cx, agent, 10).pane, agent.pane)
end

-- Hidden tabs, parked panes and exited blocks cannot become the quote source.
do
	local panes = {
		agent,
		{ pane = 3, kind = "file", tab = 11 },
		{ pane = 4, kind = "file", tab = 10, parked = true },
		{ pane = 5, kind = "file", tab = 10, exited = 0 },
		peek,
	}

	local ranges = {}
	for _, pane in ipairs(panes) do
		ranges[pane.pane] = { anchor = 0, head = 3 }
	end

	ranges[peek.pane] = { anchor = 2, head = 2 }
	equal(selectionSource(fixture(panes, ranges), agent, 10).pane, agent.pane)
end

-- Never guess which of two selected files should be sent to the agent.
do
	local second = { pane = 6, kind = "file", tab = 10 }
	local ranges = { [peek.pane] = { anchor = 2, head = 18 }, [second.pane] = { anchor = 0, head = 3 } }
	local ok = pcall(selectionSource, fixture({ agent, peek, second }, ranges), agent, 10)
	equal(ok, false)
end

print("selection-source: " .. checks .. " checks passed")
