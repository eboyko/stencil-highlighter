import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { signal, type UiHandlers, UiNode } from "@oh-my-pi/pi-tui";
import { CommentStore, parseCapture } from "./comments";
import { type CollectionView, collectionView, commentInput } from "./views";

const REPEAT = "Finish the current comment: Enter saves, Esc cancels";
const SESSION_CHANGED = "The session changed. Open Comments in the original session and send again";

/** The open dialog; a collection is opening until its factory has built it. */
type Dialog = {
	abort: AbortController;
	view: { kind: "input" } | { kind: "opening" } | { kind: "collection"; collection: CollectionView };
};

/** One `comments.sources` entry from Tern: a live pane and its tab or pane title. */
function paneTitle(value: unknown): value is { pane: number; title: string } {
	if (typeof value !== "object" || value === null) return false;
	return "pane" in value && Number.isSafeInteger(value.pane) && "title" in value && typeof value.title === "string";
}

export default function stencilHighlighter(pi: ExtensionAPI): void {
	let store: CommentStore | undefined;
	/** The latest main-session context: the composer outlives sessions, so nothing captures an older one. */
	let context: ExtensionContext | undefined;
	const count = signal(0);
	const backdrop = signal<UiNode | undefined>(undefined);
	let generation = 0;
	let widgetVersion = 0;
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
		count.set(session === undefined ? 0 : storage().count(session));
	}

	function cancel(): void {
		generation++;
		if (active?.view.kind === "collection") active.view.collection.dispose();
		backdrop.set(undefined);
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
				if (active.view.kind === "collection") active.view.collection.dispose();
				backdrop.set(undefined);
				active.abort.abort();
			}

			active = dialog;
			if (capture) {
				const comment = await ctx.ui.custom<string | undefined>(
					(_ui, _theme, _keys, done) => commentInput(done, dialog.abort.signal),
					{
						overlay: true,
						signal: dialog.abort.signal,
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
					(_ui, _theme, _keys, done) => {
						const collection = collectionView({
							store: storage(),
							session,
							send,
							changed,
							done,
							cwd: ctx.cwd,
							titles,
						});
						dialog.view = { kind: "collection", collection };
						backdrop.set(collection.backdrop);
						return collection.root;
					},
					{
						overlay: true,
						signal: dialog.abort.signal,
					},
				);
			}
		} catch (error) {
			if (!dialog.abort.signal.aborted)
				ctx.ui.notify(`Comments: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			if (dialog.view.kind === "collection") dialog.view.collection.dispose();
			if (active === dialog) {
				active = undefined;
				backdrop.set(undefined);
			}
			if (generation === epoch) refresh();
		}
	}

	const onAction: NonNullable<UiHandlers["onAction"]> = (act, event) => {
		const ctx = context;
		if (!ctx) return;
		if (act === "comments.sources") {
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
		} else if (act === "comments.add" && event.value === undefined) {
			ctx.ui.notify("The selection was not received. Press Alt+C again", "error");
		} else if (act === "comments.add" || act === "comments.open") {
			void open(ctx, act === "comments.add" ? event.value : undefined);
		}
	};

	function button(ctx: ExtensionContext, version: number) {
		const control = new UiNode("button", {
			key: "omp-comments",
			role: "omp.btn",
			icon: "message",
			text: () => String(count()),
			tone: () => (count() ? "neutral" : "muted"),
			variant: "quiet",
			size: "sm",
			title: "Comments · /comments",
			aria: () => `Comments: ${count()}`,
			actions: { click: "comments.open" },
			onAction,
		});

		const root = new UiNode("row", { justify: "end", children: [control, backdrop] });
		root.onDispose(() => {
			// OMP clears widgets before dispatching switch vetoes. An earlier veto can skip
			// our before-switch handler entirely, so recover from the widget's own lifetime.
			queueMicrotask(() => {
				if (context !== ctx || widgetVersion !== version) return;
				cancel();
				mountWidget(ctx);
			});
		});
		return root;
	}

	function mountWidget(ctx: ExtensionContext): void {
		const version = ++widgetVersion;
		ctx.ui.setWidget("omp-comments", () => button(ctx, version), { placement: "belowEditor" });
	}

	const sessionChanged = (_event: unknown, ctx: ExtensionContext) => {
		if (!ctx.hasUI || ctx.agent.kind !== "main") return;
		cancel();
		context = ctx;
		mountWidget(ctx);
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
		context = undefined;
		cancel();
		// A pending admission may still settle; retain the connection until process exit.
	});
}
