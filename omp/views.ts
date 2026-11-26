import { stripVTControlCharacters } from "node:util";
import { formatTooltipKey } from "@oh-my-pi/pi-coding-agent";
import type { JSX, KeyEvent, TextEdit, UiKind } from "@oh-my-pi/pi-tui";
import { batch, computed, createRoot, nativeRendering, signal, UiNode } from "@oh-my-pi/pi-tui";
import { widgetContext, widgetFor } from "@oh-my-pi/pi-tui/term/widgets";
import {
	type ChatTitles,
	type CommentStore,
	chatName,
	lineRange,
	type Note,
	revision,
	sendBatch,
	sourceLabel,
} from "./comments";
import { quoteContext } from "./quote-context";

const EMPTY = "No comments yet. Make a selection and press Alt+C";
const listActions = { click: "select", dblclick: "activate" };
let nextSheet = 0;

function node<K extends UiKind>(
	kind: K,
	props: JSX.IntrinsicElements[K] & Readonly<Record<string, unknown>>,
): UiNode<K> {
	return new UiNode(kind, props);
}

/** The native surface takes literal text. Only the display copy going to terminal rows loses escapes. */
function display(value: string): string {
	return nativeRendering()
		? value
		: stripVTControlCharacters(value)
				.replace(/\r\n?/g, "\n")
				.replace(/(?![\t\n])\p{Cc}/gu, "");
}

/** A plain multiline editor, independent of the message composer. Edits and cursor offsets are UTF-16. */
function commentField(options: { detail?: boolean; writable?: () => boolean; changed?: (text: string) => void } = {}) {
	const line = signal({ text: "", cursor: 0 });
	const undo: { from: number; to: number; text: string; cursor: number }[] = [];
	let wordEnd = -1;
	const writable = () => options.writable?.() ?? true;
	const apply = (edit: TextEdit) => {
		const before = line.peek();
		if (!writable() || edit.len !== before.text.length) return;
		if (edit.from < 0 || edit.to < edit.from || edit.to > edit.len) return;
		const text =
			edit.from === edit.to && !edit.text
				? before.text
				: before.text.slice(0, edit.from) + edit.text + before.text.slice(edit.to);
		const cursor = Math.max(0, Math.min(edit.cursor, text.length));
		if (text !== before.text) {
			const word = edit.from === edit.to && cursor === edit.from + edit.text.length && /^\S$/u.test(edit.text);
			const previous = undo.at(-1);
			if (word && wordEnd === edit.from && previous) previous.to = cursor;
			else
				undo.push({
					from: edit.from,
					to: edit.from + edit.text.length,
					text: before.text.slice(edit.from, edit.to),
					cursor: before.cursor,
				});
			wordEnd = word ? cursor : -1;
			options.changed?.(text);
		} else wordEnd = -1;
		line.set({ text, cursor });
	};
	const editor = node("editor", {
		key: "input",
		// Keep UTF-16 offsets intact: native edits and terminal widget edits both index the stored draft.
		// A control glyph neutralizes every terminal escape without changing adjacent editable text.
		text: () => (nativeRendering() ? line().text : line().text.replace(/(?![\t\n])\p{Cc}/gu, "�")),
		cursor: () => line().cursor,
		placeholder: "Comment…",
		aria: "Comment",
		sendable: false,
		readonly: () => !writable(),
		min: options.detail ? { h: "3lines" } : undefined,
		maxLines: options.detail ? 8 : undefined,
		onEdit: apply,
		onUndo: () => {
			if (!writable()) return;
			const edit = undo.pop();
			if (!edit) return;
			const before = line.peek().text;
			const text = before.slice(0, edit.from) + edit.text + before.slice(edit.to);
			wordEnd = -1;
			line.set({ text, cursor: edit.cursor });
			options.changed?.(text);
		},
	});
	// custom() focuses the screen, not necessarily its editor. Forward raw input through the very
	// same SDK widget as a directly focused field (motions, selection, undo, kill ring and paste).
	// Only key and paste are forwarded; neither requests pointer focus.
	const cx = widgetContext([editor], { pageRows: 8, focus: () => {} });
	return {
		editor,
		text: () => line.peek().text,
		key: (key: KeyEvent) => widgetFor(editor)?.key?.(editor, key, cx) ?? false,
		paste: (text: string) => widgetFor(editor)?.paste?.(editor, { text }, cx) ?? false,
		reset(text: string) {
			undo.length = 0;
			wordEnd = -1;
			if (editor.fieldSelection) editor.fieldSelection.anchor = null;
			line.set({ text, cursor: text.length });
		},
	};
}

export function commentInput(done: (comment: string | undefined) => void, abort?: AbortSignal): UiNode {
	return createRoot(dispose => {
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			abort?.removeEventListener("abort", close);
			dispose();
		};
		const field = commentField({ writable: () => !closed });
		const root = node("overlay", {
			key: "stencil-highlighter-comment-input",
			role: "stencil-highlighter.comment-input",
			anchor: "center",
			size: "md",
			modal: true,
			children: node("col", { role: "omp.field", children: field.editor }),
			onKey: key => {
				if (closed || key.kind === "release") return true;
				if (key.id === "escape" || (key.id === "enter" && key.raw !== "\n")) {
					const value = key.id === "escape" ? undefined : field.text();
					try {
						done(value);
					} finally {
						close();
					}
				} else if (key.id === "shift+enter" || key.raw === "\n") field.paste("\n");
				else field.key(key);
				return true;
			},
			onPaste: paste => field.paste(paste.text),
		});
		root.onDispose(close);
		if (abort?.aborted) close();
		else abort?.addEventListener("abort", close, { once: true });
		return root;
	});
}

function fileName(path: string): string {
	return path.slice(path.search(/[^/\\]*$/));
}

function compactSource(note: Note, titles: ChatTitles): string {
	const { source } = note.capture;
	if (source.kind === "terminal") return "Terminal";
	if (source.kind === "chat") return chatName(note.capture, titles) || "Chat";
	return fileName(source.path) + (source.kind === "file" ? lineRange(source.lines) : "");
}

/** A git capture names a local file, so it joins that file's group. */
function sourceGroup({ capture: { source } }: Note): string {
	if (source.kind === "git") return JSON.stringify(["file", "", source.path]);
	if (source.kind === "file") return JSON.stringify(["file", source.host ?? "", source.path]);
	return source.kind;
}

function sourceGroups(notes: readonly Note[]) {
	const groups = new Map<string, { id: string; label: string; count: number; icon: string; path?: string }>();
	const labels = new Set<string>();
	const duplicates = new Set<string>();
	for (const note of notes) {
		const id = sourceGroup(note);
		const existing = groups.get(id);
		if (existing) {
			existing.count++;
			continue;
		}
		const { source } = note.capture;
		let label: string;
		if (source.kind === "file" || source.kind === "git") {
			const host = source.kind === "file" && source.host;
			label = fileName(source.path) + (host ? ` · ${host}` : "");
			groups.set(id, { id, label, icon: "file", count: 1, path: source.path });
		} else {
			const terminal = source.kind === "terminal";
			label = terminal ? "Terminal" : "Chat";
			groups.set(id, { id, label, icon: terminal ? "terminal" : "message", count: 1 });
		}
		if (labels.has(label)) duplicates.add(label);
		labels.add(label);
	}
	for (const group of groups.values()) {
		if (group.path && duplicates.has(group.label))
			group.label += ` · ${group.path.split(/[/\\]/).slice(0, -1).join("/")}`;
	}
	return [{ id: "all", label: "All sources", icon: "files", count: notes.length }, ...groups.values()];
}

interface CollectionOptions {
	store: CommentStore;
	session: string;
	send: (message: string) => Promise<void>;
	changed: () => void;
	done: () => void;
	cwd: string;
	titles: ChatTitles;
}

export interface CollectionView {
	root: UiNode;
	/** Mounted beside the dock button so the native reconciler hoists it below the sheet. */
	backdrop: UiNode;
	refreshTitles(): void;
	dispose(): void;
}

export function collectionView(options: CollectionOptions): CollectionView {
	return createRoot(dispose => buildCollection(options, dispose));
}

function buildCollection(
	{ store, session, send, changed, done, cwd, titles }: CollectionOptions,
	retire: () => void,
): CollectionView {
	const key = `stencil-highlighter-comments-${++nextSheet}`;
	const notes = signal(store.list(session));
	const scope = signal("all");
	const sources = computed(() => sourceGroups(notes()));
	const visible = computed(() =>
		scope() === "all" ? notes() : notes().filter(note => sourceGroup(note) === scope()),
	);
	const selected = signal<string | undefined>(notes.peek()[0]?.id);
	const current = computed(() => visible().find(note => note.id === selected()));
	const editing = signal(false);
	const sending = signal(false);
	const error = signal<string | undefined>(undefined);
	const titleRevision = signal(0);
	let disposed = false;
	let blank = false;
	const field = commentField({
		detail: true,
		writable: () => !disposed && editing() && !sending(),
		changed: text => {
			const id = selected.peek();
			if (!id) return;
			blank = !text.trim();
			if (!blank) store.update(session, id, text);
			error.set(undefined);
		},
	});
	function flush() {
		const id = selected.peek();
		if (blank && id) {
			store.update(session, id, field.text());
			changed();
		}
		blank = false;
	}
	function reload(preferred = selected.peek()) {
		batch(() => {
			notes.set(store.list(session));
			if (!sources().some(source => source.id === scope.peek())) scope.set("all");
			selected.set(visible().some(note => note.id === preferred) ? preferred : visible()[0]?.id);
			if (!current()) editing.set(false);
			if (editing()) field.reset(current()?.comment ?? "");
		});
		changed();
	}
	function move(delta: number) {
		const items = visible();
		const index = items.findIndex(note => note.id === selected.peek());
		const next = items[(index + delta + items.length) % items.length];
		if (next && next.id !== selected.peek()) {
			flush();
			reload(next.id);
		}
	}
	function edit(id = selected.peek()) {
		if (disposed || sending() || editing()) return;
		const note = visible().find(note => note.id === id);
		if (!note) return;
		batch(() => {
			selected.set(note.id);
			field.reset(note.comment);
			editing.set(true);
		});
	}
	function filter(item: string) {
		if (disposed || sending() || editing() || !/^source-\d+$/.test(item)) return;
		const source = sources()[Number(item.slice(7))];
		if (source) {
			scope.set(source.id);
			reload();
		}
	}
	function back() {
		flush();
		editing.set(false);
		reload();
	}
	function remove() {
		const note = current();
		if (!note) return;
		const items = visible();
		const index = items.indexOf(note);
		const neighbour = items[index + 1] ?? items[index - 1];
		store.delete(session, note.id);
		blank = false;
		editing.set(false);
		reload(neighbour?.id);
	}
	async function submit() {
		if (disposed || sending() || editing() || !notes().length) return;
		sending.set(true);
		error.set(undefined);
		try {
			await sendBatch(store, session, send, cwd, titles);
			changed();
			if (!disposed) done();
		} catch (cause) {
			if (!disposed) {
				error.set(`Not sent: ${cause instanceof Error ? cause.message : String(cause)}`);
				reload();
			}
		} finally {
			if (!disposed) sending.set(false);
		}
	}
	function action(act: string) {
		if (disposed || sending()) return;
		switch (act) {
			case "close":
				if (editing()) back();
				else done();
				break;
			case "comments.edit":
				edit();
				break;
			case "comments.back":
				if (editing()) back();
				break;
			case "comments.delete":
				remove();
				break;
			case "comments.send":
				void submit();
				break;
		}
	}
	function onKey(key: KeyEvent): boolean {
		if (disposed || sending() || key.kind === "release") return true;
		switch (key.id) {
			case "escape":
				action("close");
				break;
			case "ctrl+enter":
			case "super+enter":
				void submit();
				break;
			case "ctrl+d":
				remove();
				break;
			case "tab":
			case "alt+down":
				move(1);
				break;
			case "shift+tab":
			case "alt+up":
				move(-1);
				break;
			case "enter":
			case "shift+enter":
				if (editing()) field.paste("\n");
				else edit();
				break;
			default:
				if (editing()) field.key(key);
				else if (key.id === "down") move(1);
				else if (key.id === "up") move(-1);
		}
		return true;
	}
	const title = (note: Note, full = false) => {
		titleRevision();
		return display(full ? sourceLabel(note.capture, titles) : compactSource(note, titles));
	};
	const errorText = () => {
		const message = error();
		return message && node("text", { text: display(message), tone: "error", wrap: "word" });
	};
	const button = (act: string, label: string, keys?: string[], tone?: "accent" | "error") => {
		const reason = () => {
			if (sending()) return "Sending";
			if (act === "comments.send" && !notes().length) return "No comments to send";
			if ((act === "comments.edit" || act === "comments.delete") && !current()) return "No comment selected";
			return undefined;
		};
		const text = () => (act === "comments.send" && sending() ? "Sending…" : label);
		return node("button", {
			key: act,
			text,
			role: "omp.btn",
			keys,
			actions: { click: act },
			disabled: reason,
			title: () => reason() ?? (keys ? `${text()}  ${formatTooltipKey(keys.join("+"))}` : text()),
			tone: () => (reason() ? "muted" : tone),
			variant: () =>
				reason() ? undefined : tone === "accent" ? "primary" : tone === "error" ? "danger" : undefined,
			busy: () => act === "comments.send" && sending(),
		});
	};
	const sourceList = node("list", {
		key: "sources",
		actions: listActions,
		aria: "Sources",
		max: { lines: 12 },
		selected: () => `source-${sources().findIndex(source => source.id === scope())}`,
		onSelect: filter,
		onActivate: filter,
		children: () =>
			sources().map((source, index) =>
				node("item", {
					key: `source-${index}`,
					label: display(source.label),
					icon: source.icon,
					value: String(source.count),
					disabled: sending,
				}),
			),
	});
	const commentList = node("list", {
		key: "comments",
		actions: listActions,
		selected,
		max: { lines: 12 },
		aria: "Comments",
		empty: EMPTY,
		onSelect: edit,
		onActivate: edit,
		children: () => {
			const items = visible();
			// The terminal list painter clips from its first item; keep keyboard navigation visible.
			const start = nativeRendering() ? 0 : Math.max(0, items.findIndex(note => note.id === selected()) - 7);
			return (nativeRendering() ? items : items.slice(start, start + 8)).map(note =>
				node("item", {
					key: note.id,
					label: display(note.comment).replace(/\s+/g, " "),
					icon: "message",
					detail: () => title(note),
					disabled: sending,
				}),
			);
		},
	});
	const collection = [
		node("row", {
			gap: "md",
			align: "start",
			wrap: true,
			children: [
				node("col", { basis: 0.25, grow: 1, min: { w: "16ch" }, children: sourceList }),
				node("col", { basis: 0.7, grow: 2, min: { w: "24ch" }, children: commentList }),
			],
		}),
		errorText,
		node("row", {
			key: "actions",
			role: "omp.actions",
			gap: "sm",
			align: "center",
			children: [
				button("comments.delete", "Delete", undefined, "error"),
				button("comments.edit", "Edit", ["enter"]),
				node("spacer", { grow: 1 }),
				button("close", "Close"),
				button("comments.send", "Send all", ["ctrl", "enter"], "accent"),
			],
		}),
		() =>
			!nativeRendering() &&
			node("text", { text: "↑/↓ select · Enter edit · Ctrl+Enter send all · Esc close", wrap: "word" }),
	];
	const detail = (note: Note) => {
		const { capture } = note;
		const { source } = capture;
		const quote = quoteContext(capture);
		const facts = [
			source.kind === "file" && source.dirty && "Unsaved file",
			source.kind === "file" && source.host,
			source.kind === "git" && `${source.diff ? "Diff" : "Git"} · ${revision(source.rev)}`,
			capture.clipped && "Selection clipped",
		]
			.filter(Boolean)
			.join(" · ");
		return node("col", {
			gap: "lg",
			children: [
				node("row", {
					role: "stencil-highlighter.detail.header",
					gap: "sm",
					align: "center",
					children: [
						node("text", {
							grow: 1,
							text: () => title(note, !nativeRendering()),
							title: () => title(note, true),
						}),
						node("kbd", {
							keys: ["escape"],
							actions: { click: "comments.back" },
							aria: "Back to list",
							title: "Back to list (Esc)",
						}),
					],
				}),
				facts && node("text", { text: display(facts), tone: "muted" }),
				node("col", {
					role: "stencil-highlighter.detail.fields",
					gap: "lg",
					children: [
						node("code", {
							role: "stencil-highlighter.detail.source",
							text: display(quote.text),
							start: quote.start,
							marks: quote.kind === "context" ? quote.marks : undefined,
							lang: source.kind === "file" || source.kind === "git" ? source.lang : undefined,
							numbers: source.kind === "file" && !!source.lines,
							wrap: true,
							preview: { lines: 8 },
						}),
						node("col", { role: "omp.field", children: field.editor }),
					],
				}),
				errorText,
				() =>
					!nativeRendering() &&
					node("text", { text: "Esc back to list · Enter new line · Ctrl+D delete", wrap: "word" }),
			],
		});
	};
	const closeKey = node("kbd", {
		key: "collection-close",
		keys: ["escape"],
		actions: { click: "close" },
		aria: "Close comments",
		title: "Close (Esc)",
	});
	const foot = node("row", {
		key: "foot",
		role: "stencil-highlighter.detail.footer",
		gap: "lg",
		align: "center",
		children: [
			node("spacer", { grow: 1 }),
			node("row", {
				gap: "sm",
				align: "center",
				actions: { click: "comments.delete" },
				aria: "Delete comment",
				children: [node("kbd", { keys: ["ctrl", "d"] }), node("text", { text: "delete", tone: "error" })],
			}),
		],
	});
	// The first child is the host's keyboard focus. Keep it mounted as the list gives way to a detail;
	// native focus follows its first editor. Tern's end and foot expect absolute wire node IDs.
	const body = node("col", {
		key: "body",
		gap: () => (editing() ? undefined : "md"),
		children: () => {
			const note = editing() && current();
			return note ? detail(note) : collection;
		},
	});
	const sheet = {
		key,
		role: () => (editing() ? "omp.overlay.comments-detail" : "omp.overlay.comments"),
		anchor: "center" as const,
		size: () => (editing() ? ("full" as const) : ("lg" as const)),
		modal: true,
		head: () => (editing() ? undefined : "Comments"),
		aria: () => {
			const note = editing() && current();
			return note ? title(note, true) : "Comments";
		},
		end: () => (editing() ? undefined : `layer/${key}/collection-close`),
		foot: () => (editing() ? `layer/${key}/foot` : undefined),
		onAction: action,
		onKey,
		onPaste: ({ text }: { text: string }) => (editing() ? field.paste(text) : true),
		// A pointer may place the caret but must not transfer program focus to a field removed on Back.
		onFocus: () => {},
		children: [body, () => (editing() ? foot : closeKey)],
	};
	return {
		root: node("overlay", sheet),
		backdrop: node("overlay", {
			key: `${key}-dismiss`,
			role: "stencil-highlighter.collection.dismiss",
			size: "full",
			hidden: () => !nativeRendering() || editing(),
			actions: { click: "close" },
			onAction: act => {
				if (!editing() && act === "close") action(act);
			},
		}),
		refreshTitles: () => {
			if (!disposed) titleRevision.update(n => n + 1);
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			try {
				flush();
			} finally {
				retire();
			}
		},
	};
}
