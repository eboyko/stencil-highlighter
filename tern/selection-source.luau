-- Resolve selected file blocks through read().selection, independently of tab focus.
-- Compact sidebar Peek is not covered by this pane-based API.
return function(cx: WindowCx, focused: PaneInfo, tab: number): PaneInfo
	if focused.kind == "file" then
		return focused
	end

	local selection = cx.session:selection(focused.pane, { max_chars = 1 })
	if selection and selection.text ~= "" then
		return focused
	end

	local selected = nil
	for _, pane in ipairs(cx.session:panes()) do
		if pane.kind == "file" and pane.tab == tab and not pane.parked and pane.exited == nil then
			local state = cx.session:read(pane.pane, { as = "table", from = 1, lines = 1, max_chars = 1 })
			local range = type(state) == "table" and state.selection
			local numeric = type(range) == "table" and type(range.anchor) == "number" and type(range.head) == "number"
			if numeric and range.anchor ~= range.head then
				if selected then
					error("Several files have a selection. Keep a selection in one file only", 0)
				end

				selected = pane
			end
		end
	end

	return selected or focused
end
