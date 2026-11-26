import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { UiNode } from "@oh-my-pi/pi-tui";

/** A second extension that owns a different widget below the same editor. */
export default function composerNeighbor(pi: ExtensionAPI): void {
	let veto = false;
	const sessionChanged = (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.agent.kind !== "main" || !ctx.hasUI) return;
		ctx.ui.setWidget("neighbor", () => new UiNode("button", { key: "neighbor", text: "N", variant: "quiet" }), {
			placement: "belowEditor",
		});
	};

	pi.registerCommand("neighbor-switch", {
		description: "Exercise another extension's session-switch action",
		handler: async (args, ctx) => {
			veto = args === "cancel";
			try {
				await ctx.switchSession("neighbor-session.json");
			} finally {
				veto = false;
				// The initiating extension can restore its own widget from the action result.
				sessionChanged(undefined, ctx);
			}
		},
	});
	pi.on("session_before_switch", () => (veto ? { cancel: true } : undefined));
	pi.on("session_start", sessionChanged);
	pi.on("session_switch", sessionChanged);
	pi.on("session_branch", sessionChanged);
}
