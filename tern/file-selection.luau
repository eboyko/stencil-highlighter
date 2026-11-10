-- Tern 0.9.12 file selections are absolute, zero-based UTF-8 byte offsets into the
-- source buffer, in rendered Markdown too; caret is the head's one-based line and
-- character column. session:read returns the pane's own buffer lines (remote and
-- unsaved included) without terminators. The accessibility editor value is not a
-- source prefix (a viewport excerpt, rendered text in Markdown) and is not used.
-- Never use docs:read(path): a remote path can resolve to an unrelated local buffer.
-- When the exact source cannot be rebuilt (mixed line endings, a line over the read
-- cap), native Copy + the local clipboard helper is the fallback.

local READ_LINES, READ_CHARS = 2000, 64000

type Tern = typeof(tern)
export type Captured = { source: { [string]: any }, text: string, clipped: boolean }
-- `code` tells the reasons apart; `message` is the user-facing text.
export type Failure = { code: string, message: string }
export type Done = (cx: WindowCx?, captured: Captured?, failure: Failure?) -> ()

local function failure(code: string, message: string): Failure
	return { code = code, message = message }
end

-- A caught error: a failure raised here as it is, anything else as an internal error.
local function asFailure(err: any): Failure
	if type(err) == "table" and type(err.code) == "string" and type(err.message) == "string" then
		return err
	end

	return failure("internal", "Internal capture error: " .. tostring(err))
end

local function readState(cx: WindowCx, pane: number): { [string]: any }
	local state = cx.session:read(pane, { as = "table", from = 1, lines = 1, max_chars = 1 })
	if type(state) ~= "table" or state.kind ~= "file" then
		error(failure("source-gone", "The source file is no longer available in this tab"))
	end

	return state
end

-- Visits complete buffer lines without keeping the unselected prefix in memory.
local function readLines(
	cx: WindowCx,
	pane: number,
	from: number,
	to: number,
	visit: (line: string, index: number) -> ()
): boolean?
	local count = READ_LINES
	while from <= to do
		local chunk = cx.session:read(pane, {
			as = "table",
			from = from,
			lines = math.min(count, to - from + 1),
			max_chars = READ_CHARS,
		})
		if type(chunk) ~= "table" or chunk.kind ~= "file" or type(chunk.lines) ~= "table" or chunk.first ~= from then
			return nil
		end

		if chunk.chars_clipped then
			if count == 1 then
				return nil
			end

			count = math.max(1, count // 2)
		else
			if #chunk.lines == 0 or #chunk.lines > to - from + 1 then
				return nil
			end

			for index, line in ipairs(chunk.lines) do
				if type(line) ~= "string" then
					return nil
				end

				visit(line, from + index - 1)
			end

			from += #chunk.lines
		end
	end

	return true
end

-- Reads expose no terminators or per-line byte offsets. The head caret proves a
-- uniform prefix only when its newline-byte sum is exactly N (LF) or 2N (CRLF).
-- A mixed prefix, or a reverse range extending beyond that prefix, needs Copy.
local function rebuild(
	cx: WindowCx,
	pane: number,
	state: { [string]: any },
	startByte: number,
	endByte: number,
	maxChars: number
)
	local caret, total, head = state.caret, state.total, state.selection.head
	local numeric = type(caret) == "table" and type(caret.line) == "number" and type(caret.col) == "number"
	if not numeric or type(total) ~= "number" then
		return nil
	end

	if caret.line < 1 or caret.line > total or caret.line % 1 ~= 0 or caret.col < 1 or caret.col % 1 ~= 0 then
		return nil
	end

	local headLine, contentBytes, headText = caret.line, 0, nil
	-- At most four bytes per retained UTF-8 character plus one complete character
	-- to distinguish clipping. Never concatenate the full selection or buffer.
	local limit = 4 * (maxChars + 1)
	local lf = { parts = {}, bytes = 0, matched = 0 }
	local crlf = { parts = {}, bytes = 0, matched = 0 }
	local function take(candidate, text, origin, line)
		local first, final = math.max(startByte, origin), math.min(endByte, origin + #text)
		if first >= final then
			return
		end

		candidate.from = candidate.from or line
		candidate.to = line
		candidate.matched += final - first
		local keep = math.min(final - first, limit - candidate.bytes)
		if keep > 0 then
			table.insert(candidate.parts, string.sub(text, first - origin + 1, first - origin + keep))
			candidate.bytes += keep
		end
	end

	local complete = readLines(cx, pane, 1, headLine, function(line, index)
		local lfOrigin, crlfOrigin = contentBytes + index - 1, contentBytes + 2 * (index - 1)
		take(lf, line, lfOrigin, index)
		take(crlf, line, crlfOrigin, index)
		if index < headLine then
			take(lf, "\n", lfOrigin + #line, index)
			take(crlf, "\r\n", crlfOrigin + #line, index)
		else
			headText = line
		end

		contentBytes += #line
	end)
	if not complete then
		return nil
	end

	if not headText then
		return nil
	end

	local headColumn = utf8.offset(headText, caret.col)
	if not headColumn then
		return nil
	end

	local before = contentBytes - #headText
	local gap = head - (headColumn - 1) - before
	local candidate
	if gap == headLine - 1 then
		candidate = lf
	elseif gap == 2 * (headLine - 1) then
		candidate = crlf
	else
		return nil
	end

	if candidate.matched ~= endByte - startByte then
		return nil
	end

	return table.concat(candidate.parts), { from = candidate.from, to = candidate.to }
end

-- Tern passes only the primary range of a multi-range selection.
local function severalSelections(state: { [string]: any }): Failure?
	if (state.selections or 1) ~= 1 then
		return failure("several-selections", "Make one continuous selection")
	end

	return nil
end

-- Returns nil while the original single selection is intact, else the reason.
local function selectionChange(cx: WindowCx, pane: number, initial: { [string]: any }, requireFocus: boolean): Failure?
	if requireFocus and cx.session:focused() ~= pane then
		return failure("focus-left", "Focus left the file. Return to it and press Alt+C again")
	end

	local state = readState(cx, pane)
	if state.path ~= initial.path or state.host ~= initial.host then
		return failure("file-switched", "The pane shows a different file now. Make the selection again")
	end

	if state.dirty ~= initial.dirty or state.total ~= initial.total or state.size ~= initial.size then
		return failure("file-changed", "The file changed during capture. Press Alt+C again")
	end

	local several = severalSelections(state)
	if several then
		return several
	end

	local selected, original = state.selection, initial.selection
	if type(selected) ~= "table" or selected.anchor ~= original.anchor or selected.head ~= original.head then
		return failure("selection-changed", "The selection changed during capture. Press Alt+C again")
	end

	return nil
end

local function clippedText(text: string, maxChars: number): (string, boolean)
	-- Inspect only the retained prefix: process stdout is capped at 16 MiB and its
	-- very last code point may be cut, well after the OMP extension's 64,000-character limit.
	local boundary = utf8.offset(text, maxChars + 1)
	local clipped = boundary ~= nil and boundary <= #text
	local kept = clipped and string.sub(text, 1, boundary - 1) or text
	if not utf8.len(kept) then
		error(failure("invalid-utf8", "Tern or the clipboard returned invalid UTF-8"))
	end

	return kept, clipped
end

-- Line span from the exact text and the head caret: the head is one end of the range.
local function spanFromCaret(initial: { [string]: any }, text: string): { from: number, to: number }?
	local caret = initial.caret
	if type(caret) ~= "table" or type(caret.line) ~= "number" then
		return nil
	end

	local _, breaks = string.gsub(text, "\n", "")
	local trailing = string.sub(text, -1) == "\n" and 1 or 0
	if initial.selection.head > initial.selection.anchor then
		return { from = caret.line - breaks, to = caret.line - trailing }
	end

	return { from = caret.line, to = caret.line + breaks - trailing }
end

local function helpers(tern: Tern)
	if tern.runtime.os == "macos" then
		-- pbpaste encodes by the locale and falls back to the C encoding without one, as in a Tern started
		-- from the Dock; the byte count of non-ASCII text then differs from the selection.
		local env = { LC_ALL = "en_US.UTF-8" }
		return {
			{ probe = { "/usr/bin/pbpaste", "-help" }, read = { "/usr/bin/pbpaste" }, env = env, helpStatus = true },
		}
	elseif tern.runtime.os == "windows" then
		local base = { "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command" }
		local probe = table.clone(base)
		table.insert(probe, "exit 0")
		local read = table.clone(base)
		table.insert(
			read,
			"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Write((Get-Clipboard -Raw))"
		)

		return { { probe = probe, read = read } }
	elseif tern.runtime.os == "linux" then
		local candidates = {}
		if (tern.getenv("WAYLAND_DISPLAY") or "") ~= "" then
			table.insert(candidates, { probe = { "wl-paste", "--version" }, read = { "wl-paste", "--no-newline" } })
		end

		if (tern.getenv("DISPLAY") or "") ~= "" then
			table.insert(
				candidates,
				{ probe = { "xclip", "-version" }, read = { "xclip", "-selection", "clipboard", "-o" } }
			)
		end

		return candidates
	end

	return {}
end

local function clipboardCapture(
	tern: Tern,
	cx: WindowCx,
	pane: PaneInfo,
	initial: { [string]: any },
	source: { [string]: any },
	length: number,
	maxChars: number,
	done: Done
)
	local candidates = helpers(tern)
	local function fail(fresh: WindowCx, reason: Failure)
		tern.log.warn("Stencil Highlighter capture rejected", reason.message)
		done(fresh, nil, reason)
	end

	local function current(fresh: WindowCx, focused: boolean): boolean
		local ok, reason = pcall(selectionChange, fresh, pane.pane, initial, focused)
		if not ok then
			reason = asFailure(reason)
		end

		if reason then
			fail(fresh, reason)
			return false
		end

		return true
	end

	local probe
	probe = function(fresh: WindowCx, index: number)
		local helper = candidates[index]
		if not helper then
			fail(
				fresh,
				failure(
					"no-clipboard-reader",
					"No clipboard reader found. Install pbpaste (macOS), wl-paste (Wayland), xclip (X11) or PowerShell (Windows). The clipboard is unchanged"
				)
			)

			return
		end

		local started = pcall(function()
			tern.process.run(helper.probe, { timeout_ms = 5000 }, function(result, nextCx)
				-- Without a window there is nothing left to capture into, but the caller still has to finish.
				if not nextCx then
					done(nil, nil, failure("window-closed", "The window closed during capture"))
					return
				end

				if result.timed_out or (result.status ~= 0 and not (helper.helpStatus and result.status == 1)) then
					probe(nextCx, index + 1)
					return
				end

				-- No clipboard mutation until a helper has actually executed and the
				-- original file is still focused. Copy is a native view action, not keys.
				if not current(nextCx, true) then
					return
				end

				local copied, copyError = pcall(function()
					nextCx:action("edit.copy")
				end)
				if not copied then
					fail(nextCx, failure("copy-failed", "Could not copy the selection: " .. tostring(copyError)))
					return
				end

				local reading, readError = pcall(function()
					tern.process.run(helper.read, { timeout_ms = 5000, env = helper.env }, function(clipboard, readCx)
						if not readCx then
							done(nil, nil, failure("window-closed", "The window closed during capture"))
							return
						end

						if clipboard.timed_out or clipboard.status ~= 0 then
							fail(readCx, failure("clipboard-unreadable", "Could not read the clipboard after copying"))
							return
						end

						if not current(readCx, true) then
							return
						end

						-- Native Copy must still refer to this unchanged, focused source.
						-- Reject normalization/rendered copies with a different byte count.
						if #clipboard.stdout ~= length then
							local message = "The copied text does not match the selection. The selection was not added"
							fail(readCx, failure("copy-mismatch", message))
							return
						end

						local valid, text, clipped = pcall(clippedText, clipboard.stdout, maxChars)
						if not valid then
							fail(readCx, asFailure(text))
							return
						end

						source.lines = spanFromCaret(initial, clipboard.stdout)
						done(readCx, { source = source, text = text, clipped = clipped }, nil)
					end)
				end)
				if not reading then
					local message = "Could not start reading the clipboard: " .. tostring(readError)
					fail(nextCx, failure("clipboard-start-failed", message))
				end
			end)
		end)
		if not started then
			probe(fresh, index + 1)
		end
	end

	probe(cx, 1)
end

-- The caller passes the `tern` API: under the standalone Luau CLI a required module does
-- not share the test's globals, so its stub has to arrive as an argument.
return function(tern: Tern, cx: WindowCx, pane: PaneInfo, maxChars: number, done: Done)
	local initial = readState(cx, pane.pane)
	local range = initial.selection
	if range == nil or range == tern.json.null then
		done(cx, nil, nil)
		return
	end

	if type(range) ~= "table" or type(range.anchor) ~= "number" or type(range.head) ~= "number" then
		error(failure("unknown-format", "Tern returned an unknown file selection format"))
	end

	local several = severalSelections(initial)
	if several then
		error(several)
	end

	local startByte, endByte = math.min(range.anchor, range.head), math.max(range.anchor, range.head)
	if startByte == endByte then
		done(cx, nil, nil)
		return
	end

	local invalidRange = startByte < 0 or startByte % 1 ~= 0 or endByte % 1 ~= 0
	local invalidFile = type(initial.path) ~= "string" or type(initial.size) ~= "number" or endByte > initial.size
	if invalidRange or invalidFile then
		error(failure("incomplete-range", "Tern returned an incomplete file range or path"))
	end

	local changed = selectionChange(cx, pane.pane, initial, true)
	if changed then
		error(changed)
	end

	local source = { kind = "file", pane = pane.pane, title = pane.title, path = initial.path, dirty = initial.dirty }
	if type(initial.host) == "string" and initial.host ~= "" then
		source.host = initial.host
	end

	if pane.cwd and pane.cwd ~= "" then
		source.cwd = pane.cwd
	end

	local extension = string.match(initial.path, "%.([%w_+-]+)$")
	if extension then
		source.lang = string.lower(extension)
	end

	local text, lines = rebuild(cx, pane.pane, initial, startByte, endByte, maxChars)
	if not text then
		clipboardCapture(tern, cx, pane, initial, source, endByte - startByte, maxChars, done)
		return
	end

	changed = selectionChange(cx, pane.pane, initial, true)
	if changed then
		error(changed)
	end

	local kept, clipped = clippedText(text, maxChars)
	source.lines = lines
	done(cx, { source = source, text = kept, clipped = clipped }, nil)
end
