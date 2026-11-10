import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { node } from "@oh-my-pi/pi-tui";

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

/**
 * Another composer extension for the chaining tests. Like real neighbours (the English tutor),
 * it wraps the factory OMP keeps for the whole process once, on the first main session, and
 * adds its own control to the composer line.
 */
export default function composerNeighbor(pi: ExtensionAPI): void {
	let wrapped = false;
	const sessionChanged = (_event: unknown, ctx: ExtensionContext) => {
		if (wrapped || ctx.agent.kind !== "main" || !ctx.hasUI) return;
		wrapped = true;
		const base: EditorFactory | undefined = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((...args: Parameters<EditorFactory>) => {
			const current = base?.(...args) ?? new CustomEditor(...args);
			const layout = current.describeLayout.bind(current);
			current.describeLayout = (...params) => {
				const original = layout(...params);
				const badge = node("button", { key: "neighbor", text: "N", variant: "quiet" }, undefined, "neighbor");
				return { ...original, children: [...original.children, badge] };
			};

			return current;
		});
	};

	pi.on("session_start", sessionChanged);
	pi.on("session_switch", sessionChanged);
	pi.on("session_branch", sessionChanged);
}
