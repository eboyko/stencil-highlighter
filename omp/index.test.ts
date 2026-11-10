import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CustomEditor, ExtensionContext, ExtensionCustomOptions } from "@oh-my-pi/pi-coding-agent";
import type { Component, DescribeContext, NativeUiEvent, TUI } from "@oh-my-pi/pi-tui";
import { type CaptureRecord, type CaptureSource, CommentStore } from "./comments";

// The SDK snapshots PI_CODING_AGENT_DIR when it is first evaluated, so every runtime SDK import
// (including ./index.ts) waits until the profile is isolated.
const profile = mkdtempSync(join(tmpdir(), "stencil-highlighter-profile-"));
process.env.PI_CODING_AGENT_DIR = profile;
afterAll(() => rmSync(profile, { recursive: true, force: true }));
const { loadExtensions } = await import("@oh-my-pi/pi-coding-agent");
const { getEditorTheme } = await import("@oh-my-pi/pi-tui");
const { Reconciler } = await import("@oh-my-pi/pi-tui/native/reconcile");
const { Collection } = await import("./index");

const EXTENSION = "./index.ts";
const NEIGHBOR = "./fixtures/composer-neighbor.ts";
const cx: DescribeContext = { cols: 100, reduceMotion: true, dark: true, supports: () => true, feature: () => false };
const tui = { requestRender() {}, setFocus() {} } as unknown as TUI;
const ESCAPE = "\u001b";
const CTRL_D = "\u0004";

type EditorFactory = (tui: TUI, theme: unknown, keybindings: unknown) => CustomEditor;
type Wire = { id: string; k: string; p?: Record<string, unknown>; c?: Wire[] };
type Dialog = { component: Component & { dispose?(): void }; closed: boolean };
type Input = { field: { setText(text: string): void }; handleInput(data: string): void };
type Panel = Component & {
	field: { setText(text: string): void };
	handleNativeEvent(event: NativeUiEvent): void;
	handleInput(data: string): void;
	describe(): unknown;
};
type Sent = { content: string; deliverAs: unknown };

let serial = 0;

function record(source: CaptureSource = { kind: "terminal" }): string {
	const capture: CaptureRecord = { v: 1, id: `capture-${++serial}`, source, text: `quote ${serial}`, clipped: false };
	return JSON.stringify(capture);
}

function action(act: string, value?: string): NativeUiEvent {
	return { type: "action", key: "omp-comments", act, value, mods: [] };
}

function count(value: unknown, key: string): number {
	if (!value || typeof value !== "object") return 0;
	const item = value as { k?: unknown; key?: unknown; c?: unknown[] };
	return (
		(typeof item.k === "string" && item.key === key ? 1 : 0) +
		(item.c ?? []).reduce<number>((sum, child) => sum + count(child, key), 0)
	);
}

/** Whether a described tree shows an error text, as a rejected send does. */
function showsError(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const item = value as { k?: unknown; p?: { tone?: unknown }; c?: unknown[] };
	return (item.k === "text" && item.p?.tone === "error") || (item.c ?? []).some(showsError);
}

/** Drains pending promise continuations (dialog results, queue admission) without a wall-clock wait. */
async function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

/** Loads extensions through OMP's own loader and drives them like interactive mode does. */
async function omp(order: readonly string[]) {
	const { extensions, errors, runtime } = await loadExtensions(
		order.map(path => resolve(import.meta.dir, path)),
		import.meta.dir,
	);

	expect(errors).toEqual([]);
	const sent: Sent[] = [];
	let admission = Promise.withResolvers<void>();
	runtime.sendUserMessage = async (content, options) => {
		sent.push({ content: String(content), deliverAs: options?.deliverAs });
		await admission.promise;
	};

	let factory: EditorFactory | undefined;
	let session = "session-0";
	let idle = true;
	const dialogs: Dialog[] = [];
	const notices: string[] = [];
	const ctx = {
		hasUI: true,
		agent: { kind: "main" },
		cwd: "/work",
		isIdle: () => idle,
		setTimeout,
		sessionManager: { getSessionId: () => session },
		ui: {
			getEditorComponent: () => factory,
			setEditorComponent: (next: EditorFactory | undefined) => {
				factory = next;
			},
			notify: (message: string) => {
				notices.push(message);
			},
			setWidget: () => {},
			// showHookCustom's contract: done or abort disposes the component exactly once, then settles.
			custom: <T>(
				make: (tui: TUI, theme: unknown, keys: unknown, done: (value: T) => void) => Dialog["component"],
				options: ExtensionCustomOptions,
			) => {
				const { promise, resolve, reject } = Promise.withResolvers<T>();
				const dialog = { closed: false } as Dialog;
				const finish = (result: () => void) => {
					if (dialog.closed) return;
					dialog.closed = true;
					dialog.component.dispose?.();
					result();
				};

				dialog.component = make(tui, undefined, undefined, value => finish(() => resolve(value)));
				options.signal?.addEventListener(
					"abort",
					() => finish(() => reject(new DOMException("Dialog aborted", "AbortError"))),
					{ once: true },
				);

				dialogs.push(dialog);
				return promise;
			},
		},
	} as unknown as ExtensionContext;

	const emit = async (name: string) => {
		for (const extension of extensions) {
			for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name }, ctx);
		}
	};

	const store = () => new CommentStore(join(profile, "data", "stencil-highlighter", "comments.db"));
	return {
		sent,
		dialogs,
		notices,
		emit,
		store,
		/** What OMP does on setEditorComponent: build the composer from the current factory. */
		composer: () => {
			if (!factory) throw new Error("The extension installed no composer factory");
			return factory(tui, getEditorTheme(), undefined);
		},
		switchTo: async (next: string, event = "session_switch") => {
			await emit("session_before_switch");
			session = next;
			await emit(event);
		},
		busy: (value: boolean) => {
			idle = !value;
		},
		admit: () => {
			admission.resolve();
			admission = Promise.withResolvers<void>();
		},
		refuse: (error: Error) => {
			admission.reject(error);
			admission = Promise.withResolvers<void>();
		},
	};
}

async function save(input: Dialog, comment: string): Promise<void> {
	const field = input.component as unknown as Input;
	field.field.setText(comment);
	field.handleInput("\r");
	await settle();
}

/** A fresh session whose comments were saved through the add action, then its open collection. */
async function collect(sources: readonly CaptureSource[]) {
	const host = await omp([EXTENSION]);
	const session = `session-${++serial}`;
	await host.switchTo(session, "session_start");
	const composer = host.composer();
	for (const [index, source] of sources.entries()) {
		composer.handleNativeEvent(action("comments.add", record(source)));
		await save(host.dialogs[host.dialogs.length - 1], `comment ${index}`);
	}

	composer.handleNativeEvent(action("comments.open"));
	const dialog = host.dialogs[host.dialogs.length - 1];
	const comments = () => {
		const db = host.store();
		const result = db.list(session).map(note => note.comment);
		db.close();
		return result;
	};

	return { host, composer, dialog, panel: dialog.component as Panel, comments };
}

/** Reconciles `layer` frame by frame into a parent map, as the terminal would apply the ops. */
function layerTree(component: Component) {
	const reconciler = new Reconciler("s:1");
	const parents = new Map<string, string>();
	const nodes = new Map<string, Wire>();
	const index = (wire: Wire, parent: string) => {
		parents.set(wire.id, parent);
		nodes.set(wire.id, wire);
		for (const child of wire.c ?? []) index(child, wire.id);
	};

	const ancestors = (id: string): string[] => {
		const parent = parents.get(id);
		return parent === undefined ? [] : [parent, ...ancestors(parent)];
	};

	return {
		ancestors,
		parents,
		nodes,
		frame: () => {
			for (const op of reconciler.reconcile({ main: [], dock: [], layer: [component] }, cx)) {
				if (op[0] === "add") index(op[4] as Wire, op[2]);
			}

			return [...nodes.values()];
		},
	};
}

function standalone(store: CommentStore) {
	const send = async () => {};
	const titles = { names: new Map<number, string>(), live: new Set<string>() };
	return new Collection(
		tui,
		store,
		"session",
		send,
		() => {},
		() => {},
		"/work",
		titles,
	);
}

describe("composer factory chaining", () => {
	const orders = [
		[EXTENSION, NEIGHBOR],
		[NEIGHBOR, EXTENSION],
	];

	for (const order of orders) {
		test(`one comment button and one neighbour control across session changes: ${order.join(" + ")}`, async () => {
			const host = await omp(order);
			await host.emit("session_start");
			const controls = () => {
				const tree = host.composer().describe(cx);
				return [count(tree, "omp-comments"), count(tree, "neighbor")];
			};

			const seen = [controls()];
			for (const [index, event] of ["session_switch", "session_branch", "session_switch"].entries()) {
				await host.switchTo(`session-${index + 1}`, event);
				seen.push(controls());
			}

			expect(seen).toEqual([
				[1, 1],
				[1, 1],
				[1, 1],
				[1, 1],
			]);
		});
	}
});

describe("dialog state", () => {
	test("a session switch cancels an open comment field without saving or blocking the next capture", async () => {
		const host = await omp([EXTENSION]);
		await host.emit("session_start");
		const composer = host.composer();
		composer.handleNativeEvent(action("comments.add", record()));
		await host.switchTo("session-1");
		expect(host.dialogs[0].closed).toBe(true);
		await save(host.dialogs[0], "too late");
		composer.handleNativeEvent(action("comments.add", record()));
		expect(host.dialogs).toHaveLength(2);
		await save(host.dialogs[1], "new session");
		const db = host.store();
		expect(db.list("session-0")).toEqual([]);
		expect(db.list("session-1").map(note => note.comment)).toEqual(["new session"]);
		expect(host.notices).toEqual([]);
		db.close();
	});

	test("a new capture replaces the open collection and keeps its edits", async () => {
		const { host, composer, dialog, panel, comments } = await collect([{ kind: "terminal" }]);
		panel.field.setText("comment 0, edited");
		composer.handleNativeEvent(action("comments.add", record()));
		expect(dialog.closed).toBe(true);
		await save(host.dialogs[host.dialogs.length - 1], "second");
		expect(comments()).toEqual(["comment 0, edited", "second"]);
	});

	test("edit, return and blank removal change only the selected comment", async () => {
		const { panel, comments } = await collect([{ kind: "terminal" }, { kind: "chat" }, { kind: "terminal" }]);
		panel.handleInput("\r");
		panel.field.setText("first, edited");
		panel.handleInput(ESCAPE);
		expect(comments()).toEqual(["first, edited", "comment 1", "comment 2"]);
		panel.handleInput("\t");
		panel.handleInput("\r");
		panel.field.setText(" \n ");
		panel.handleInput(ESCAPE);
		expect(comments()).toEqual(["first, edited", "comment 2"]);
	});

	test("deleting inside a source filter selects the next comment of that filter", async () => {
		const a: CaptureSource = { kind: "file", path: "/a.ts" };
		const b: CaptureSource = { kind: "file", path: "/b.ts" };
		const { panel, comments } = await collect([a, b, a, b, a]);
		panel.handleNativeEvent({ type: "select", key: "sheet/sources", item: "source-1" });
		panel.handleInput("\t");
		panel.handleInput(CTRL_D);
		expect(comments()).toEqual(["comment 0", "comment 1", "comment 3", "comment 4"]);
		panel.handleInput(CTRL_D);
		expect(comments()).toEqual(["comment 0", "comment 1", "comment 3"]);
	});

	test("a capture during a pending send survives the admitted batch", async () => {
		const { host, composer, panel, comments } = await collect([{ kind: "terminal" }]);
		panel.handleNativeEvent(action("comments.send"));
		await settle();
		expect(host.sent).toHaveLength(1);
		composer.handleNativeEvent(action("comments.add", record()));
		await save(host.dialogs[host.dialogs.length - 1], "captured while sending");
		host.admit();
		await settle();
		expect(host.sent[0]?.content).toContain("\ncomment 0");
		expect(host.sent[0]?.content).not.toContain("captured while sending");
		expect(comments()).toEqual(["captured while sending"]);
	});
});

describe("delivery", () => {
	test("steers an idle agent and queues a follow-up for a busy one", async () => {
		const { host, composer } = await collect([{ kind: "terminal" }]);
		(host.dialogs[host.dialogs.length - 1].component as Panel).handleNativeEvent(action("comments.send"));
		await settle();
		host.admit();
		await settle();
		host.busy(true);
		composer.handleNativeEvent(action("comments.add", record()));
		await save(host.dialogs[host.dialogs.length - 1], "while busy");
		composer.handleNativeEvent(action("comments.open"));
		(host.dialogs[host.dialogs.length - 1].component as Panel).handleNativeEvent(action("comments.send"));
		await settle();
		host.admit();
		await settle();
		expect(host.sent.map(message => message.deliverAs)).toEqual(["steer", "followUp"]);
	});

	test("a rejected send stays in the open collection with an error and keeps every comment", async () => {
		const { host, dialog, panel, comments } = await collect([{ kind: "terminal" }, { kind: "chat" }]);
		panel.handleNativeEvent(action("comments.send"));
		await settle();
		host.refuse(new Error("queue full"));
		await settle();
		expect(dialog.closed).toBe(false);
		expect(showsError(panel.describe())).toBe(true);
		expect(comments()).toEqual(["comment 0", "comment 1"]);
	});

	test("live chat names reach batch attributes for captures of this process", async () => {
		const { host, composer, panel } = await collect([{ kind: "chat", pane: 7, title: "Captured" }]);
		composer.handleNativeEvent(action("comments.sources", JSON.stringify([{ pane: 7, title: "Live tab" }])));
		panel.handleNativeEvent(action("comments.send"));
		await settle();
		expect(host.sent[0]?.content.split("\n")[0]).toBe('```text chat="Live tab"');
	});
});

describe("detail order", () => {
	test("shows the quote before the focused editor in the sheet and terminal fallback", () => {
		const store = new CommentStore(":memory:");
		const capture: CaptureRecord = {
			v: 1,
			id: "order",
			source: { kind: "terminal" },
			text: "original quote",
			clipped: false,
		};
		store.accept("session", capture, "user comment");
		const collection = standalone(store);
		collection.focused = true;
		collection.handleInput("\r");
		const all = layerTree(collection).frame();
		const fields = all.find(wire => wire.p?.role === "stencil-highlighter.detail.fields");
		expect(fields?.c?.map(child => child.p?.role)).toEqual(["stencil-highlighter.detail.source", "omp.field"]);
		expect(collection.field.focused).toBe(true);
		const terminal = collection.render(100).join("\n");
		expect(terminal.indexOf("original quote")).toBeGreaterThan(-1);
		expect(terminal.indexOf("user comment")).toBeGreaterThan(terminal.indexOf("original quote"));
		collection.handleInput("!");
		expect(store.list("session")[0]?.comment).toContain("!");
		store.close();
	});
});

describe("native sheet ids", () => {
	// Tern exposes no backdrop-dismiss prop for extension sheets yet. Outside clicks rely on the reconciler
	// hoisting the overlay out of the full-layer close target and on its `^sheet` id format for `end`.
	test("the collection is hoisted out of its close target and its Esc is the head end", () => {
		const store = new CommentStore(":memory:");
		const { ancestors, parents, nodes, frame } = layerTree(standalone(store));
		const all = frame();
		const overlay = all.find(wire => wire.k === "overlay" && wire.p?.role === "omp.overlay.comments");
		const dismiss = all.find(wire => wire.p?.role === "stencil-highlighter.collection.dismiss");
		if (!overlay || !dismiss) throw new Error("The collection rendered no overlay or close target");
		expect(parents.get(overlay.id)).toBe("layer");
		expect(parents.get(dismiss.id)).toBe("layer");
		expect(dismiss.p?.actions).toEqual({ click: "close" });
		expect(ancestors(overlay.id)).not.toContain(dismiss.id);
		const end = String(overlay.p?.end);
		expect(nodes.get(end)?.k).toBe("kbd");
		expect(ancestors(end)).toContain(overlay.id);
		store.close();
	});

	test("the detail is a full in-layer sheet whose foot is its delete footer", () => {
		const store = new CommentStore(":memory:");
		store.accept("session", JSON.parse(record()), "note");
		const collection = standalone(store);
		const { ancestors, parents, nodes, frame } = layerTree(collection);
		frame();
		(collection as unknown as Panel).handleNativeEvent(action("comments.edit"));
		const sheet = frame().find(wire => wire.k === "overlay" && wire.p?.role === "omp.overlay.comments-detail");
		if (!sheet) throw new Error("The detail rendered no sheet");
		expect(parents.get(sheet.id)).toBe("layer");
		expect(sheet.p).toMatchObject({ size: "full", modal: true });
		const foot = String(sheet.p?.foot);
		expect(nodes.get(foot)?.p?.role).toBe("stencil-highlighter.detail.footer");
		expect(ancestors(foot)).toContain(sheet.id);
		store.close();
	});
});
