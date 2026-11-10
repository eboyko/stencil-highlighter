import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CaptureRecord } from "./comments";
import { quoteContext } from "./quote-context";

const directories: string[] = [];

function fixture(content: string): CaptureRecord & { source: { kind: "file" } } {
	const directory = mkdtempSync(join(tmpdir(), "stencil-highlighter-context-"));
	directories.push(directory);
	const path = join(directory, "source.txt");
	writeFileSync(path, content);
	return {
		v: 1,
		id: "context",
		source: { kind: "file", path, lines: { from: 3, to: 3 } },
		text: "selected",
		clipped: false,
	};
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("shows full boundary lines and two surrounding lines without changing the capture", () => {
	const capture = fixture(
		"outside\nbefore two\nbefore one\nprefix selected suffix\nafter one\nafter two\noutside end",
	);
	capture.source.lines = { from: 4, to: 4 };
	const before = JSON.stringify(capture);
	expect(quoteContext(capture)).toEqual({
		kind: "context",
		text: "before two\nbefore one\nprefix selected suffix\nafter one\nafter two",
		start: 2,
		marks: [{ line: 4 }],
	});

	expect(JSON.stringify(capture)).toBe(before);
});

test("retains CRLF and numbers a multiline selection at the file boundary", () => {
	const capture = fixture("first\r\nselected\r\nlast");
	capture.source.lines = { from: 2, to: 3 };
	capture.text = "selected\r\nlast";
	expect(quoteContext(capture)).toEqual({
		kind: "context",
		text: "first\r\nselected\r\nlast",
		start: 1,
		marks: [{ line: 2 }, { line: 3 }],
	});
});

test("never associates stale, ambiguous, dirty or remote quotes with local context", () => {
	const capture = fixture("one\ntwo\nselected selected\nfour");
	const fallback = { kind: "quote" as const, text: capture.text, start: 3 };
	expect(quoteContext(capture)).toEqual(fallback);
	writeFileSync(capture.source.path, "one\ntwo\nchanged\nfour");
	expect(quoteContext(capture)).toEqual(fallback);
	writeFileSync(capture.source.path, "one\ntwo\nselected\nfour");
	capture.source.dirty = true;
	expect(quoteContext(capture)).toEqual(fallback);
	capture.source.dirty = false;
	capture.source.host = "remote";
	expect(quoteContext(capture)).toEqual(fallback);
});

test("falls back for FIFOs and directories without blocking on open", () => {
	const capture = fixture("one\ntwo\nselected\nfour");
	const directory = dirname(capture.source.path);
	const fifo = join(directory, "pipe");
	expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
	const fallback = { kind: "quote" as const, text: capture.text, start: 3 };
	// Without O_NONBLOCK this open waits for a writer forever, freezing OMP's UI thread.
	expect(quoteContext({ ...capture, source: { ...capture.source, path: fifo } })).toEqual(fallback);
	expect(quoteContext({ ...capture, source: { ...capture.source, path: directory } })).toEqual(fallback);
});
