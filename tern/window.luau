-- CaptureRecord v1 wire contract is owned by the OMP extension, including persistence and receipt.

local captureFile = require("./file-selection")
local selectionSource = require("./selection-source")

local MAX_CHARS = 64000
-- Comments button discovery needs node ids and props only, never text: keep UI-thread reads small.
local DOCK_NODES = 500
local LAYER_NODES = 5000
-- A pane without a Comments button is read again after this long, or as soon as its state changes.
local MISS_RETRY_MS = 10000

local lastFocused: { [number]: number } = {}
local capturing = false
local serial = 0
local publishedTitles: { [number]: { payload: string, state: string } } = {}
local missedPanes: { [number]: { state: string, at: number } } = {}

local function dockSurface(cx: WindowCx, pane: number): SurfaceTree?
	local ok, tree = pcall(function()
		return cx.session:surface(pane, { as = "table", root = "dock", nodes = DOCK_NODES, max_chars = 1 })
	end)
	if not ok or type(tree) ~= "table" or type(tree.surface) ~= "table" then
		return nil
	end

	if tree.surface.role ~= "omp.session" or type(tree.surface.id) ~= "string" then
		return nil
	end

	return tree
end

local function collectorNode(tree: SurfaceTree): string?
	local found = nil
	local ambiguous = false
	local function visit(node)
		if not node then
			return
		end

		local props = node.p or {}
		local actions = props.actions
		local id = node.id
		local keyed = props.key == "omp-comments"
		if type(id) == "string" then
			-- Reconciler ids are <component>.<keypath>, with / between key segments.
			for part in string.gmatch(id, "[^./]+") do
				if part == "omp-comments" then
					keyed = true
				end
			end
		end

		local opens = type(actions) == "table" and actions.click == "comments.open"
		if props.role == "omp.btn" and type(id) == "string" and (keyed or opens) then
			if found then
				ambiguous = true
			else
				found = id
			end
		end

		for _, child in ipairs(node.c or {}) do
			visit(child)
		end
	end

	visit(tree.dock)
	-- Some implementations put a requested subtree under main instead of its region.
	visit(tree.main)
	visit(tree.layer)
	if ambiguous then
		return nil
	end

	return found
end

-- Every OMP process numbers its first surface s:1, so a restart keeps the surface id. Its program,
-- busy state or command history changes instead; any change makes the pane publish again.
local function paneState(pane: PaneInfo): string
	local running, last = pane.running, pane.last
	return table.concat({
		pane.program or "",
		tostring(pane.busy),
		running and running.line or "",
		last and (last.line .. "\0" .. tostring(last.status) .. "\0" .. tostring(last.took_ms)) or "",
	}, "\0")
end

-- Tab names belong to window state, not immutable captured quotes.
local function refreshTitles(cx: WindowCx)
	local names: { [number]: string } = {}
	for _, tab in ipairs(cx.session:tabs()) do
		if tab.name and tab.name ~= "" then
			names[tab.id] = tab.name
		end
	end

	local titles: { { pane: number, title: string } } = {}
	local states: { [number]: string } = {}
	for _, pane in ipairs(cx.session:panes()) do
		if not pane.parked and pane.exited == nil and (pane.kind == "agent" or pane.kind == "terminal") then
			table.insert(titles, { pane = pane.pane, title = (pane.tab and names[pane.tab]) or pane.title })
			states[pane.pane] = paneState(pane)
		end
	end

	table.sort(titles, function(a, b)
		return a.pane < b.pane
	end)

	local payload = tern.json.encode(titles)
	-- Only unpublished panes and changed titles or pane states cost a surface read.
	for _, source in ipairs(titles) do
		local state = states[source.pane]
		local previous = publishedTitles[source.pane]
		local missed = missedPanes[source.pane]
		local changed = not previous or previous.payload ~= payload or previous.state ~= state
		local waiting = missed ~= nil and missed.state == state and tern.now() - missed.at < MISS_RETRY_MS
		if changed and not waiting then
			publishedTitles[source.pane] = nil
			missedPanes[source.pane] = nil
			local tree = dockSurface(cx, source.pane)
			local node = tree and collectorNode(tree)
			if tree and node then
				cx.session:event(
					source.pane,
					{ ev = "action", sf = tree.surface.id, id = node, act = "comments.sources", value = payload }
				)

				publishedTitles[source.pane] = { payload = payload, state = state }
			else
				missedPanes[source.pane] = { state = state, at = tern.now() }
			end
		end
	end
end

-- The SDK has pane-title events but no tab-rename event. The next tick is scheduled first: a budget
-- trip raises out of this call, and the watcher would end with it.
local function watchTitles(cx: WindowCx?)
	tern.timer(1000, watchTitles)
	if not cx then
		return
	end

	local ok, err = pcall(refreshTitles, cx)
	if not ok then
		tern.log.warn("Stencil Highlighter title refresh failed", tostring(err))
	end
end

local function commentInputOpen(cx: WindowCx, tab: number): boolean
	for _, pane in ipairs(cx.session:panes()) do
		if pane.tab == tab and not pane.parked and pane.exited == nil then
			local ok, tree = pcall(function()
				return cx.session:surface(
					pane.pane,
					{ as = "table", root = "layer", nodes = LAYER_NODES, max_chars = 1 }
				)
			end)

			local function visit(node)
				if not node then
					return false
				end

				if (node.p or {}).role == "stencil-highlighter.comment-input" then
					return true
				end

				for _, child in ipairs(node.c or {}) do
					if visit(child) then
						return true
					end
				end

				return false
			end

			if ok and type(tree) == "table" and (visit(tree.layer) or visit(tree.main)) then
				return true
			end
		end
	end

	return false
end

local function treeContainsPane(tree, pane)
	if tree.pane == pane then
		return true
	end

	for _, child in ipairs(tree) do
		if treeContainsPane(child, pane) then
			return true
		end
	end

	return false
end

local function promoteFilePreview(cx: WindowCx, source: PaneInfo, target: number, sourceTab: number)
	if source.kind ~= "file" then
		return
	end

	local pane = cx.session:pane(source.pane)
	if not pane or pane.kind ~= "file" or pane.parked or pane.tab ~= sourceTab then
		error("The source file is no longer available in this tab", 0)
	end

	local layout = cx.session:layout(sourceTab)
	if not layout then
		error("Could not read the source tab's layout", 0)
	end

	if treeContainsPane(layout.root, source.pane) then
		return
	end

	for _, floating in ipairs(layout.floats) do
		if floating.pane == source.pane then
			return
		end
	end

	-- A glimpse is absent from both the tiled tree and floats. Move the original
	-- pane only after capture completes, retaining its dirty/remote file buffer.
	if not cx.layout:move(source.pane, target, "right") then
		error("Could not pin the preview next to the session. The selection was not added", 0)
	end
end

local function transfer(cx: WindowCx, target: number, source: PaneInfo, sourceTab: number, record: { [string]: any }?)
	local pane = cx.session:pane(target)
	if not pane or pane.parked or pane.exited ~= nil or cx.session:tab_of(target) ~= sourceTab then
		cx:toast("error", "The receiving session is no longer available in this tab")
		return
	end

	-- Re-read immediately before dispatch: never address a stale or fabricated node id.
	local tree = dockSurface(cx, target)
	local node = tree and collectorNode(tree)
	if not node then
		cx:toast(
			"error",
			"Stencil Highlighter extension not found in this session",
			"Open OMP with the stencil-highlighter extension and press Alt+C again"
		)

		return
	end

	-- The receiving pane has a Comments button now, so a recorded miss must not delay its names.
	missedPanes[target] = nil
	local titlesOk, titlesError = pcall(refreshTitles, cx)
	if not titlesOk then
		tern.log.warn("Stencil Highlighter title refresh failed", tostring(titlesError))
	end

	local ok, err = pcall(function()
		-- Only a capture needs its glimpse source kept; opening the collection leaves the layout alone.
		if record then
			promoteFilePreview(cx, source, target, sourceTab)
		end

		cx.layout:focus(target)
		local event = {
			ev = "action",
			sf = tree.surface.id,
			id = node,
			act = record and "comments.add" or "comments.open",
		}

		if record then
			event.value = tern.json.encode(record)
		end

		cx.session:event(target, event)
	end)
	if not ok then
		tern.log.warn("Stencil Highlighter transfer failed", tostring(err))
		local title = if record then "Could not pass the selection to the session" else "Could not open Comments"
		cx:toast("error", title, tostring(err))
		return
	end

	lastFocused[sourceTab] = target
	-- The session event does not acknowledge receipt. Only OMP may report success after saving.
end

local function chooseReceiver(cx: WindowCx, source: PaneInfo, sourceTab: number, record: { [string]: any }?)
	local candidates = {}
	for _, pane in ipairs(cx.session:panes()) do
		local live = pane.tab == sourceTab and not pane.parked and pane.exited == nil
		local hostsAgent = pane.kind == "agent" or pane.kind == "terminal"
		if live and hostsAgent and dockSurface(cx, pane.pane) then
			table.insert(candidates, pane)
		end
	end

	for _, pane in ipairs(candidates) do
		if pane.pane == source.pane then
			transfer(cx, pane.pane, source, sourceTab, record)
			return
		end
	end

	for _, pane in ipairs(candidates) do
		if pane.pane == lastFocused[sourceTab] then
			transfer(cx, pane.pane, source, sourceTab, record)
			return
		end
	end

	if #candidates == 0 then
		cx:toast("error", "No OMP session available in this tab", "Open OMP with the stencil-highlighter extension")
	elseif #candidates == 1 then
		transfer(cx, candidates[1].pane, source, sourceTab, record)
	else
		local items = {}
		for _, pane in ipairs(candidates) do
			local detail = "pane " .. tostring(pane.pane)
			if pane.cwd and pane.cwd ~= "" then
				detail = pane.cwd .. " · " .. detail
			end

			table.insert(items, {
				label = pane.title ~= "" and pane.title or ("OMP · " .. tostring(pane.pane)),
				detail = detail,
				pane = pane.pane,
			})
		end

		cx:pick({
			items = items,
			placeholder = if record then "Which session gets the comment?" else "Open Comments of which session?",
			action = "select",
			icon = "message",
		}):next(function(item, err, fresh)
			if not fresh then
				return
			end

			if err then
				fresh:toast("error", "Could not select the receiving session", tostring(err))
			elseif item then
				transfer(fresh, item.pane, source, sourceTab, record)
			end
		end)
	end
end

-- File capture fails with a { code, message } table; other failures are error strings.
local function captureFailure(cx: WindowCx, reason: any)
	local message = if type(reason) == "table" then tostring(reason.message) else tostring(reason)
	tern.log.warn("Stencil Highlighter capture rejected", message)
	cx:toast("error", "Could not read the selection", message)
end

local function capture(cx: WindowCx, pane: PaneInfo)
	local selection = cx.session:selection(pane.pane, { max_chars = MAX_CHARS })
	if not selection or selection.text == "" then
		return nil
	end

	if selection.pane ~= pane.pane then
		error("Tern returned a selection from another pane", 0)
	end

	-- BlockSelection names no author, so a chat capture carries no role. A terminal capture carries no
	-- command: the pane's running or last command need not be the one whose output is selected.
	local source = { pane = pane.pane, title = pane.title }
	if pane.kind == "agent" or dockSurface(cx, pane.pane) then
		source.kind = "chat"
	elseif pane.kind == "terminal" then
		source.kind = "terminal"
	else
		error("Selections in this pane type are not supported yet: " .. tostring(pane.kind), 0)
	end

	if pane.cwd and pane.cwd ~= "" then
		source.cwd = pane.cwd
	end

	local current = cx.session:selection(pane.pane, { max_chars = MAX_CHARS })
	local elsewhere = cx.session:focused() ~= pane.pane or not current or current.pane ~= pane.pane
	if elsewhere or current.text ~= selection.text or current.chars_clipped ~= selection.chars_clipped then
		error("The selection changed during capture. Press Alt+C again", 0)
	end

	return { source = source, text = selection.text, clipped = selection.chars_clipped == true }
end

local function finishCapture(cx: WindowCx, pane: PaneInfo, tab: number, captured: { [string]: any }?)
	local record = nil
	if captured then
		serial += 1
		record = {
			v = 1,
			id = string.format("tern:%s:%d:%s:%d", cx:window_key(), os.time(), tostring(tern.now()), serial),
			source = captured.source,
			text = captured.text,
			clipped = captured.clipped,
		}
	end

	chooseReceiver(cx, pane, tab, record)
end

local function run(cx: WindowCx)
	local focused = cx.session:focused()
	local pane = focused and cx.session:pane(focused)
	local tab = focused and cx.session:tab_of(focused)
	if not pane or not tab then
		cx:toast("error", "No active pane to comment on")
		return
	end

	if capturing then
		cx:toast("info", "The selection is still being captured", "Wait for the comment field")
		return
	end

	if commentInputOpen(cx, tab) then
		cx:toast("info", "Finish the current comment", "Enter saves, Esc cancels")
		return
	end

	local resolved, source = pcall(selectionSource, cx, pane, tab)
	if not resolved then
		captureFailure(cx, source)
		return
	end

	if source.pane ~= pane.pane then
		pane = source
		cx.layout:focus(pane.pane)
	end

	if pane.kind == "file" then
		capturing = true
		local started, err = pcall(
			captureFile,
			tern,
			cx,
			pane,
			MAX_CHARS,
			function(fresh: WindowCx?, captured, failure: { code: string, message: string }?)
				capturing = false
				if not fresh then
					local reason = if failure then failure.message else "no reason"
					tern.log.warn("Stencil Highlighter capture abandoned without a window", reason)
				elseif failure then
					captureFailure(fresh, failure)
				else
					finishCapture(fresh, pane, tab, captured)
				end
			end
		)
		if not started then
			capturing = false
			captureFailure(cx, err)
		end
	else
		local ok, captured = pcall(capture, cx, pane)
		if not ok then
			captureFailure(cx, captured)
			return
		end

		finishCapture(cx, pane, tab, captured)
	end
end

local function rememberFocus(cx: WindowCx, paneId: number, tab: number)
	local pane = cx.session:pane(paneId)
	if pane and not pane.parked and pane.exited == nil and dockSurface(cx, paneId) then
		lastFocused[tab] = paneId
	end
end

tern.timer(0, watchTitles)

-- Module-level registration also runs when the plugin is reloaded in an existing window.
-- A user/preset binding can take Alt+C; the palette command remains available.
tern.command({ id = "capture", title = "Comment on selection", keys = { "alt+c" }, run = run })
tern.on("focus", function(ev: FocusEvent, cx: WindowCx)
	rememberFocus(cx, ev.pane, ev.tab)
end)

tern.on("window_start", function(cx: WindowCx)
	local pane = cx.session:focused()
	local tab = pane and cx.session:tab_of(pane)
	if pane and tab then
		rememberFocus(cx, pane, tab)
	end
end)

tern.on("tab_closed", function(ev: TabEvent)
	lastFocused[ev.tab] = nil
end)

tern.on("pane_closed", function(ev: PaneEvent)
	publishedTitles[ev.pane] = nil
	missedPanes[ev.pane] = nil
	for tab, pane in pairs(lastFocused) do
		if pane == ev.pane then
			lastFocused[tab] = nil
		end
	end
end)
