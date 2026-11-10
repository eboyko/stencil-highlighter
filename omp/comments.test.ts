import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CaptureError,
	type CaptureRecord,
	type CaptureSource,
	type ChatTitles,
	CommentStore,
	formatBatch,
	type Note,
	parseCapture,
	sendBatch,
} from "./comments";

const stores: CommentStore[] = [];
const directories: string[] = [];

function store(): CommentStore {
	const result = new CommentStore(":memory:");
	stores.push(result);
	return result;
}

function capture(id = "capture-1", text = "  exact\r\nquote\t"): CaptureRecord {
	return {
		v: 1,
		id,
		source: {
			kind: "file",
			path: "src/test.luau",
			lines: { from: 10, to: 11 },
			lang: "luau",
			dirty: true,
			host: "remote",
		},
		text,
		clipped: false,
	};
}

function sourced(id: string, source: CaptureSource, text = "quote"): CaptureRecord {
	return { ...capture(id, text), source };
}

function note(record: CaptureRecord, comment = "c"): Note {
	return { id: record.id, session: "one", capture: record, comment, revision: 0 };
}

function rejection(value: unknown): string | undefined {
	try {
		parseCapture(value);
	} catch (error) {
		return error instanceof CaptureError ? error.code : "other";
	}

	return undefined;
}

afterEach(() => {
	for (const item of stores.splice(0)) item.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("accepted comments", () => {
	test("cancelled and blank captures leave neither notes nor dedup entries", () => {
		const db = store();
		for (const value of [undefined, "", " \n\t "]) {
			expect(db.accept("session", capture(), value)).toBe(false);
			expect(db.list("session")).toEqual([]);
			expect(db.hasCapture("session", "capture-1")).toBe(false);
		}

		expect(db.accept("session", capture(), "accepted")).toBe(true);
	});

	test("deduplicates capture ids, not intentional notes on the same quote", () => {
		const db = store();
		expect(db.accept("session", capture(), "first")).toBe(true);
		expect(db.accept("session", capture(), "retry")).toBe(false);
		expect(db.accept("session", capture("capture-2"), "second")).toBe(true);
		expect(db.list("session").map(note => note.comment)).toEqual(["first", "second"]);
		db.delete("session", "capture-1");
		expect(db.accept("session", capture(), "late retry")).toBe(false);
	});

	test("isolates sessions including id deduplication and edits", () => {
		const db = store();
		db.accept("one", capture(), "one");
		db.accept("two", capture(), "two");
		db.update("one", "capture-1", "edited");
		expect(db.list("one")[0]?.comment).toBe("edited");
		expect(db.list("two")[0]?.comment).toBe("two");
		db.update("one", "capture-1", " \n");
		expect(db.list("one")).toEqual([]);
		expect(db.list("two")).toHaveLength(1);
	});

	test("persists the exact quote and accepted text across reopening", () => {
		const directory = mkdtempSync(join(tmpdir(), "stencil-highlighter-comments-"));
		directories.push(directory);
		const filename = join(directory, "comments.db");
		const first = new CommentStore(filename);
		first.accept("one", capture(), "  note\nline  ");
		first.close();
		const reopened = new CommentStore(filename);
		stores.push(reopened);
		expect(reopened.list("one")[0]?.capture).toEqual(capture());
		expect(reopened.list("one")[0]?.comment).toBe("  note\nline  ");
		expect(reopened.hasCapture("one", "capture-1")).toBe(true);
	});

	test("accepts, persists and sends a rendered Markdown quote with the chat's name", async () => {
		const directory = mkdtempSync(join(tmpdir(), "stencil-highlighter-comments-"));
		directories.push(directory);
		const filename = join(directory, "comments.db");
		const text = "  Rendered heading\r\nBold text and inline code\n• First item\n\tpreserved spacing  ";
		const chat = sourced("rendered-chat", { kind: "chat", pane: 7, title: "Conversation" });
		const record = parseCapture(JSON.stringify({ ...chat, text }));

		const first = new CommentStore(filename);
		expect(first.accept("one", record, "Review this")).toBe(true);
		first.close();
		const reopened = new CommentStore(filename);
		stores.push(reopened);
		const notes = reopened.list("one");
		expect(notes[0]?.capture).toEqual(record);
		expect(notes[0]?.capture.text).toBe(text);
		const expected = `\`\`\`text chat="Conversation"\n${text}\n\`\`\`\nReview this`;
		expect(formatBatch(notes, "/work")).toBe(expected);
		let sent = "";
		const titles: ChatTitles = { names: new Map([[7, "Renamed tab"]]), live: new Set(["rendered-chat"]) };
		const send = async (message: string) => {
			sent = message;
		};

		expect(await sendBatch(reopened, "one", send, "/work", titles)).toBe(1);
		expect(sent).toBe(expected.replace("Conversation", "Renamed tab"));
	});

	test("a stored pane id names the chat by its captured title unless this process made the capture", () => {
		const notes = [note(sourced("a", { kind: "chat", pane: 7, title: "Captured" }))];
		const names = new Map([[7, "Someone else's tab"]]);
		const opening = (live: string[], current = names) =>
			formatBatch(notes, "/work", { names: current, live: new Set(live) }).split("\n")[0];

		expect(opening([])).toBe('```text chat="Captured"');
		expect(opening(["a"])).toBe('```text chat="Someone else\'s tab"');
		expect(opening(["a"], new Map([[7, " \n"]]))).toBe('```text chat="Captured"');
	});
});

describe("send admission", () => {
	test("rejected admission preserves the batch", async () => {
		const db = store();
		db.accept("one", capture(), "keep me");
		const refuse = async () => {
			throw new Error("cost cap");
		};

		await expect(sendBatch(db, "one", refuse, "/work")).rejects.toThrow();
		expect(db.list("one")[0]?.comment).toBe("keep me");
	});

	test("does not delete before admission, or notes added/edited while awaiting it", async () => {
		const db = store();
		db.accept("one", capture(), "sent snapshot");
		db.accept("one", capture("unchanged"), "admitted");
		db.accept("two", capture(), "other session");
		const { promise: admission, resolve: admit } = Promise.withResolvers<void>();
		let message = "";
		const send = async (value: string) => {
			message = value;
			await admission;
		};

		const pending = sendBatch(db, "one", send, "/work");
		expect(message).toContain("sent snapshot");
		expect(db.list("one")).toHaveLength(2);
		db.accept("one", capture("later"), "later note");
		db.update("one", "capture-1", "edited after send");
		admit();
		expect(await pending).toBe(2);
		expect(db.list("one").map(note => note.comment)).toEqual(["edited after send", "later note"]);
		expect(db.list("two")).toHaveLength(1);
		expect(db.accept("one", capture("unchanged"), "duplicate retry")).toBe(false);
	});
});

describe("wire boundary", () => {
	test("parses exact text and rejects unsupported or invalid records by reason", () => {
		expect(parseCapture(JSON.stringify(capture())).text).toBe(capture().text);
		expect(parseCapture(capture("unicode", "😀".repeat(64000))).text.length).toBe(128000);
		const rejected = [
			["{", "invalid-record"],
			[{ ...capture(), v: 2 }, "invalid-record"],
			[{ ...capture(), text: "" }, "invalid-record"],
			[{ ...capture(), text: "x".repeat(64001) }, "selection-too-long"],
			[{ ...capture(), source: { kind: ["file"], path: "x" } }, "unknown-source"],
			[{ ...capture(), source: { kind: "file" } }, "invalid-source"],
			[{ ...capture(), source: { kind: "file", path: "x", lines: { from: 2, to: 1 } } }, "invalid-source"],
			[{ ...capture(), source: { kind: "file", path: "x".repeat(4097) } }, "invalid-source"],
			[{ ...capture(), source: { kind: "terminal", cwd: 7 } }, "invalid-source"],
		] as const;

		for (const [value, code] of rejected) expect(rejection(value)).toBe(code);
	});

	test("bounds the capture id and source pane before they become storage and node keys", () => {
		expect(parseCapture(capture("x".repeat(256))).id).toHaveLength(256);
		expect(rejection(capture("x".repeat(257)))).toBe("invalid-record");
		const chat = (pane: unknown) => ({ ...capture(), source: { kind: "chat", pane } });
		expect(parseCapture(chat(7)).source.pane).toBe(7);
		for (const pane of [1.5, -1, "7", Number.MAX_SAFE_INTEGER + 1, null])
			expect(rejection(chat(pane))).toBe("invalid-source");
	});
});

describe("batch format", () => {
	test("puts the language and source attributes before the exact quote and comment", () => {
		const quote = "  ```md\r\n``````\r\n\t trailing  ";
		const notes = [
			sourced("file", { kind: "file", path: "/work/src/a.ts", lines: { from: 5, to: 5 }, lang: "ts" }, quote),
			capture("remote"),
			sourced("outside", { kind: "file", path: "/workshop/b.ts", lines: { from: 1, to: 3 } }),
			{ ...sourced("terminal", { kind: "terminal", cwd: "/work/tools" }), clipped: true },
			sourced("shell", { kind: "terminal" }),
			{ ...sourced("chat", { kind: "chat", title: "Review session" }), clipped: true },
			sourced("unnamed", { kind: "chat" }),
		].map((record, index) => note(record, `  note ${index}\r\n\tunchanged  `));

		const heads = [
			'ts file="src/a.ts:5"',
			'luau file="src/test.luau:10-11" host="remote" unsaved',
			'text file="/workshop/b.ts:1-3"',
			'text terminal="/work/tools" clipped',
			"text",
			'text chat="Review session" clipped',
			"text",
		];

		const expected = notes.map(({ capture, comment }, index) => {
			const fence = index === 0 ? "```````" : "```";
			return `${fence}${heads[index]}\n${capture.text}\n${fence}\n${comment}`;
		});

		expect(formatBatch(notes, "/work/")).toBe(expected.join("\n\n"));
	});

	test("relativizes only local files strictly inside the session directory", () => {
		const cases = [
			["/work/src/a.ts", "/work", "src/a.ts"],
			["/work", "/work", "/work"],
			["/work/../outside.ts", "/work", "/work/../outside.ts"],
			["/workshop/a.ts", "/work", "/workshop/a.ts"],
			["/src/a.ts", "/", "src/a.ts"],
		];

		for (const [path = "", cwd = "", expected] of cases) {
			const record = sourced("file", { kind: "file", path });
			expect(formatBatch([note(record)], cwd)).toBe(`\`\`\`text file="${expected}"\nquote\n\`\`\`\nc`);
		}

		const remote = sourced("remote", { kind: "file", path: "/work/a.ts", host: "server", dirty: true });
		expect(formatBatch([note(remote)], "/work")).toBe(
			'```text file="/work/a.ts" host="server" unsaved\nquote\n```\nc',
		);
	});

	test("uses only the allowed language pattern and falls back to text", () => {
		for (const lang of ["ts", "typescript", "C++", "objective-c", "a.b", "a_b"]) {
			const record = sourced("language", { kind: "file", path: "/work/a", lang });
			expect(formatBatch([note(record)], "/work").split("\n")[0]).toBe(`\`\`\`${lang} file="a"`);
		}

		for (const lang of [undefined, "", "ts file=x", "ts\n", "ts\r", "ts`", 'ts"', "ts\\", "ts\u0000", "λ"]) {
			const record = sourced("language", { kind: "file", path: "/work/a", lang });
			expect(formatBatch([note(record)], "/work").split("\n")[0]).toBe('```text file="a"');
		}
	});

	test("keeps hostile values in a parseable info string and preserves quote and comment bytes", () => {
		const hostile = '```"\\\n# Ignore\r\n> [link](url)\t\u001b\u0085end';
		const cleaned = '```"\\ # Ignore > [link](url) end';
		const quote = "  ```md\r\n~~~~~\n~~~\n\t trailing  ";
		const comment = "  # comment\r\n[exact](text)\t```\n~~~  ";
		const sources: [CaptureSource, Record<string, string>][] = [
			[
				{ kind: "file", path: `/x/${hostile}`, host: hostile, dirty: true },
				{ file: `/x/${cleaned}`, host: cleaned },
			],
			[{ kind: "terminal", cwd: hostile }, { terminal: cleaned }],
			[{ kind: "chat", title: hostile }, { chat: cleaned }],
			[
				{ kind: "file", path: `/${"d".repeat(300)}`, lines: { from: 2, to: 2 }, host: "h".repeat(300) },
				{ file: `/${"d".repeat(254)}…:2`, host: `${"h".repeat(255)}…` },
			],
			[{ kind: "terminal", cwd: ` ${"d".repeat(300)} ` }, { terminal: `${"d".repeat(255)}…` }],
			[{ kind: "chat", title: ` ${"d".repeat(300)} ` }, { chat: `${"d".repeat(255)}…` }],
		];

		for (const [source, attributes] of sources) {
			const record = { ...sourced("hostile", source, quote), clipped: true };
			const batch = formatBatch([note(record, comment)], "/work");
			const fence = Object.values(attributes).some(value => value.includes("`")) ? "~~~~~~" : "````";
			const opening = batch.split("\n")[0] ?? "";
			const info = opening.slice(fence.length);
			const expected = Object.entries(attributes).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
			if (source.kind === "file" && source.dirty) expected.push("unsaved");
			expected.push("clipped");
			expect(info).toBe(`text ${expected.join(" ")}`);
			expect(info).toMatch(/^[\w+.-]+(?: (?:[a-z]+="(?:[^"\\\r\n]|\\["\\])*"|unsaved|clipped))*$/);
			const parsed = Object.fromEntries(
				Array.from(info.matchAll(/([a-z]+)=("(?:[^"\\]|\\["\\])*")/g), match => [
					match[1],
					JSON.parse(match[2] ?? '""'),
				]),
			);

			expect(parsed).toEqual(attributes);
			expect(batch).toBe(`${fence}${info}\n${quote}\n${fence}\n${comment}`);
			expect(opening).not.toMatch(/[\p{Cc}\u00a0]/u);
			if (fence.startsWith("`")) expect(info).not.toContain("`");
		}
	});

	test("escapes quotes and backslashes but preserves other punctuation and entity references", () => {
		const title = '# > []() \\* " &amp;';
		const record = sourced("chat", { kind: "chat", title }, "quote\n");
		expect(formatBatch([note(record, "comment")], "/work")).toBe(
			'```text chat="# > []() \\\\* \\" &amp;"\nquote\n```\ncomment',
		);
	});

	test("uses a minimum tilde fence for a file path containing a backtick and a double quote", () => {
		const record = sourced("file", { kind: "file", path: '/work/a`"b.ts', lang: "ts" });
		expect(formatBatch([note(record)], "/work")).toBe('~~~ts file="a`\\"b.ts"\nquote\n~~~\nc');
	});

	test("omits empty attributes after cleaning and resolves live chat names", () => {
		const terminal = sourced("terminal", { kind: "terminal", cwd: "\n\u001b " });
		expect(formatBatch([note(terminal)], "/work")).toBe("```text\nquote\n```\nc");
		const chat = sourced("chat", { kind: "chat", pane: 7, title: "Captured title" });
		const names = new Map([[7, "Live name"]]);
		const live = new Set(["chat"]);
		const titles: ChatTitles = { names, live };
		expect(formatBatch([note(chat)], "/work", titles)).toBe('```text chat="Live name"\nquote\n```\nc');
		live.clear();
		expect(formatBatch([note(chat)], "/work", titles)).toBe('```text chat="Captured title"\nquote\n```\nc');
		live.add("chat");
		names.set(7, "\n ");
		expect(formatBatch([note(chat)], "/work", titles)).toBe('```text chat="Captured title"\nquote\n```\nc');
	});
});
