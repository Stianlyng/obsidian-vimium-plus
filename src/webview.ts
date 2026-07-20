import { App, WorkspaceLeaf } from "obsidian";
import { VimiumSettings } from "./settings";
import {
	GuestAction,
	WebviewGuestConfig,
	initWebviewVimium,
} from "./webview-inject";

/**
 * The Electron `<webview>` element, typed structurally: `electron` isn't a
 * devDependency, so its types can't be imported. Extending HTMLElement keeps
 * focus/blur/isConnected/addEventListener available.
 */
interface WebviewTag extends HTMLElement {
	executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

function isWebview(el: Element | null | undefined): el is WebviewTag {
	return (
		!!el &&
		typeof (el as WebviewTag).executeJavaScript === "function"
	);
}

interface TrackedWebview {
	leaf: WorkspaceLeaf;
	onDomReady: () => void;
	onConsole: (e: Event) => void;
}

const MESSAGE_PREFIX = "__vimium_plus__:";

/**
 * Host side of the Web viewer integration: injects the self-contained guest
 * script (src/webview-inject.ts) into every `<webview>`, re-injects on each
 * navigation (`dom-ready`), forwards built-in actions into the guest, and
 * listens for the guest's whitelisted console messages.
 *
 * SECURITY INVARIANT: the guest script runs in the page's main world, so any
 * page can forge its console messages. Message handling below must stay
 * limited to benign, fixed actions — never execute arbitrary command ids and
 * never terminal commands on behalf of a guest message.
 */
export class WebviewBridge {
	private app: App;
	private getSettings: () => VimiumSettings;
	private onGuestStateChange: () => void;

	private tracked = new Map<WebviewTag, TrackedWebview>();
	// Webview with a host-initiated hint session; host keydown relays letters
	// to it while set (focus() after keyboard tab-switches is unreliable).
	private relayWebview: WebviewTag | null = null;
	private reinjectTimer: number | null = null;

	constructor(
		app: App,
		getSettings: () => VimiumSettings,
		onGuestStateChange: () => void
	) {
		this.app = app;
		this.getSettings = getSettings;
		this.onGuestStateChange = onGuestStateChange;
	}

	/** The webview of the most recent leaf, or null (also when disabled). */
	activeWebview(): WebviewTag | null {
		if (!this.getSettings().enableWebviewIntegration) return null;
		return this.findWebview(this.app.workspace.getMostRecentLeaf());
	}

	/** True while host keydowns must be relayed into a guest hint session. */
	get hintRelayActive(): boolean {
		if (!this.relayWebview) return false;
		if (this.relayWebview !== this.activeWebview()) {
			this.relayWebview = null;
			return false;
		}
		return true;
	}

	/** Track and inject every webview in the workspace. Cheap; called often. */
	ensureAll(): void {
		if (!this.getSettings().enableWebviewIntegration) return;
		this.sweep();
		this.app.workspace.iterateAllLeaves((leaf) => {
			const webview = this.findWebview(leaf);
			if (!webview || this.tracked.has(webview)) return;
			const onDomReady = () => {
				// A navigation destroyed any guest hint session with its world.
				if (this.relayWebview === webview) this.relayWebview = null;
				this.inject(webview);
			};
			const onConsole = (e: Event) => this.onConsoleMessage(webview, e);
			webview.addEventListener("dom-ready", onDomReady);
			webview.addEventListener("console-message", onConsole);
			this.tracked.set(webview, { leaf, onDomReady, onConsole });
			// The webview may not be attached yet; dom-ready will retry.
			this.inject(webview);
		});
	}

	run(webview: WebviewTag, action: GuestAction): void {
		void this.callGuest(webview, `.run(${JSON.stringify(action)})`);
	}

	/**
	 * Start a guest hint session from the host key path. Arms the relay once
	 * the guest reports rendered targets; focus() is best-effort on top (so an
	 * activated text input can actually receive typing).
	 */
	startHints(webview: WebviewTag, newTab: boolean): void {
		this.callGuest(webview, `.startHints(${JSON.stringify(newTab)})`)
			.then((count) => {
				if (typeof count === "number" && count > 0) {
					this.relayWebview = webview;
					webview.focus();
				}
			})
			.catch(() => {
				// Guest missing (blank/PDF page): nothing to relay.
			});
	}

	/** Forward one hint key to the guest. Returns true if consumed. */
	relayHintKey(key: string): boolean {
		const webview = this.relayWebview;
		if (!webview) return false;
		// Same grammar as HintEngine.handleKey: everything else falls through.
		if (key !== "Escape" && key !== "Backspace" && !/^[a-zA-Z]$/.test(key)) {
			return false;
		}
		if (key === "Escape") this.relayWebview = null;
		void this.callGuest(webview, `.feedHintKey(${JSON.stringify(key)})`);
		return true;
	}

	/** Push the current settings into all live guests (debounced: saveSettings
	 * fires per keystroke in settings text fields). */
	reinjectAll(): void {
		if (this.reinjectTimer !== null) window.clearTimeout(this.reinjectTimer);
		this.reinjectTimer = window.setTimeout(() => {
			this.reinjectTimer = null;
			if (!this.getSettings().enableWebviewIntegration) return;
			this.sweep();
			for (const webview of this.tracked.keys()) this.inject(webview);
		}, 250);
	}

	/** React to the settings toggle without needing a plugin reload. */
	setEnabled(enabled: boolean): void {
		if (enabled) this.ensureAll();
		else this.releaseAll();
	}

	destroy(): void {
		if (this.reinjectTimer !== null) {
			window.clearTimeout(this.reinjectTimer);
			this.reinjectTimer = null;
		}
		this.releaseAll();
	}

	// ---- internals ----------------------------------------------------------

	private findWebview(leaf: WorkspaceLeaf | null): WebviewTag | null {
		const el = leaf?.view?.containerEl?.querySelector("webview");
		return isWebview(el) ? el : null;
	}

	private sweep(): void {
		for (const [webview, entry] of this.tracked) {
			if (webview.isConnected) continue;
			webview.removeEventListener("dom-ready", entry.onDomReady);
			webview.removeEventListener("console-message", entry.onConsole);
			this.tracked.delete(webview);
			if (this.relayWebview === webview) this.relayWebview = null;
		}
	}

	/** Untrack everything and tear down the guest scripts (disable/unload). */
	private releaseAll(): void {
		this.relayWebview = null;
		for (const [webview, entry] of this.tracked) {
			void this.callGuest(webview, ".destroy()");
			webview.removeEventListener("dom-ready", entry.onDomReady);
			webview.removeEventListener("console-message", entry.onConsole);
		}
		this.tracked.clear();
	}

	private inject(webview: WebviewTag): void {
		const code =
			"(" +
			initWebviewVimium.toString() +
			")(" +
			JSON.stringify(this.buildConfig()) +
			");";
		webview.executeJavaScript(code, false).catch(() => {
			// Not attached yet, or a page that refuses scripts (PDF, crashed
			// tab): degrade silently, dom-ready will retry where possible.
		});
	}

	private callGuest(webview: WebviewTag, call: string): Promise<unknown> {
		return webview
			.executeJavaScript(
				"window.__vimiumPlusWebview && window.__vimiumPlusWebview" + call,
				false
			)
			.catch(() => undefined);
	}

	private buildConfig(): WebviewGuestConfig {
		const settings = this.getSettings();
		const keys: Record<string, GuestAction> = {
			j: "scrollDown",
			k: "scrollUp",
			d: "halfDown",
			u: "halfUp",
			gg: "top",
			G: "bottom",
			f: "hints",
			F: "hintsNewTab",
			H: "historyBack",
			L: "historyForward",
			J: "tabNext",
			K: "tabPrev",
			t: "tabNew",
			x: "tabClose",
		};
		// Custom bindings and terminal commands override built-ins on the host
		// but cannot run in the guest; drop exactly-claimed sequences so those
		// keys pass through to the site instead of doing the wrong thing.
		// (Known gap: a custom multi-key like "jj" delays j on the host but
		// not in the guest.)
		for (const binding of settings.keyBindings) {
			if (binding.key && binding.commandId) delete keys[binding.key];
		}
		for (const cmd of settings.terminalCommands) {
			if (cmd.key && cmd.command) delete keys[cmd.key];
		}
		return {
			scrollStep: settings.scrollStep,
			hintChars: settings.hintChars,
			hintFontSize: settings.hintFontSize,
			// Keep in sync with VimiumPlugin.CHORD_TIMEOUT_MS.
			chordTimeoutMs: 600,
			keys,
		};
	}

	private onConsoleMessage(webview: WebviewTag, e: Event): void {
		const raw = (e as Event & { message?: unknown }).message;
		if (typeof raw !== "string" || !raw.startsWith(MESSAGE_PREFIX)) return;
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw.slice(MESSAGE_PREFIX.length)) as Record<
				string,
				unknown
			>;
		} catch {
			return;
		}

		// See the class doc: only this fixed whitelist may ever be dispatched.
		switch (msg.type) {
			case "hints":
				if (msg.active !== true && this.relayWebview === webview) {
					this.relayWebview = null;
				}
				this.onGuestStateChange();
				break;
			case "focus-host":
				// Blurring the webview returns focus to the host document; the
				// vim keys then run through the host → bridge path again.
				webview.blur();
				break;
			case "open-url":
				this.openUrl(webview, msg.url);
				break;
			case "tab":
				this.runTabAction(msg.action);
				break;
		}
	}

	/** Open a page URL in a new tab of the same (webviewer) view type. */
	private openUrl(webview: WebviewTag, url: unknown): void {
		if (typeof url !== "string" || url.length > 2048) return;
		if (!/^https?:\/\//i.test(url)) return;
		// Copy the view type from the source leaf at runtime instead of
		// hardcoding "webviewer" (it isn't part of the public API).
		const type = this.tracked.get(webview)?.leaf.getViewState().type;
		if (type) {
			try {
				void this.app.workspace
					.getLeaf("tab")
					.setViewState({ type, state: { url }, active: true });
				return;
			} catch {
				// Fall through to window.open below.
			}
		}
		window.open(url);
	}

	private runTabAction(action: unknown): void {
		// Fixed action → command map; the guest never supplies command ids.
		const commandByAction: Record<string, string> = {
			next: "workspace:next-tab",
			prev: "workspace:previous-tab",
			new: "workspace:new-tab",
			close: "workspace:close",
		};
		const id =
			typeof action === "string" ? commandByAction[action] : undefined;
		if (id) this.app.commands.executeCommandById(id);
	}
}
