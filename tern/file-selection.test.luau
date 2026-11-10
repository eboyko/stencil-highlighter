local captureFile = require("./file-selection")

local checks = 0
local function equal(actual, expected)
	assert(actual == expected, "expected " .. tostring(expected) .. ", got " .. tostring(actual))
	checks += 1
end

local function fixture(text, anchor, head, options)
	options = options or {}
	local lines = string.split(text, "\n")
	for i, line in ipairs(lines) do
		if string.sub(line, -1) == "\r" then
			lines[i] = string.sub(line, 1, -2)
		end
	end

	local prefix = string.sub(text, 1, head)
	local _, breaks = string.gsub(prefix, "\n", "")
	local tail = string.match(prefix, "[^\n]*$") or ""
	local state = {
		kind = "file",
		path = "/remote/note.md",
		host = "server",
		dirty = true,
		total = #lines,
		size = #text,
		selections = 1,
		selection = { anchor = anchor, head = head },
		caret = { line = breaks + 1, col = utf8.len(tail) + 1 },
	}

	local pane = { pane = 7, title = "note.md", cwd = "/remote" }
	local result, failure, copies = nil, nil, 0
	local cx = { session = {} }
	local reads = 0
	function cx.session:focused()
		return options.focused or pane.pane
	end

	function cx.session:read(id, opts)
		reads += 1
		if options.mutate then
			options.mutate(state, reads)
		end

		local out = table.clone(state)
		out.first = opts.from
		out.lines = {}
		local chars = 0
		for i = opts.from, math.min(#lines, opts.from + opts.lines - 1) do
			chars += utf8.len(lines[i]) + 1
			table.insert(out.lines, lines[i])
		end

		out.chars_clipped = chars > opts.max_chars
		return out
	end

	function cx:action(action)
		copies += 1
	end

	-- Required modules do not see this file's globals under the Luau CLI: inject the API stub.
	local api = {
		json = { null = {} },
		runtime = { os = "macos" },
		log = { warn = function() end },
		process = {
			run = function(argv, opts, callback)
				if argv[2] == "-help" then
					-- A closed window hands callbacks no cx.
					callback({ status = options.noHelper and 127 or 0 }, if options.windowClosed then nil else cx)
				else
					if options.reads then
						table.insert(options.reads, opts)
					end

					callback({
						status = 0,
						stdout = options.clipboard
							or string.sub(text, math.min(anchor, head) + 1, math.max(anchor, head)),
					}, cx)
				end
			end,
		},
	}

	local ok, err = pcall(
		captureFile,
		api,
		cx,
		pane,
		options.maxChars or 64000,
		function(_fresh, captured, captureError)
			result, failure = captured, captureError
		end
	)
	if not ok then
		failure = err
	end

	return result, failure, copies
end

for _, newline in ipairs({ "\n", "\r\n" }) do
	local prefix = string.rep("prefix" .. newline, 2001)
	local quote = "  local café = '🙂'" .. newline .. "  return café"
	local result, err, copies = fixture(prefix .. quote .. newline .. "end", #prefix, #prefix + #quote)
	equal(err, nil)
	equal(result.text, quote)
	equal(result.source.lines.from, 2002)
	equal(result.source.lines.to, 2003)
	equal(copies, 0)
end

-- Reversed multiline ranges cannot assume endings after the caret's line.
do
	local result, err, copies = fixture("one\r\ntwo\r\nthree", 13, 1)
	equal(err, nil)
	equal(result.text, "ne\r\ntwo\r\nthr")
	equal(result.source.lines.from, 1)
	equal(result.source.lines.to, 3)
	equal(copies, 1)
end

-- The head proves neither LF nor CRLF across this mixed prefix.
do
	local text = "one\r\ntwo\nthree"
	local result, err, copies = fixture(text, 0, #text)
	equal(err, nil)
	equal(result.text, text)
	equal(copies, 1)
end

-- A reverse single-line selection needs no newline guess.
do
	local result, err, copies = fixture("café🙂 fin", 9, 3)
	equal(err, nil)
	equal(result.text, "é🙂")
	equal(copies, 0)
end

do
	local result, err = fixture("abcdef", 0, 6, {
		mutate = function(state, reads)
			if reads == 4 then
				state.size += 1
			end
		end,
	})

	equal(result, nil)
	equal(err.code, "file-changed")
end

do
	local result, err, copies = fixture("a\r\nb\nc", 0, 6, { clipboard = "wrong length" })
	equal(result, nil)
	equal(err.code, "copy-mismatch")
	equal(copies, 1)
end

-- pbpaste encodes by the locale, so the clipboard read sets a UTF-8 one.
do
	local reads = {}
	local text = "on€\r\ntwo\nthree"
	local result, err = fixture(text, 0, #text, { reads = reads })
	equal(err, nil)
	equal(result.text, text)
	equal(reads[1].env.LC_ALL, "en_US.UTF-8")
end

do
	local result, err, copies = fixture("a\r\nb\nc", 0, 6, { noHelper = true })
	equal(result, nil)
	equal(err.code, "no-clipboard-reader")
	equal(copies, 0)
end

-- A capture abandoned with its window still finishes, so the window's capturing guard is released.
do
	local result, err, copies = fixture("a\r\nb\nc", 0, 6, { windowClosed = true })
	equal(result, nil)
	equal(err.code, "window-closed")
	equal(copies, 0)
end

do
	local result, err, copies = fixture("hello", 0, 5, { focused = 8 })
	equal(result, nil)
	equal(err.code, "focus-left")
	equal(copies, 0)
end

do
	local result, err = fixture("🙂é漢z", 0, #"🙂é漢z", { maxChars = 2 })
	equal(err, nil)
	equal(result.text, "🙂é")
	equal(result.clipped, true)
end

do
	local result, err = fixture("empty", 2, 2)
	equal(result, nil)
	equal(err, nil)
end

do
	local text = string.rep("x", 64001) .. "🙂"
	local result, err, copies = fixture(text, 64001, #text)
	equal(err, nil)
	equal(result.text, "🙂")
	equal(result.source.lines.from, 1)
	equal(copies, 1)
end

do
	local result, err = fixture("abcdef", 0, 6, {
		mutate = function(state, reads)
			if reads == 4 then
				state.selection = { anchor = 1, head = 6 }
			end
		end,
	})

	equal(result, nil)
	equal(err.code, "selection-changed")
end

do
	local result, err = fixture("abcdef", 0, 6, {
		mutate = function(state)
			state.selections = 2
		end,
	})

	equal(result, nil)
	equal(err.code, "several-selections")
end

print("File capture checks passed: " .. tostring(checks))
