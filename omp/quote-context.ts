import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import type { CaptureRecord } from "./comments";

const MAX_CONTEXT_BYTES = 1024 * 1024;

/** The exact quote alone, or verified surrounding file lines with the quoted lines marked. */
export type QuoteContext =
	| { kind: "quote"; text: string; start?: number }
	| { kind: "context"; text: string; start: number; marks: { line: number }[] };

/** Add local context only when it can be verified without altering the exact quote. */
export function quoteContext(capture: CaptureRecord): QuoteContext {
	const { source } = capture;
	if (source.kind !== "file") return { kind: "quote", text: capture.text };
	const fallback: QuoteContext = { kind: "quote", text: capture.text, start: source.lines?.from };
	if (!source.lines || source.dirty || source.host || capture.clipped) return fallback;
	const { from, to } = source.lines;

	let file: string;
	let fd: number | undefined;
	try {
		// Non-blocking: opening a FIFO for reading would otherwise wait for a writer on the UI thread.
		fd = openSync(resolve(source.cwd ?? ".", source.path), constants.O_RDONLY | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_CONTEXT_BYTES) return fallback;

		// One extra byte detects growth without letting a changed file cause an unbounded read.
		const bytes = Buffer.allocUnsafe(stat.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, null);
			if (count === 0) break;
			length += count;
		}

		if (length !== stat.size) return fallback;
		file = bytes.toString("utf8", 0, length);
	} catch {
		return fallback;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}

	const starts = [0];
	for (let index = file.indexOf("\n"); index !== -1; index = file.indexOf("\n", index + 1)) starts.push(index + 1);
	if (to > starts.length) return fallback;

	const selectionStart = starts[from - 1];
	const selectionEnd = starts[to] ?? file.length;
	const selected = file.slice(selectionStart, selectionEnd);
	const match = selected.indexOf(capture.text);
	if (match === -1 || selected.indexOf(capture.text, match + 1) !== -1) return fallback;
	const first = selectionStart + match;
	const last = first + capture.text.length - 1;
	// A partial boundary line is valid; a quote on different lines is not.
	if (first >= (starts[from] ?? file.length) || last < starts[to - 1]) return fallback;

	const start = Math.max(1, from - 2);
	const end = Math.min(starts.length, to + 2);
	let text = file.slice(starts[start - 1], starts[end] ?? file.length);
	// Omit only a display-only trailing newline, never a byte of the captured segment.
	if ((starts[end] ?? file.length) > first + capture.text.length && text.endsWith("\n")) {
		text = text.slice(0, text.endsWith("\r\n") ? -2 : -1);
	}

	return {
		kind: "context",
		text,
		start,
		marks: Array.from({ length: to - from + 1 }, (_, index) => ({ line: from + index })),
	};
}
