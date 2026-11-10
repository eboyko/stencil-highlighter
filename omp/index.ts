import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@oh-my-pi/pi-coding-agent";
import {
	code,
	col,
	type DescribeContext,
	Editor,
	type EditorTheme,
	getEditorTheme,
	getSelectListTheme,
	matchesKey,
	type NativeChild,
	type NativeEditorLayout,
	type NativeNode,
	type NativeUiEvent,
	node,
	row,
	SelectList,
	stripTerminalSequences,
	type TUI,
	text,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import type { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { actionBar, actionButton, selectList } from "@oh-my-pi/pi-tui/native/overlay";
import { nativeComponentId } from "@oh-my-pi/pi-tui/native/reconcile";
import {
	type ChatTitles,
	CommentStore,
	chatName,
	lineRange,
	type Note,
	parseCapture,
	sendBatch,
	sourceLabel,
} from "./comments";
import { type QuoteContext, quoteContext } from "./quote-context";

const REPEAT = "Finish the current comment: Enter saves, Esc cancels";
const EMPTY = "No comments yet. Make a selection and press Alt+C";
const SESSION_CHANGED = "The session changed. Open Comments in the original session and send again";

type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor;

/** The open dialog; a collection is opening until its factory has built it. */
type Dialog = {
	abort: AbortController;
	view: { kind: "input" } | { kind: "opening" } | { kind: "collection"; collection: Collection };
};

function terminalLine(value: string): string {
	return terminalLines(value).join(" ");
}

/** Terminal fallback only: untrusted text loses ANSI/OSC sequences and C0/C1 controls before wrapping. */
function terminalLines(value: string): string[] {
	return stripTerminalSequences(value)
		.replace(/\r\n?/g, "\n")
		.replace(/(?![\t\n])\p{Cc}/gu, "")
		.split("\n");
}

function compactSource(note: Note, titles: ChatTitles): string {
	const { source } = note.capture;
	if (source.kind === "terminal") return "Terminal";
	if (source.kind === "chat") return chatName(note.capture, titles) || "Chat";
	return fileName(source.path) + lineRange(source.lines);
}

function fileName(path: string): string {
	return path.slice(path.search(/[^/\\]*$/));
}

function sourceGroup(note: Note): string {
	const source = note.capture.source;
	if (source.kind !== "file") return JSON.stringify([source.kind]);
	return JSON.stringify([source.kind, source.host ?? "", source.path]);
}

/** One `comments.sources` entry from Tern: a live pane and its tab or pane title. */
function paneTitle(value: unknown): value is { pane: number; title: string } {
	if (typeof value !== "object" || value === null) return false;
	return "pane" in value && Number.isSafeInteger(value.pane) && "title" in value && typeof value.title === "string";
}

/** An independent field: no composer history, attachments, submit callback, or draft access. */
class CommentInput {
	readonly nativeOverlay = {
		role: "stencil-highlighter.comment-input",
		anchor: "center" as const,
		size: "md" as const,
	};
	readonly field = new Editor(getEditorTheme());

	constructor(
		private readonly tui: TUI,
		private readonly done: (value: string | undefined) => void,
	) {
		this.field.setBorderVisible(false);
		this.field.setPaddingX(0);
		this.field.describePlaceholder = () => "Comment…";
		this.field.placeholder = () => "Comment…";
		this.field.onChange = () => tui.requestRender();
	}

	get focused(): boolean {
		return this.field.focused;
	}

	set focused(value: boolean) {
		this.field.focused = value;
	}

	describe(cx: DescribeContext): NativeNode {
		return this.field.describe(cx);
	}

	render(width: number): readonly string[] {
		return this.field.render(width);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		this.field.handleNativeEvent(event);
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) this.done(undefined);
		else if (matchesKey(data, "shift+enter") || data === "\n") this.field.insertText("\n");
		else if (matchesKey(data, "enter")) this.done(this.field.getText());
		else this.field.handleInput(data);

		this.tui.requestRender();
	}

	invalidate(): void {
		this.field.invalidate();
	}
}

export class Collection {
	readonly nativeOverlay = {
		role: "omp.overlay.comments",
		head: "Comments",
		anchor: "center" as const,
		size: "lg" as const,
	};

	readonly field = new Editor(getEditorTheme());
	readonly list: SelectList;
	private notes: Note[] = [];
	private selected: string | undefined;
	private scope = "all";
	private editing = false;
	private visible: Note[] = [];
	private quote: QuoteContext | undefined;
	private sources: { id: string; label: string; icon: string; count: number; path?: string }[] = [];
	private sending = false;
	private loading = false;
	private error: string | undefined;
	private disposed = false;

	constructor(
		private readonly tui: TUI,
		private readonly store: CommentStore,
		private readonly session: string,
		private readonly send: (message: string) => Promise<void>,
		private readonly changed: () => void,
		private readonly done: () => void,
		private readonly cwd: string,
		private readonly titles: ChatTitles,
	) {
		this.list = new SelectList([], 8, getSelectListTheme(), { search: "never", emptyText: EMPTY });

		this.field.setBorderVisible(false);
		this.field.setPaddingX(0);
		this.field.setMaxHeight(8);
		this.field.describePlaceholder = () => "Comment…";
		this.field.describeLayout = input => ({
			role: "omp.field",
			children: [
				input.k === "editor"
					? {
							...input,
							p: {
								...input.p,
								min: { h: "3lines" },
								aria: "Comment",
								readonly: this.sending || !this.selected,
							},
						}
					: input,
			],
			caret: "input",
		});

		this.field.onChange = value => {
			if (this.loading || this.sending || !this.selected) return;
			// Blank edits remain in the field until navigation or close, then remove the comment.
			if (value.trim()) this.store.update(this.session, this.selected, value);
			this.error = undefined;
			this.tui.requestRender();
		};

		this.reload();
	}

	get focused(): boolean {
		return this.field.focused;
	}

	set focused(value: boolean) {
		this.field.focused = value;
	}

	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("overlay");
	}

	refreshTitles(): void {
		this.list.setItems(
			this.visible.map(note => ({
				value: note.id,
				label: terminalLine(note.comment),
				description: terminalLine(compactSource(note, this.titles)),
			})),
		);

		if (this.selected) this.list.setSelectedValue(this.selected);
		this.tui.requestRender();
	}

	describe(): NativeNode {
		const selected = this.notes.find(note => note.id === this.selected);
		if (!this.editing) {
			const all = { id: "all", label: "All sources", icon: "files", count: this.notes.length };
			const scopes = [all, ...this.sources];
			const scopeIndex = scopes.findIndex(source => source.id === this.scope);
			const blocked = (reason: string | undefined) => (this.sending ? "Sending" : reason);
			const content = col(
				[
					row(
						[
							col(
								[
									selectList(
										"sources",
										scopes.map((source, index) =>
											node(
												"item",
												{
													label: source.label,
													icon: source.icon,
													value: String(source.count),
													disabled: this.sending,
												},
												undefined,
												`source-${index}`,
											),
										),
										{ selected: `source-${scopeIndex}`, max: { lines: 12 }, aria: "Sources" },
									),
								],
								{ basis: 0.25, grow: 1, min: { w: "16ch" } },
							),
							col(
								[
									selectList(
										"comments",
										this.visible.map(note =>
											node(
												"item",
												{
													label: note.comment.replace(/\s+/g, " "),
													icon: "message",
													detail: compactSource(note, this.titles),
													disabled: this.sending,
												},
												undefined,
												note.id,
											),
										),
										{ selected: this.selected, max: { lines: 12 }, aria: "Comments", empty: EMPTY },
									),
								],
								{ basis: 0.7, grow: 2, min: { w: "24ch" } },
							),
						],
						{ gap: "md", align: "start", wrap: true },
					),
					...(this.error ? [text(this.error, { tone: "error", wrap: "word" })] : []),
					actionBar([
						actionButton("Delete", "comments.delete", {
							tone: "error",
							disabled: blocked(selected ? undefined : "No comment selected"),
						}),
						actionButton("Edit", "comments.edit", {
							keys: "enter",
							disabled: blocked(selected ? undefined : "No comment selected"),
						}),
						null,
						actionButton("Close", "close", { disabled: blocked(undefined) }),
						actionButton(this.sending ? "Sending…" : "Send all", "comments.send", {
							keys: "ctrl+enter",
							tone: "accent",
							busy: this.sending,
							disabled: blocked(this.notes.length ? undefined : "No comments to send"),
						}),
					]),
				],
				{ gap: "md" },
			);

			// The overlay is hoisted out of this full-layer col (`^sheet`), so a press outside the card
			// reaches the col's close action while presses inside the card never bubble to it.
			const overlay = {
				...this.nativeOverlay,
				modal: true,
				end: `${nativeComponentId(this)}.^sheet/collection-close`,
			};

			return node(
				"col",
				{ role: "stencil-highlighter.collection.dismiss", grow: 1, actions: { click: "close" } },
				[
					node(
						"overlay",
						overlay,
						[
							node(
								"kbd",
								{
									keys: ["escape"],
									actions: { click: "close" },
									aria: "Close comments",
									title: "Close (Esc)",
								},
								undefined,
								"collection-close",
							),
							content,
						],
						"sheet",
					),
				],
			);
		}

		const detail: NativeChild[] = [
			row(
				[
					text(selected ? compactSource(selected, this.titles) : "Comment", {
						grow: 1,
						title: selected ? sourceLabel(selected.capture, this.titles) : undefined,
					}),
					node("kbd", {
						keys: ["escape"],
						actions: { click: "comments.back" },
						aria: "Back to list",
						title: "Back to list (Esc)",
					}),
				],
				{ role: "stencil-highlighter.detail.header", gap: "sm", align: "center" },
			),
		];

		if (selected) {
			const { source } = selected.capture;
			const facts = [
				source.kind === "file" && source.dirty ? "Unsaved file" : "",
				source.kind === "file" ? (source.host ?? "") : "",
				selected.capture.clipped ? "Selection clipped" : "",
			].filter(Boolean);

			if (facts.length) detail.push(text(facts.join(" · "), { tone: "muted" }));
			const quote: QuoteContext = this.quote ?? { kind: "quote", text: selected.capture.text };
			detail.push(
				col(
					[
						code(quote.text, {
							role: "stencil-highlighter.detail.source",
							start: quote.start,
							marks: quote.kind === "context" ? quote.marks : undefined,
							lang: source.kind === "file" ? source.lang : undefined,
							numbers: source.kind === "file" && !!source.lines,
							wrap: true,
							preview: { lines: 8 },
						}),
						this.field,
					],
					{ role: "stencil-highlighter.detail.fields", gap: "lg" },
				),
			);
		}

		if (this.error) detail.push(text(this.error, { tone: "error", wrap: "word" }));
		const foot = node(
			"row",
			{ role: "stencil-highlighter.detail.footer", gap: "lg", align: "center" },
			[
				row([], { grow: 1 }),
				row([node("kbd", { keys: ["ctrl", "d"] }), text("delete", { tone: "error" })], {
					gap: "sm",
					align: "center",
					actions: { click: "comments.delete" },
					aria: "Delete comment",
				}),
			],
			"foot",
		);

		// A full in-layer sheet, not a fullscreen screen surface: the session's dock (and its Comments
		// button, which Tern's Alt+C addresses) stays live while the detail is open. The sheet is this
		// component's root node, so its footer bar child has the documented `<component>.<key>` id.
		// Tern documents overlay `end`/`foot`; OMP's wire prop types do not declare them yet.
		const sheet = {
			role: "omp.overlay.comments-detail",
			size: "full" as const,
			modal: true,
			foot: `${nativeComponentId(this)}.foot`,
			aria: selected ? sourceLabel(selected.capture, this.titles) : "Comment",
		};

		return node("overlay", sheet, [col(detail, { gap: "lg" }), foot], "detail");
	}

	render(width: number): readonly string[] {
		const selected = this.notes.find(note => note.id === this.selected);
		if (!this.editing)
			return [
				"Comments",
				...this.list.render(width),
				...(this.error ? wrapTextWithAnsi(this.error, width) : []),
				...wrapTextWithAnsi("↑/↓ select · Enter edit · Ctrl+Enter send all · Esc close", width),
			];

		return [
			"Comment",
			...(selected
				? [
						...wrapTextWithAnsi(terminalLine(sourceLabel(selected.capture, this.titles)), width),
						...terminalLines(selected.capture.text).flatMap(line => wrapTextWithAnsi(line, width)),
						...this.field.render(width),
					]
				: []),
			...(this.error ? wrapTextWithAnsi(this.error, width) : []),
			...wrapTextWithAnsi("Esc back to list · Enter new line · Ctrl+D delete", width),
		];
	}

	/** The editor is a nested component and receives its own edit events; this one gets lists and actions. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.sending) return;
		if (event.type === "select" || event.type === "activate") {
			if (event.key.endsWith("sources")) {
				const index = Number(event.item.replace(/^.*source-/, ""));
				const source = index === 0 ? "all" : this.sources[index - 1]?.id;
				if (source !== undefined) {
					this.flush();
					this.scope = source;
					this.reload();
				}
			} else this.edit(event.item);
		} else if (event.type === "action") {
			if (event.act === "close") this.editing ? this.back() : this.close();
			else if (event.act === "comments.send" && !this.editing) void this.submit();
			else if (event.act === "comments.edit") this.edit();
			else if (event.act === "comments.back") this.back();
			else if (event.act === "comments.delete") this.deleteSelected();
		}

		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.sending) return;
		if (matchesKey(data, "escape")) this.editing ? this.back() : this.close();
		else if (matchesKey(data, "ctrl+enter") || matchesKey(data, "super+enter")) {
			if (!this.editing) void this.submit();
		} else if (matchesKey(data, "ctrl+d")) this.deleteSelected();
		else if (matchesKey(data, "tab") || matchesKey(data, "alt+down")) this.move(1);
		else if (matchesKey(data, "shift+tab") || matchesKey(data, "alt+up")) this.move(-1);
		else if (!this.editing && matchesKey(data, "down")) this.move(1);
		else if (!this.editing && matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "enter") || matchesKey(data, "shift+enter") || data === "\n") {
			if (this.editing) this.field.insertText("\n");
			else this.edit();
		} else if (this.editing) this.field.handleInput(data);

		this.tui.requestRender();
	}

	invalidate(): void {
		this.field.invalidate();
		this.list.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		if (!this.sending) this.flush();
	}

	private select(id: string): void {
		if (this.sending || id === this.selected || !this.visible.some(note => note.id === id)) return;
		this.flush();
		this.reload(id);
	}

	private move(delta: number): void {
		const index = this.visible.findIndex(note => note.id === this.selected);
		const next = this.visible[(index + delta + this.visible.length) % this.visible.length];
		if (next) this.select(next.id);
	}

	private edit(id = this.selected): void {
		const note = this.visible.find(note => note.id === id);
		if (!note || this.sending || this.editing) return;
		this.select(note.id);
		this.editing = true;
		this.quote = quoteContext(note.capture);
		this.tui.requestRender();
	}

	private back(): void {
		if (this.sending) return;
		this.flush();
		this.editing = false;
		this.reload();
	}

	/** The selection moves to a neighbour within the current source filter. */
	private deleteSelected(): void {
		if (!this.selected) return;
		const index = this.visible.findIndex(note => note.id === this.selected);
		const neighbour = this.visible[index + 1] ?? this.visible[index - 1];
		this.store.delete(this.session, this.selected);
		this.selected = undefined;
		this.editing = false;
		this.reload(neighbour?.id);
	}

	private async submit(): Promise<void> {
		if (this.sending || this.disposed) return;
		this.flush();
		this.reload();
		if (!this.notes.length) return;

		this.sending = true;
		this.error = undefined;
		this.tui.requestRender();
		try {
			await sendBatch(this.store, this.session, this.send, this.cwd, this.titles);
			this.changed();
			if (!this.disposed) this.done();
		} catch (error) {
			// The rejection carries its own instruction; the comments stay for another Send all.
			this.error = `Not sent: ${error instanceof Error ? error.message : String(error)}`;
			if (!this.disposed) this.reload();
		} finally {
			this.sending = false;
			if (!this.disposed) this.tui.requestRender();
		}
	}

	private close(): void {
		if (this.sending) return;
		this.flush();
		this.done();
	}

	private flush(): void {
		if (this.selected) this.store.update(this.session, this.selected, this.field.getText());
		this.changed();
	}

	private reload(preferred = this.selected): void {
		this.notes = this.store.list(this.session);
		const sources = new Map<string, (typeof this.sources)[number]>();
		for (const note of this.notes) {
			const id = sourceGroup(note);
			const existing = sources.get(id);
			if (existing) {
				existing.count++;
				continue;
			}

			const source = note.capture.source;
			if (source.kind === "file") {
				const label = fileName(source.path) + (source.host ? ` · ${source.host}` : "");
				sources.set(id, { id, label, count: 1, path: source.path, icon: "file" });
				continue;
			}

			const terminal = source.kind === "terminal";
			const label = terminal ? "Terminal" : "Chat";
			sources.set(id, { id, label, count: 1, icon: terminal ? "terminal" : "message" });
		}

		this.sources = [...sources.values()];
		const duplicates = new Set(
			this.sources
				.filter(source => this.sources.some(other => other.id !== source.id && other.label === source.label))
				.map(source => source.label),
		);

		for (const source of this.sources) {
			if (duplicates.has(source.label) && source.path)
				source.label += ` · ${source.path.split(/[/\\]/).slice(0, -1).join("/")}`;
		}

		if (this.scope !== "all" && !sources.has(this.scope)) this.scope = "all";
		this.visible = this.scope === "all" ? this.notes : this.notes.filter(note => sourceGroup(note) === this.scope);
		this.selected = this.visible.some(note => note.id === preferred) ? preferred : this.visible[0]?.id;
		this.refreshTitles();
		const editingNote = this.editing ? this.visible.find(note => note.id === this.selected) : undefined;
		this.quote = editingNote ? quoteContext(editingNote.capture) : undefined;
		this.loading = true;
		this.field.setText(this.notes.find(note => note.id === this.selected)?.comment ?? "");
		this.loading = false;
		this.changed();
		this.tui.requestRender();
	}
}

export default function stencilHighlighter(pi: ExtensionAPI): void {
	let store: CommentStore | undefined;
	let editor: CustomEditor | undefined;
	/** The latest main-session context: the composer outlives sessions, so nothing captures an older one. */
	let context: ExtensionContext | undefined;
	let count = 0;
	let generation = 0;
	const titles = { names: new Map<number, string>(), live: new Set<string>() };
	let active: Dialog | undefined;

	function storage(): CommentStore {
		if (!store) {
			// Quotes and comments are plain text: keep the directory and database files owner-only.
			const directory = join(getAgentDir(), "data", "stencil-highlighter");
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			chmodSync(directory, 0o700);
			const filename = join(directory, "comments.db");
			closeSync(openSync(filename, "a", 0o600));
			for (const file of [filename, `${filename}-wal`, `${filename}-shm`])
				if (existsSync(file)) chmodSync(file, 0o600);
			store = new CommentStore(filename);
		}

		return store;
	}

	function currentSession(): string | undefined {
		return context?.sessionManager.getSessionId();
	}

	function refresh(): void {
		const session = currentSession();
		count = session === undefined ? 0 : storage().count(session);
		editor?.invalidate();
		editor?.tui?.requestRender();
	}

	function cancel(): void {
		generation++;
		active?.abort.abort();
		active = undefined;
	}

	async function open(ctx: ExtensionContext, value?: string): Promise<void> {
		if (!ctx.hasUI || ctx.agent.kind !== "main") return;
		const session = ctx.sessionManager.getSessionId();
		const epoch = generation;
		const dialog: Dialog = {
			abort: new AbortController(),
			view: { kind: value === undefined ? "opening" : "input" },
		};

		try {
			const capture = value === undefined ? undefined : parseCapture(value);
			if (capture && storage().hasCapture(session, capture.id)) {
				ctx.ui.notify("This selection is already saved. Press Alt+C again for another comment", "info");
				return;
			}

			if (active) {
				if (active.view.kind === "input") {
					ctx.ui.notify(REPEAT, "warning");
					return;
				}

				if (!capture) return;
				// SDK abort disposes the collection and flushes edits before showing the new field.
				active.abort.abort();
			}

			active = dialog;
			if (capture) {
				const comment = await ctx.ui.custom<string | undefined>(
					(tui, _theme, _keys, done) => new CommentInput(tui, done),
					{
						overlay: true,
						signal: dialog.abort.signal,
						overlayOptions: { anchor: "center", width: "70%", maxHeight: "50%" },
					},
				);

				const current = generation === epoch && session === currentSession();
				if (current && storage().accept(session, capture, comment)) titles.live.add(capture.id);
			} else {
				const send = (message: string) => {
					if (generation !== epoch || session !== currentSession())
						return Promise.reject(new Error(SESSION_CHANGED));
					// Explicit delivery resolves on enqueue; the default idle path awaits the entire agent turn.
					return pi.sendUserMessage(message, { deliverAs: ctx.isIdle() ? "steer" : "followUp" });
				};

				const changed = () => {
					if (generation === epoch) refresh();
				};

				await ctx.ui.custom<void>(
					(tui, _theme, _keys, done) => {
						const collection = new Collection(
							tui,
							storage(),
							session,
							send,
							changed,
							done,
							ctx.cwd,
							titles,
						);
						dialog.view = { kind: "collection", collection };
						return collection;
					},
					{
						overlay: true,
						signal: dialog.abort.signal,
						overlayOptions: { anchor: "center", width: 88, maxHeight: "80%" },
					},
				);
			}
		} catch (error) {
			if (!dialog.abort.signal.aborted)
				ctx.ui.notify(`Comments: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			if (active === dialog) active = undefined;
			if (generation === epoch) refresh();
		}
	}

	function installEditor(ui: ExtensionContext["ui"]): void {
		const base: EditorFactory | undefined = ui.getEditorComponent();
		ui.setEditorComponent((...args: Parameters<EditorFactory>) => {
			const current = base?.(...args) ?? new CustomEditor(...args);
			editor = current;
			const layout = current.describeLayout.bind(current);
			const handle = current.handleNativeEvent.bind(current);
			let cached: { base: NativeEditorLayout; count: number; result: NativeEditorLayout } | undefined;
			current.describeLayout = (...params) => {
				const original = layout(...params);
				if (cached?.base === original && cached.count === count) return cached.result;
				const button = node(
					"button",
					{
						role: "omp.btn",
						key: "omp-comments",
						icon: "message",
						text: String(count),
						tone: count ? "neutral" : "muted",
						variant: "quiet",
						size: "sm",
						title: "Comments · /comments",
						aria: `Comments: ${count}`,
						actions: { click: "comments.open" },
					},
					undefined,
					"omp-comments",
				);

				let inserted = false;
				const children = original.children.map(child => {
					if (!("k" in child) || child.k !== "row" || child.p?.role !== "omp.composer.line") return child;
					inserted = true;
					return { ...child, c: [...(child.c ?? []), button] };
				});

				if (!inserted) children.push(button);
				const result = { ...original, children };
				cached = { base: original, count, result };
				return result;
			};

			current.handleNativeEvent = event => {
				const ctx = context;
				if (ctx && event.type === "action" && event.act === "comments.sources") {
					try {
						const sources: unknown = JSON.parse(event.value ?? "");
						if (!Array.isArray(sources) || !sources.every(paneTitle)) return;
						titles.names.clear();
						for (const source of sources) titles.names.set(source.pane, source.title);
						if (active?.view.kind === "collection") active.view.collection.refreshTitles();
					} catch (error) {
						ctx.ui.notify(
							`Could not update chat names: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					}

					return;
				}

				if (ctx && event.type === "action" && (event.act === "comments.open" || event.act === "comments.add")) {
					if (event.act === "comments.add" && event.value === undefined) {
						ctx.ui.notify("The selection was not received. Press Alt+C again", "error");
						return;
					}

					void open(ctx, event.act === "comments.add" ? event.value : undefined);
					return;
				}

				handle(event);
			};

			return current;
		});
	}

	const sessionChanged = (_event: unknown, ctx: ExtensionContext) => {
		if (!ctx.hasUI || ctx.agent.kind !== "main") return;
		cancel();
		const first = context === undefined;
		context = ctx;
		// OMP keeps one composer factory across sessions; wrapping it again would stack another button.
		if (first) installEditor(ctx.ui);
		refresh();
	};

	pi.registerCommand("comments", {
		description: "Review, edit and send comments",
		handler: async (_args, ctx) => open(ctx),
	});

	pi.on("session_before_switch", (_event, ctx) => {
		if (ctx.agent.kind === "main") cancel();
	});

	pi.on("session_start", sessionChanged);
	pi.on("session_switch", sessionChanged);
	pi.on("session_branch", sessionChanged);
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		cancel();
		// A pending admission may still settle; retain the connection until process exit.
	});
}
