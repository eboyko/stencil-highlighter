import { Database } from "bun:sqlite";
import { isAbsolute, relative, sep } from "node:path";

const MAX_ID_LENGTH = 256;
const MAX_SELECTION_CHARS = 64000;
/** Longer wire strings are no real path, host, directory or title, so the boundary rejects them. */
const MAX_FIELD_LENGTH = 4096;
/** A longer source value is cut with an ellipsis to keep its label short. */
const MAX_SOURCE_VALUE = 256;
const STRING_FIELDS = ["path", "lang", "host", "cwd", "title"] as const;
const KINDS = new Set<unknown>(["file", "terminal", "chat"]);

const MESSAGES = {
	"invalid-record": "The selection was not received intact. Press Alt+C again",
	"selection-too-long": "The selection exceeds 64,000 characters. Make a shorter selection",
	"unknown-source":
		"The selection comes from an unknown source. Install the same Stencil Highlighter version in Tern and OMP",
	"invalid-source": "The selection's source details are invalid. Press Alt+C again",
} as const;

export type CaptureErrorCode = keyof typeof MESSAGES;

export interface LineRange {
	from: number;
	to: number;
}

/** What every source kind carries: the source pane, its title at capture, and its working directory. */
interface PaneFields {
	pane?: number;
	title?: string;
	cwd?: string;
}

export type CaptureSource =
	| (PaneFields & { kind: "file"; path: string; lines?: LineRange; lang?: string; dirty?: boolean; host?: string })
	| (PaneFields & { kind: "terminal" })
	| (PaneFields & { kind: "chat" });

export interface CaptureRecord {
	v: 1;
	id: string;
	source: CaptureSource;
	text: string;
	clipped: boolean;
}

export interface Note {
	id: string;
	session: string;
	capture: CaptureRecord;
	comment: string;
	revision: number;
}

/**
 * Live chat names by pane id, and the ids of the captures made in this OMP process. A stored pane id
 * from an earlier process can name another pane now, so only these captures use the live names.
 */
export interface ChatTitles {
	names: ReadonlyMap<number, string>;
	live: ReadonlySet<string>;
}

type Row = { id: string; session: string; capture: string; comment: string; revision: number };

/** A rejected capture record; `code` tells the reasons apart. */
export class CaptureError extends Error {
	constructor(readonly code: CaptureErrorCode) {
		super(MESSAGES[code]);
	}
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optional(value: unknown, valid: (value: unknown) => boolean): boolean {
	return value === undefined || valid(value);
}

function isText(value: unknown): boolean {
	return typeof value === "string" && value.length <= MAX_FIELD_LENGTH;
}

function isLineRange(value: unknown): boolean {
	if (!object(value) || !Number.isSafeInteger(value.from) || !Number.isSafeInteger(value.to)) return false;
	return Number(value.from) >= 1 && Number(value.to) >= Number(value.from);
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new CaptureError("invalid-record");
	}
}

function assertSource(source: unknown): asserts source is CaptureSource {
	if (!object(source)) throw new CaptureError("invalid-record");
	if (!KINDS.has(source.kind)) throw new CaptureError("unknown-source");
	const strings = STRING_FIELDS.every(key => optional(source[key], isText));
	const pane = optional(source.pane, value => Number.isSafeInteger(value) && Number(value) >= 0);
	const dirty = optional(source.dirty, value => typeof value === "boolean");
	const lines = optional(source.lines, isLineRange);
	const path = source.kind !== "file" || (typeof source.path === "string" && source.path !== "");
	if (!strings || !pane || !dirty || !lines || !path) throw new CaptureError("invalid-source");
}

function assertCapture(value: unknown): asserts value is CaptureRecord {
	if (!object(value) || value.v !== 1 || typeof value.clipped !== "boolean") throw new CaptureError("invalid-record");
	// The id becomes a SQLite key and a native node key.
	const { id, text } = value;
	if (typeof id !== "string" || !id.trim() || id.length > MAX_ID_LENGTH) throw new CaptureError("invalid-record");
	if (typeof text !== "string" || text === "") throw new CaptureError("invalid-record");
	let characters = 0;
	for (const _ of text) if (++characters > MAX_SELECTION_CHARS) throw new CaptureError("selection-too-long");
	assertSource(value.source);
}

/** Validate the boundary without normalizing the captured quote. */
export function parseCapture(value: unknown): CaptureRecord {
	const record = typeof value === "string" ? parseJson(value) : value;
	assertCapture(record);
	return record;
}

/** `:5` for one line, `:3-4` for several, nothing when the lines are unknown. */
export function lineRange(lines: LineRange | undefined): string {
	if (!lines) return "";
	return lines.to === lines.from ? `:${lines.from}` : `:${lines.from}-${lines.to}`;
}

/** One value from untrusted text: control characters become spaces, whitespace runs one space, the length capped. */
function clean(value: string): string {
	const flat = value
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/g, " ")
		.trim();

	const characters = Array.from(flat);
	if (characters.length <= MAX_SOURCE_VALUE) return flat;
	return `${characters.slice(0, MAX_SOURCE_VALUE - 1).join("")}…`;
}

/** The chat's name: the live tab or pane name for a capture of this process, else the captured title, else "". */
export function chatName(capture: CaptureRecord, titles?: ChatTitles): string {
	const { pane, title } = capture.source;
	const live = pane !== undefined && titles?.live.has(capture.id) ? titles.names.get(pane) : undefined;
	return clean(live ?? "") || clean(title ?? "");
}

/** A local path strictly inside `cwd` becomes the rest after it; any other path stays as it is. */
function relativePath(path: string, cwd: string | undefined): string {
	if (!cwd) return path;
	const rest = relative(cwd, path);
	const inside = rest && rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
	return inside ? rest : path;
}

/** The source as plain text for tooltips, accessibility labels and the terminal fallback. */
export function sourceLabel(capture: CaptureRecord, titles?: ChatTitles): string {
	const { source } = capture;
	if (source.kind === "terminal") {
		const directory = clean(source.cwd ?? "");
		return directory ? `Terminal in ${directory}` : "Terminal";
	}

	if (source.kind === "chat") {
		const name = chatName(capture, titles);
		return name ? `Chat · ${name}` : "Chat";
	}

	const host = clean(source.host ?? "");
	const path = clean(source.path);
	let line = path ? `File · ${path}${lineRange(source.lines)}` : "File";
	if (host) line += ` on ${host}`;
	return source.dirty ? `${line} · unsaved` : line;
}

/** Attribute values are cleaned before escaping so only generated quotes delimit them. */
function attribute(name: string, value: string): string {
	const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `${name}="${escaped}"`;
}

function info(capture: CaptureRecord, cwd: string, titles: ChatTitles | undefined): string {
	const { source } = capture;
	let label = "text";
	if (source.kind === "file") {
		const language = source.lang ?? "";
		if (language && !/[^\w+.-]/.test(language)) label = language;
		const host = clean(source.host ?? "");
		const path = clean(host ? source.path : relativePath(source.path, cwd));
		if (path) label += ` ${attribute("file", `${path}${lineRange(source.lines)}`)}`;
		if (host) label += ` ${attribute("host", host)}`;
		if (source.dirty) label += " unsaved";
	} else if (source.kind === "terminal") {
		const directory = clean(source.cwd ?? "");
		if (directory) label += ` ${attribute("terminal", directory)}`;
	} else {
		const name = chatName(capture, titles);
		if (name) label += ` ${attribute("chat", name)}`;
	}

	if (capture.clipped) label += " clipped";
	return label;
}

function entry({ capture, comment }: Note, cwd: string, titles: ChatTitles | undefined): string {
	const label = info(capture, cwd, titles);
	// CommonMark forbids backticks anywhere in a backtick fence's info string.
	const character = label.includes("`") ? "~" : "`";
	const runs = character === "`" ? /`+/g : /~+/g;
	let longest = 2;
	for (const run of capture.text.matchAll(runs)) longest = Math.max(longest, run[0].length);
	const fence = character.repeat(longest + 1);
	const newline = capture.text.endsWith("\n") ? "" : "\n";
	return `${fence}${label}\n${capture.text}${newline}${fence}\n${comment}`;
}

/**
 * The message for the agent. `cwd` is the OMP session's directory, against which local paths become
 * relative. One blank line separates entries; each quote precedes its unchanged comment.
 */
export function formatBatch(notes: readonly Note[], cwd: string, titles?: ChatTitles): string {
	return notes.map(note => entry(note, cwd, titles)).join("\n\n");
}

export class CommentStore {
	readonly db: Database;

	constructor(filename: string) {
		this.db = new Database(filename, { create: true });
		this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS captures (session TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(session, id));
			CREATE TABLE IF NOT EXISTS notes (
				session TEXT NOT NULL, id TEXT NOT NULL, capture TEXT NOT NULL, comment TEXT NOT NULL,
				revision INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL,
				PRIMARY KEY(session, id), CHECK(length(trim(comment)) > 0));`);
	}

	hasCapture(session: string, id: string): boolean {
		return Boolean(this.db.query("SELECT 1 FROM captures WHERE session = ? AND id = ?").get(session, id));
	}

	/** Cancellation and blank submission never enter either table. */
	accept(session: string, capture: CaptureRecord, comment: string | undefined): boolean {
		if (!comment?.trim()) return false;
		return this.db.transaction(() => {
			if (this.hasCapture(session, capture.id)) return false;
			this.db.query("INSERT INTO captures(session, id) VALUES (?, ?)").run(session, capture.id);
			this.db
				.query("INSERT INTO notes(session, id, capture, comment, created) VALUES (?, ?, ?, ?, ?)")
				.run(session, capture.id, JSON.stringify(capture), comment, Date.now());

			return true;
		})();
	}

	count(session: string): number {
		return (
			this.db.query("SELECT count(*) AS count FROM notes WHERE session = ?").get(session) as { count: number }
		).count;
	}

	list(session: string): Note[] {
		return (
			this.db
				.query(
					"SELECT id, session, capture, comment, revision FROM notes WHERE session = ? ORDER BY created, rowid",
				)
				.all(session) as Row[]
		).map(row => ({ ...row, capture: JSON.parse(row.capture) as CaptureRecord }));
	}

	update(session: string, id: string, comment: string): void {
		if (!comment.trim()) {
			this.delete(session, id);
			return;
		}

		this.db
			.query(
				"UPDATE notes SET comment = ?, revision = revision + 1 WHERE session = ? AND id = ? AND comment != ?",
			)
			.run(comment, session, id, comment);
	}

	delete(session: string, id: string): void {
		this.db.query("DELETE FROM notes WHERE session = ? AND id = ?").run(session, id);
	}

	removeAdmitted(notes: readonly Note[]): void {
		this.db.transaction(() => {
			for (const note of notes)
				this.db
					.query("DELETE FROM notes WHERE session = ? AND id = ? AND revision = ?")
					.run(note.session, note.id, note.revision);
		})();
	}

	close(): void {
		this.db.close();
	}
}

/** `send` must resolve on queue admission, not turn completion; rejection preserves the snapshot. */
export async function sendBatch(
	store: CommentStore,
	session: string,
	send: (message: string) => Promise<void>,
	cwd: string,
	titles?: ChatTitles,
): Promise<number> {
	const notes = store.list(session);
	if (!notes.length) return 0;
	await send(formatBatch(notes, cwd, titles));
	store.removeAdmitted(notes);
	return notes.length;
}
