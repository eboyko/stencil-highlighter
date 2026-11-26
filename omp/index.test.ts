import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionCustomFactory,
	ExtensionCustomOptions,
	ExtensionTheme,
	ExtensionUiHost,
	ExtensionWidgetOptions,
} from "@oh-my-pi/pi-coding-agent";
import type { Accessor, Surface, UiNode } from "@oh-my-pi/pi-tui";
import type { Reconciler as NativeReconciler } from "@oh-my-pi/pi-tui/native/reconcile";
import { type CaptureRecord, type CaptureSource, CommentStore } from "./comments";

// The SDK reads profile settings during import. Even the loader must see an isolated profile.
const profile = mkdtempSync(join(tmpdir(), "stencil-highlighter-profile-"));
// Named profiles override PI_CODING_AGENT_DIR; the default profile honors it.
const originalProfile = process.env.OMP_PROFILE;
const originalDirectory = process.env.PI_CODING_AGENT_DIR;
process.env.OMP_PROFILE = "default";
process.env.PI_CODING_AGENT_DIR = profile;
afterAll(() => {
	if (originalProfile === undefined) delete process.env.OMP_PROFILE;
	else process.env.OMP_PROFILE = originalProfile;
	if (originalDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalDirectory;
	rmSync(profile, { recursive: true, force: true });
});
const { getAgentDir, KeybindingsManager, loadExtensions } = await import("@oh-my-pi/pi-coding-agent");
const { createRoot, createSurface, isUiNode, nativeRendering, resolveChildren, setNativeRenderingForTest } =
	await import("@oh-my-pi/pi-tui");
const { bubbleEvent, bubbleKey, keypathOf, pathTo } = await import("@oh-my-pi/pi-tui/dispatch");
const { Reconciler } = await import("@oh-my-pi/pi-tui/native/reconcile");
const { createTestTerminal } = await import("@oh-my-pi/pi-tui/testing/terminal");
const { PLAIN_THEME } = await import("@oh-my-pi/pi-tui/theme/plain");

const EXTENSION = "./index.ts";
const NEIGHBOR = "./fixtures/composer-neighbor.ts";
const uiHost: ExtensionUiHost = {
	requestRender() {},
	size: () => ({ columns: 120, rows: 40 }),
	suspend: run => run(),
};
const plain = (text: string) => text;
const theme: ExtensionTheme = {
	...PLAIN_THEME,
	bold: plain,
	italic: plain,
	underline: plain,
	strikethrough: plain,
	inverse: plain,
};
const keys = KeybindingsManager.inMemory();

type Dialog = { root: UiNode; focused: UiNode; closed: boolean };
type Sent = { content: string; deliverAs: unknown };
type Widget = {
	nodes: Accessor<readonly UiNode[]>;
	placement: ExtensionWidgetOptions["placement"];
	dispose: () => void;
};
type NativeCollection = {
	dialog: Dialog;
	comments: () => string[];
	surface: Surface;
	native: NativeReconciler;
};

let serial = 0;

function record(source: CaptureSource = { kind: "terminal" }): string {
	const capture: CaptureRecord = { v: 1, id: `capture-${++serial}`, source, text: `quote ${serial}`, clipped: false };
	return JSON.stringify(capture);
}

function descendants(roots: readonly UiNode[]): UiNode[] {
	return roots.flatMap(root => [root, ...descendants(root.children())]);
}

function find(roots: readonly UiNode[], predicate: (node: UiNode) => boolean, description: string): UiNode {
	const matches = descendants(roots).filter(predicate);
	if (matches.length !== 1) throw new Error(`Expected one ${description}; found ${matches.length}`);
	return matches[0];
}

function role(roots: readonly UiNode[], name: string): UiNode {
	return find(roots, node => node.props().role === name, name);
}

function field(root: UiNode): UiNode {
	return find([root], node => node.kind === "editor" || node.kind === "input", "editable field");
}

function act(roots: readonly UiNode[], node: UiNode, act: string, value?: string): void {
	const path = pathTo(roots, node);
	expect(bubbleEvent(path, { type: "action", key: keypathOf(path), act, value, mods: [] })).toBe(true);
}

function click(root: UiNode, action: string): void {
	const control = find([root], node => node.props().actions?.click === action, action);
	act([root], control, action);
}

function press(dialog: Dialog, id: string): void {
	const path = pathTo([dialog.root], dialog.focused);
	expect(bubbleKey(path, { id, kind: "press", raw: "" })).toBe(true);
}

function replaceText(root: UiNode, text: string): void {
	const editor = field(root);
	const path = pathTo([root], editor);
	const props = editor.props();
	const len = "text" in props && typeof props.text === "string" ? props.text.length : 0;
	const event = { type: "edit", key: keypathOf(path), from: 0, to: len, len, text, cursor: text.length } as const;
	expect(bubbleEvent(path, event)).toBe(true);
}

/** Drains pending dialog and queue promises without a wall-clock delay. */
async function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

/** Load through OMP and supply just the interactive host services used by these extensions. */
async function omp(order: readonly string[]) {
	expect(getAgentDir()).toBe(profile);
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

	let session = `session-${++serial}`;
	let idle = true;
	const dialogs: Dialog[] = [];
	const notices: string[] = [];
	const widgets = new Map<string, Widget>();
	const beforeSwitch: string[] = [];
	const clearWidgets = () => {
		const mounted = [...widgets.values()];
		widgets.clear();
		for (const widget of mounted) widget.dispose();
	};
	const ui = {
		notify: (message: string) => notices.push(message),
		setWidget(key, content, options) {
			widgets.get(key)?.dispose();
			if (content === undefined) {
				widgets.delete(key);
				return;
			}

			// Native widget factories belong to keyed reactive scopes. Clearing or replacing
			// an entry retires its nodes before any session lifecycle handler runs.
			createRoot(dispose => {
				const output = typeof content === "function" ? content(uiHost, theme) : content;
				widgets.set(key, {
					nodes: resolveChildren(output),
					placement: options?.placement ?? "aboveEditor",
					dispose,
				});
			});
		},
		async custom<T>(make: ExtensionCustomFactory<T>, options?: ExtensionCustomOptions): Promise<T> {
			const { promise, resolve, reject } = Promise.withResolvers<T>();
			let closed = false;
			const finish = () => {
				closed = true;
				options?.signal?.removeEventListener("abort", abort);
			};

			const abort = () => {
				finish();
				reject(options?.signal?.reason);
			};

			options?.signal?.throwIfAborted();
			options?.signal?.addEventListener("abort", abort, { once: true });
			const root = await make(uiHost, theme, keys, value => {
				finish();
				resolve(value);
			});

			if (!isUiNode(root)) throw new Error("Expected a native custom view");
			// A native overlay is its own sheet; interactive mode focuses its first child.
			// In a terminal, the host wraps the view in a sheet and focuses the supplied root.
			const focused = nativeRendering() && root.kind === "overlay" ? (root.children()[0] ?? root) : root;
			dialogs.push({
				root,
				focused,
				get closed() {
					return closed;
				},
			});
			return promise;
		},
	} satisfies Pick<ExtensionContext["ui"], "notify" | "setWidget" | "custom">;

	const ctx = {
		mode: "tui",
		hasUI: true,
		agent: { kind: "main" },
		cwd: "/work",
		isIdle: () => idle,
		setTimeout,
		sessionManager: { getSessionId: () => session },
		ui,
	} as unknown as ExtensionCommandContext;

	const emit = async (name: string) => {
		for (const extension of extensions) {
			for (const handler of extension.handlers.get(name) ?? []) {
				if (name === "session_before_switch") beforeSwitch.push(extension.path);
				const result = await handler({ type: name, reason: "resume" }, ctx);
				// The host stops before-switch dispatch at the first veto.
				if (name !== "session_before_switch" || !result || typeof result !== "object") continue;
				if ("cancel" in result && result.cancel === true) return true;
			}
		}
		return false;
	};

	const dock = () =>
		[...widgets.values()].filter(widget => widget.placement === "belowEditor").flatMap(widget => widget.nodes());
	const trigger = async (action: string, value?: string) => {
		const roots = dock();
		const button = role(roots, "omp.btn");
		act(roots, button, action, value);
		await settle();
	};

	const switchSession = async () => {
		// Extension command actions clear the dock BEFORE AgentSession asks hooks to veto.
		clearWidgets();
		if (await emit("session_before_switch")) return { cancelled: true };
		session = `session-${++serial}`;
		await emit("session_switch");
		return { cancelled: false };
	};
	const command = async (name: string, args = "") => {
		const registered = extensions
			.flatMap(extension => [...extension.commands.values()])
			.find(cmd => cmd.name === name);
		if (!registered) throw new Error(`Expected command ${name}`);
		await registered.handler(args, { ...ctx, switchSession });
		await settle();
	};
	await emit("session_start");
	return {
		sent,
		notices,
		dock,
		trigger,
		command,
		beforeSwitch,
		latest: () => {
			const latest = dialogs.at(-1);
			if (!latest || latest.closed) throw new Error("Expected an open dialog");
			return latest;
		},
		notes: (id = session) => {
			const store = new CommentStore(join(profile, "data", "stencil-highlighter", "comments.db"));
			try {
				return store.list(id);
			} finally {
				store.close();
			}
		},
		session: () => session,
		switchTo: async (event: "session_switch" | "session_branch") => {
			if (event === "session_switch") {
				await switchSession();
				await settle();
				return;
			}

			session = `session-${++serial}`;
			await emit(event);
			await settle();
		},
		shutdown: async () => {
			await emit("session_shutdown");
			clearWidgets();
			await settle();
		},
		busy: () => {
			idle = false;
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

async function save(dialog: Dialog, text: string): Promise<void> {
	replaceText(dialog.root, text);
	press(dialog, "enter");
	await settle();
	expect(dialog.closed).toBe(true);
}

async function collect(sources: readonly CaptureSource[]) {
	const host = await omp([EXTENSION]);
	for (const [index, source] of sources.entries()) {
		await host.trigger("comments.add", record(source));
		await save(host.latest(), `comment ${index}`);
	}

	await host.trigger("comments.open");
	const dialog = host.latest();
	const comments = () => host.notes().map(note => note.comment);
	expect(host.sent).toEqual([]);
	return { host, dialog, comments };
}

/** Mount like a native session: extension widgets in dock, the custom sheet directly in layer. */
async function withNativeCollection(check: (mounted: NativeCollection) => void | Promise<void>): Promise<void> {
	setNativeRenderingForTest(true);
	try {
		const { host, dialog, comments } = await collect([{ kind: "terminal" }]);
		const surface = createSurface(() => ({ dock: host.dock, layer: dialog.root }));
		const env = { cols: () => 120, rows: () => 40, hasFeature: () => false };
		const native = new Reconciler(surface, "s:1", env, () => {});
		try {
			surface.focus(dialog.focused);
			await check({ dialog, comments, surface, native });
		} finally {
			native.dispose();
			surface.dispose();
		}
	} finally {
		setNativeRenderingForTest(false);
	}
}

describe("composer widgets", () => {
	const orders = [
		[EXTENSION, NEIGHBOR],
		[NEIGHBOR, EXTENSION],
	];

	for (const order of orders) {
		test(`both widgets survive session changes without duplicates: ${order.join(" + ")}`, async () => {
			const host = await omp(order);
			const controls = () => {
				const nodes = descendants(host.dock());
				const buttons = nodes.filter(node => node.props().role === "omp.btn" && node.key() === "omp-comments");
				expect(buttons).toHaveLength(1);
				expect(buttons[0].props().actions?.click).toBe("comments.open");
				expect(nodes.filter(node => node.key() === "neighbor")).toHaveLength(1);
			};

			controls();
			for (const event of ["session_switch", "session_branch", "session_switch"] as const) {
				await host.switchTo(event);
				controls();
			}

			expect(host.sent).toEqual([]);
		});

		test(`capture recovers after an extension command's vetoed switch: ${order.join(" + ")}`, async () => {
			const host = await omp(order);
			const original = host.session();
			await host.trigger("comments.add", record());
			const abandoned = host.latest();
			replaceText(abandoned.root, "not submitted");
			await host.command("neighbor-switch", "cancel");
			expect(host.session()).toBe(original);
			expect(abandoned.closed).toBe(true);
			// An earlier veto must really skip our listener; a later veto must reach it.
			expect(host.beforeSwitch).toEqual(
				(order[0] === NEIGHBOR ? [NEIGHBOR] : order).map(path => resolve(import.meta.dir, path)),
			);
			const nodes = descendants(host.dock());
			expect(nodes.filter(node => node.key() === "omp-comments")).toHaveLength(1);
			expect(nodes.filter(node => node.key() === "neighbor")).toHaveLength(1);
			const capture = record();
			await host.trigger("comments.add", capture);
			await save(host.latest(), "original session after veto");
			expect(host.notes(original)).toMatchObject([
				{ capture: JSON.parse(capture), comment: "original session after veto" },
			]);
			expect(host.sent).toEqual([]);
			expect(host.notices).toEqual([]);
			await host.shutdown();
			expect(host.dock()).toEqual([]);
		});

		test(`an extension command's successful switch keeps capture and neighboring widgets: ${order.join(" + ")}`, async () => {
			const host = await omp(order);
			const original = host.session();
			await host.command("neighbor-switch");
			expect(host.session()).not.toBe(original);
			const nodes = descendants(host.dock());
			expect(nodes.filter(node => node.key() === "omp-comments")).toHaveLength(1);
			expect(nodes.filter(node => node.key() === "neighbor")).toHaveLength(1);
			await host.trigger("comments.add", record());
			await save(host.latest(), "switched session");
			expect(host.notes(original)).toEqual([]);
			expect(host.notes().map(note => note.comment)).toEqual(["switched session"]);
			expect(host.sent).toEqual([]);
			expect(host.notices).toEqual([]);
			await host.shutdown();
		});
	}

	test("the mounted button's count follows saved comments and the active session", async () => {
		const host = await omp([EXTENSION, NEIGHBOR]);
		const mounted = role(host.dock(), "omp.btn");
		expect(mounted.props()).toMatchObject({ text: "0" });
		await host.trigger("comments.add", record());
		await save(host.latest(), "first");
		expect(mounted.props()).toMatchObject({ text: "1" });
		await host.switchTo("session_switch");
		expect(role(host.dock(), "omp.btn").props()).toMatchObject({ text: "0" });
	});
});

describe("dialog state", () => {
	test("a session switch cancels an open field without saving or blocking the next capture", async () => {
		const host = await omp([EXTENSION]);
		const original = host.session();
		await host.trigger("comments.add", record());
		const abandoned = host.latest();
		replaceText(abandoned.root, "not submitted");
		await host.switchTo("session_switch");
		expect(abandoned.closed).toBe(true);
		await host.trigger("comments.add", record());
		await save(host.latest(), "new session");
		expect(host.notes(original)).toEqual([]);
		expect(host.notes().map(note => note.comment)).toEqual(["new session"]);
		expect(host.notices).toEqual([]);
		await host.shutdown();
		expect(host.sent).toEqual([]);
	});

	test("a new capture replaces the collection, keeping edits and the immutable quote", async () => {
		const { host, dialog, comments } = await collect([{ kind: "terminal" }]);
		const original = host.notes()[0].capture;
		press(dialog, "enter");
		replaceText(dialog.root, "comment 0, edited");
		await host.trigger("comments.add", record());
		expect(dialog.closed).toBe(true);
		await save(host.latest(), "second");
		expect(comments()).toEqual(["comment 0, edited", "second"]);
		expect(host.notes()[0].capture).toEqual(original);
	});

	test("replacing a detail sheet flushes a blank edit before the next capture", async () => {
		const { host, dialog, comments } = await collect([{ kind: "terminal" }]);
		press(dialog, "enter");
		replaceText(dialog.root, " ");
		await host.trigger("comments.add", record());
		expect(dialog.closed).toBe(true);
		press(host.latest(), "escape");
		await settle();
		expect(comments()).toEqual([]);
		expect(host.sent).toEqual([]);
	});

	test("edit, return and blank removal change only the selected comment", async () => {
		const { dialog, comments } = await collect([{ kind: "terminal" }, { kind: "chat" }, { kind: "terminal" }]);
		press(dialog, "enter");
		replaceText(dialog.root, "first, edited");
		press(dialog, "escape");
		expect(comments()).toEqual(["first, edited", "comment 1", "comment 2"]);
		press(dialog, "tab");
		press(dialog, "enter");
		replaceText(dialog.root, " \n ");
		press(dialog, "escape");
		expect(comments()).toEqual(["first, edited", "comment 2"]);
	});

	test("deleting inside a source filter selects the next comment of that filter", async () => {
		const a: CaptureSource = { kind: "file", path: "/a.ts" };
		const b: CaptureSource = { kind: "file", path: "/b.ts" };
		const { dialog, comments } = await collect([a, b, a, b, a]);
		const list = find([dialog.root], node => node.kind === "list" && node.key() === "sources", "sources list");
		const path = pathTo([dialog.root], list);
		expect(bubbleEvent(path, { type: "select", key: keypathOf(path), item: "source-1" })).toBe(true);
		press(dialog, "tab");
		press(dialog, "ctrl+d");
		expect(comments()).toEqual(["comment 0", "comment 1", "comment 3", "comment 4"]);
		press(dialog, "ctrl+d");
		expect(comments()).toEqual(["comment 0", "comment 1", "comment 3"]);
	});

	test("a capture during a pending send survives the admitted batch", async () => {
		const { host, dialog, comments } = await collect([{ kind: "terminal" }]);
		click(dialog.root, "comments.send");
		await settle();
		expect(host.sent).toHaveLength(1);
		await host.trigger("comments.add", record());
		await save(host.latest(), "captured while sending");
		host.admit();
		await settle();
		expect(host.sent[0]?.content).toContain("\ncomment 0");
		expect(host.sent[0]?.content).not.toContain("captured while sending");
		expect(comments()).toEqual(["captured while sending"]);
	});
});

describe("delivery", () => {
	test("steers an idle agent and queues a follow-up for a busy one", async () => {
		const { host, dialog } = await collect([{ kind: "terminal" }]);
		click(dialog.root, "comments.send");
		await settle();
		host.admit();
		await settle();
		host.busy();
		await host.trigger("comments.add", record());
		await save(host.latest(), "while busy");
		await host.trigger("comments.open");
		click(host.latest().root, "comments.send");
		await settle();
		host.admit();
		await settle();
		expect(host.sent.map(message => message.deliverAs)).toEqual(["steer", "followUp"]);
	});

	test("a rejected send shows an error in the open collection and keeps every comment", async () => {
		const { host, dialog, comments } = await collect([{ kind: "terminal" }, { kind: "chat" }]);
		click(dialog.root, "comments.send");
		await settle();
		host.refuse(new Error("queue full"));
		await settle();
		expect(dialog.closed).toBe(false);
		expect(descendants([dialog.root]).some(node => node.kind === "text" && node.props().tone === "error")).toBe(
			true,
		);
		expect(comments()).toEqual(["comment 0", "comment 1"]);
	});

	test("live chat names reach batch attributes for captures of this process", async () => {
		const { host, dialog } = await collect([{ kind: "chat", pane: 7, title: "Captured" }]);
		await host.trigger("comments.sources", JSON.stringify([{ pane: 7, title: "Live tab" }]));
		click(dialog.root, "comments.send");
		await settle();
		expect(host.sent[0]?.content.split("\n")[0]).toBe('```text chat="Live tab"');
		host.admit();
		await settle();
	});
});

test("the terminal shows the immutable quote before the focused, editable comment", async () => {
	const { host, dialog, comments } = await collect([{ kind: "terminal" }]);
	const quote = host.notes()[0].capture.text;
	const term = createTestTerminal(() => ({ layer: dialog.root }), { columns: 120, rows: 40 });
	try {
		term.focus(dialog.focused);
		term.press("enter");
		const rows = term.screen().join("\n");
		expect(rows.indexOf(quote)).toBeGreaterThanOrEqual(0);
		expect(rows.indexOf("comment 0")).toBeGreaterThan(rows.indexOf(quote));
		term.type("!");
		expect(comments()[0]).toContain("!");
		expect(host.notes()[0].capture.text).toBe(quote);
	} finally {
		term.dispose();
	}
});

function wireId(native: NativeReconciler, node: UiNode): string {
	const id = native.idOf(node);
	if (id === undefined) throw new Error(`No native id for ${node.kind}`);
	return id;
}

describe("native sheet ids", () => {
	test("the dock's dismiss target is hoisted behind the collection and its click closes only the sheet", () =>
		withNativeCollection(async ({ surface, native, dialog, comments }) => {
			const { ops } = native.reconcile();
			const sheet = role(surface.layer(), "omp.overlay.comments");
			const dismiss = role(surface.dock(), "stencil-highlighter.collection.dismiss");
			const end = find([sheet], node => node.key() === "collection-close", "header Esc");
			const siblings: string[] = [];
			for (const op of ops) {
				if (op[0] !== "add" || op[2] !== "layer") continue;
				siblings.splice(op[3] === null ? siblings.length : siblings.indexOf(op[3]), 0, op[1]);
			}

			expect(siblings).toEqual([wireId(native, dismiss), wireId(native, sheet)]);
			expect(end.kind).toBe("kbd");
			expect(ops).toContainEqual([
				"add",
				wireId(native, sheet),
				"layer",
				null,
				expect.objectContaining({ p: expect.objectContaining({ end: wireId(native, end) }) }),
			]);
			expect(dismiss.props().actions?.click).toBe("close");
			const path = native.resolve({ id: siblings[0] });
			if (!path) throw new Error("The native dismiss target is not addressable");
			expect(bubbleEvent(path, { type: "action", act: "close", key: keypathOf(path), mods: [] })).toBe(true);
			await settle();
			expect(dialog.closed).toBe(true);
			expect(comments()).toEqual(["comment 0"]);
		}));

	test("detail stays in the session layer with its quote before the focused editor and an addressable footer", () =>
		withNativeCollection(({ surface, native, dialog }) => {
			native.reconcile();
			click(dialog.root, "comments.edit");
			const { ops } = native.reconcile();
			const sheet = role(surface.layer(), "omp.overlay.comments-detail");
			const fields = role([sheet], "stencil-highlighter.detail.fields");
			const foot = role([sheet], "stencil-highlighter.detail.footer");
			expect(sheet).toBe(surface.layer()[0]);
			expect(ops).toContainEqual([
				"set",
				wireId(native, sheet),
				expect.objectContaining({ size: "full", foot: wireId(native, foot) }),
			]);
			expect(sheet.props()).toMatchObject({ size: "full", modal: true });
			expect(sheet.props()).not.toHaveProperty("page");
			expect(fields.children().map(child => child.props().role)).toEqual([
				"stencil-highlighter.detail.source",
				"omp.field",
			]);
			expect(ops).toContainEqual(["focus", wireId(native, field(sheet))]);
			expect(native.idOf(role(surface.dock(), "omp.btn"))).toBeDefined();
		}));
});
