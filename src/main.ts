import { MarkdownView, Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	VimiumSettings,
	VimiumSettingTab,
} from "./settings";
import { ModeManager } from "./mode";
import { HintEngine } from "./hints/hint-engine";
import { Scroller } from "./scroll";
import { WebviewBridge } from "./webview";
import {
	OmniOpenModal,
	collectBookmarkItems,
	collectRecentFileItems,
} from "./omnibar";
import { runTerminalCommand } from "./exec";

export default class VimiumPlugin extends Plugin {
	settings!: VimiumSettings;

	private modeManager!: ModeManager;
	private hintEngine!: HintEngine;
	private scroller!: Scroller;
	private webviewBridge!: WebviewBridge;

	private indicatorEl: HTMLElement | null = null;
	// Whether the native Vim layer is currently in insert mode.
	private vimInsert = false;
	// Editors whose vim adapter we subscribed to, so we can unsubscribe on unload.
	private vimBoundCms = new Set<VimAwareCm>();
	// Keys buffered while they are still a prefix of some key sequence.
	private pendingKeys = "";
	private pendingTimer: number | null = null;

	// Editor config we override and must restore on unload. Tracked with
	// explicit "did we change it" flags: the previous value may legitimately be
	// undefined (config key never set), so it can't double as the flag.
	private vimModeChanged = false;
	private prevVimMode: unknown = false;
	private viewModeChanged = false;
	private prevDefaultViewMode: unknown = "source";

	async onload(): Promise<void> {
		await this.loadSettings();

		this.modeManager = new ModeManager(this.app, this.settings, () =>
			this.refreshModeIndicator()
		);
		this.hintEngine = new HintEngine(this.app, this.settings, () =>
			this.refreshModeIndicator()
		);
		this.scroller = new Scroller(this.app);
		this.webviewBridge = new WebviewBridge(
			this.app,
			() => this.settings,
			() => this.refreshModeIndicator()
		);

		this.applyEditorConfig();

		this.addSettingTab(new VimiumSettingTab(this.app, this));

		// Capture-phase so we intercept before CodeMirror / Obsidian handlers.
		// Bound per window so pop-out windows work too.
		this.bindWindow(activeDocument);
		this.registerEvent(
			this.app.workspace.on("window-open", (win) => this.bindWindow(win.doc))
		);

		// Keep newly-activated notes in Reading view while in reading mode.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				this.watchVimMode();
				this.webviewBridge.ensureAll();
				// syncFromView no-ops on non-markdown views, so webview leaves
				// need the indicator refreshed here.
				this.refreshModeIndicator();
				void this.modeManager
					.forceReading(leaf)
					.then(() => this.modeManager.syncFromView());
			})
		);
		// External view-mode toggles (pencil icon, Ctrl+E) must not leave the
		// mode state stale.
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.watchVimMode();
				this.webviewBridge.ensureAll();
				this.modeManager.syncFromView();
			})
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				void this.modeManager.forceReading(
					this.app.workspace.getMostRecentLeaf()
				);
			})
		);

		this.registerCommands();

		this.app.workspace.onLayoutReady(() => {
			this.watchVimMode();
			this.webviewBridge.ensureAll();
			this.refreshModeIndicator();
		});
	}

	onunload(): void {
		this.webviewBridge?.destroy();
		this.hintEngine?.hide();
		this.indicatorEl?.remove();
		this.indicatorEl = null;
		for (const cm of this.vimBoundCms) {
			cm.off("vim-mode-change", this.onVimModeChange);
		}
		this.vimBoundCms.clear();
		this.clearPending();
		this.restoreEditorConfig();
	}

	// ---- settings -----------------------------------------------------------

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<VimiumSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Keep live webview guests in sync with hint/scroll settings.
		this.webviewBridge?.reinjectAll();
	}

	private applyEditorConfig(): void {
		if (this.settings.enableNativeVim) this.applyNativeVim(true);
		if (this.settings.forceReadingView) this.applyForceReadingView(true);
	}

	private restoreEditorConfig(): void {
		this.applyNativeVim(false);
		this.applyForceReadingView(false);
	}

	/** Turn the editor's global Vim setting on, or restore what it was. */
	applyNativeVim(enabled: boolean): void {
		const vault = this.app.vault;
		if (enabled) {
			if (this.vimModeChanged) return;
			this.prevVimMode = vault.getConfig("vimMode") ?? false;
			this.vimModeChanged = true;
			vault.setConfig("vimMode", true);
		} else if (this.vimModeChanged) {
			this.vimModeChanged = false;
			vault.setConfig("vimMode", this.prevVimMode);
		}
	}

	/** Set the default view mode to Reading view, or restore what it was. */
	applyForceReadingView(enabled: boolean): void {
		const vault = this.app.vault;
		if (enabled) {
			if (this.viewModeChanged) return;
			this.prevDefaultViewMode =
				vault.getConfig("defaultViewMode") ?? "source";
			this.viewModeChanged = true;
			vault.setConfig("defaultViewMode", "preview");
		} else if (this.viewModeChanged) {
			this.viewModeChanged = false;
			vault.setConfig("defaultViewMode", this.prevDefaultViewMode);
		}
	}

	/** Turn the Web viewer (webview) integration on or off at runtime. */
	applyWebviewIntegration(enabled: boolean): void {
		this.webviewBridge?.setEnabled(enabled);
		this.refreshModeIndicator();
	}

	private bindWindow(doc: Document): void {
		this.registerDomEvent(doc, "keydown", (e) => this.onKeyDown(e), {
			capture: true,
		});
	}

	// ---- commands -----------------------------------------------------------

	private registerCommands(): void {
		this.addCommand({
			id: "show-hints",
			name: "Show click hints",
			callback: () => this.showHints(false),
		});
		this.addCommand({
			id: "show-hints-new-tab",
			name: "Show click hints (open in new tab)",
			callback: () => this.showHints(true),
		});
		this.addCommand({
			id: "enter-editing",
			name: "Enter editing mode",
			callback: () => void this.modeManager.enterEditing(),
		});
		this.addCommand({
			id: "return-to-reading",
			name: "Return to reading mode",
			callback: () => void this.modeManager.exitToReading(),
		});
	}

	// ---- key routing --------------------------------------------------------

	private onKeyDown(e: KeyboardEvent): void {
		// Hint capture takes priority over everything else.
		if (this.hintEngine.active) {
			if (this.hintEngine.handleKey(e)) {
				e.preventDefault();
				e.stopPropagation();
			}
			return;
		}

		// Letters for a guest (webview) hint session started from host focus
		// are relayed into the page, since focus() after a keyboard tab-switch
		// is not reliable.
		if (this.webviewBridge.hintRelayActive) {
			if (this.webviewBridge.relayHintKey(e.key)) {
				e.preventDefault();
				e.stopPropagation();
			}
			return;
		}

		// A webview leaf is never a markdown editor, but the mode state can be
		// stale "editing" there (syncFromView no-ops without a MarkdownView),
		// so the editing branch must not swallow keys on webview leaves.
		const webviewActive = this.webviewBridge.activeWebview() !== null;
		if (!webviewActive && this.modeManager.mode === "editing") {
			if (e.key === "Escape" && !hasModifier(e)) {
				if (this.modeManager.handleEditingEscape(this.vimInsert)) {
					e.preventDefault();
					e.stopPropagation();
				}
			}
			return;
		}

		// --- reading mode ---
		if (isEditableTarget()) return;
		// Leave OS/Obsidian shortcuts (Ctrl/Cmd/Alt) untouched. Shift is ours.
		if (e.ctrlKey || e.metaKey || e.altKey) return;

		if (this.handleReadingKey(e)) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	private handleReadingKey(e: KeyboardEvent): boolean {
		// Pure modifier presses must not pollute the sequence buffer.
		if (e.key === "Shift") return false;
		return this.feedKey(e.key);
	}

	/**
	 * Advance the key-sequence state machine with one key. Custom bindings
	 * (which may be multi-key sequences like "gT") and the built-in `gg` chord
	 * are matched longest-first; while the typed keys are still a prefix of
	 * some sequence they are buffered until the chord timeout resolves the
	 * ambiguity. Custom bindings win over built-ins on an equal match.
	 */
	private feedKey(key: string): boolean {
		const hadPending = this.pendingKeys.length > 0;
		const candidate = this.pendingKeys + key;
		const targets = this.sequenceTargets();
		const exact = targets.find((t) => t.seq === candidate);
		const extendable = targets.some(
			(t) => t.seq.length > candidate.length && t.seq.startsWith(candidate)
		);

		if (extendable) {
			this.setPending(candidate, exact);
			return true;
		}
		this.clearPending();
		if (exact) {
			exact.run();
			return true;
		}
		if (hadPending) {
			// Dead-end chord: drop the buffered prefix, give this key a fresh start.
			return this.feedKey(key);
		}
		return this.runBuiltinKey(key);
	}

	/** Every multi-key-capable target: custom bindings and terminal commands first, then `gg`. */
	private sequenceTargets(): { seq: string; run: () => void }[] {
		const targets: { seq: string; run: () => void }[] = this.settings.keyBindings
			.filter((b) => b.key.length > 0 && b.commandId)
			.map((b) => ({
				seq: b.key,
				run: () => void this.app.commands.executeCommandById(b.commandId),
			}));
		for (const cmd of this.settings.terminalCommands) {
			if (cmd.key.length > 0 && cmd.command) {
				targets.push({
					seq: cmd.key,
					run: () => runTerminalCommand(this.app, cmd.command),
				});
			}
		}
		targets.push({
			seq: "gg",
			run: () => {
				const webview = this.webviewBridge.activeWebview();
				if (webview) this.webviewBridge.run(webview, "top");
				else this.scroller.toTop();
			},
		});
		return targets;
	}

	private setPending(candidate: string, exact?: { run: () => void }): void {
		this.clearPending();
		this.pendingKeys = candidate;
		this.pendingTimer = window.setTimeout(() => {
			this.pendingKeys = "";
			this.pendingTimer = null;
			// The sequence was never completed: fall back to what the buffered
			// keys meant on their own (a shorter custom binding, or a built-in).
			if (exact) {
				exact.run();
			} else if (candidate.length === 1) {
				this.runBuiltinKey(candidate);
			}
		}, VimiumPlugin.CHORD_TIMEOUT_MS);
	}

	private clearPending(): void {
		this.pendingKeys = "";
		if (this.pendingTimer !== null) {
			window.clearTimeout(this.pendingTimer);
			this.pendingTimer = null;
		}
	}

	private static readonly CHORD_TIMEOUT_MS = 600;

	private runBuiltinKey(key: string): boolean {
		// On a webview (Web viewer) leaf with host focus, scroll/hint/history
		// keys are forwarded into the guest page; everything else keeps its
		// normal Obsidian behavior.
		const webview = this.webviewBridge.activeWebview();
		switch (key) {
			case "f":
				this.showHints(false);
				return true;
			case "F":
				this.showHints(true);
				return true;
			case "j":
				if (webview) this.webviewBridge.run(webview, "scrollDown");
				else this.scroller.lineDown(this.settings.scrollStep);
				return true;
			case "k":
				if (webview) this.webviewBridge.run(webview, "scrollUp");
				else this.scroller.lineUp(this.settings.scrollStep);
				return true;
			case "J":
				this.app.commands.executeCommandById("workspace:next-tab");
				return true;
			case "K":
				this.app.commands.executeCommandById("workspace:previous-tab");
				return true;
			case "d":
				if (webview) this.webviewBridge.run(webview, "halfDown");
				else this.scroller.halfPageDown();
				return true;
			case "u":
				if (webview) this.webviewBridge.run(webview, "halfUp");
				else this.scroller.halfPageUp();
				return true;
			case "G":
				if (webview) this.webviewBridge.run(webview, "bottom");
				else this.scroller.toBottom();
				return true;
			case "i":
				void this.modeManager.enterEditing();
				return true;
			case "b":
				this.openBookmarkSearch(false);
				return true;
			case "B":
				this.openBookmarkSearch(true);
				return true;
			case "O":
				this.openOmnibar();
				return true;
			case "/":
				this.app.commands.executeCommandById("editor:open-search");
				return true;
			case "t":
				this.app.commands.executeCommandById("workspace:new-tab");
				return true;
			case "x":
				this.app.commands.executeCommandById("workspace:close");
				return true;
			case "X":
				this.app.commands.executeCommandById("workspace:undo-close-pane");
				return true;
			case "H":
				// Page history on a web tab; Obsidian leaf history elsewhere.
				if (webview) this.webviewBridge.run(webview, "historyBack");
				else this.app.commands.executeCommandById("app:go-back");
				return true;
			case "L":
				if (webview) this.webviewBridge.run(webview, "historyForward");
				else this.app.commands.executeCommandById("app:go-forward");
				return true;
		}

		return false;
	}

	/** Hints on the active surface: the webview guest if present, else the host. */
	private showHints(newTab: boolean): void {
		const webview = this.webviewBridge.activeWebview();
		if (webview) this.webviewBridge.startHints(webview, newTab);
		else this.hintEngine.show(newTab);
	}

	private openBookmarkSearch(newTab: boolean): void {
		new OmniOpenModal(
			this.app,
			collectBookmarkItems(this.app),
			newTab,
			false
		).open();
	}

	/** `O`: bookmarks + recent files + raw URLs, opening in a new tab. */
	private openOmnibar(): void {
		const items = collectBookmarkItems(this.app);
		const seen = new Set(items.map((i) => i.detail));
		for (const item of collectRecentFileItems(this.app)) {
			if (!seen.has(item.detail)) items.push(item);
		}
		new OmniOpenModal(this.app, items, true, true).open();
	}

	// ---- mode indicator -----------------------------------------------------

	refreshModeIndicator(): void {
		if (!this.settings.showModeIndicator) {
			this.indicatorEl?.remove();
			this.indicatorEl = null;
			return;
		}
		if (!this.indicatorEl) {
			this.indicatorEl = this.addStatusBarItem();
			this.indicatorEl.addClass("vimium-mode-indicator");
		}
		if (this.webviewBridge?.activeWebview()) {
			this.indicatorEl.setText("WEB");
			this.indicatorEl.toggleClass("mod-normal", false);
			this.indicatorEl.toggleClass("mod-insert", false);
			return;
		}
		const editing = this.modeManager.mode === "editing";
		const insert = editing && this.vimInsert;
		this.indicatorEl.setText(insert ? "INSERT" : editing ? "NORMAL" : "READING");
		this.indicatorEl.toggleClass("mod-normal", editing && !insert);
		this.indicatorEl.toggleClass("mod-insert", insert);
	}

	/** Subscribe to the active editor's vim adapter so the indicator can reflect insert mode. */
	private watchVimMode(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const cm = (
			view as unknown as {
				editMode?: { editor?: { cm?: { cm?: VimAwareCm } } };
			} | null
		)?.editMode?.editor?.cm?.cm;
		if (!cm?.on || this.vimBoundCms.has(cm)) return;
		this.vimBoundCms.add(cm);
		cm.on("vim-mode-change", this.onVimModeChange);
	}

	private readonly onVimModeChange = (modeObj?: { mode?: string }): void => {
		const insert = modeObj?.mode === "insert";
		if (insert === this.vimInsert) return;
		this.vimInsert = insert;
		this.refreshModeIndicator();
	};
}

/** The CM5-flavoured vim adapter Obsidian attaches to markdown editors. */
interface VimAwareCm {
	on(
		event: "vim-mode-change",
		handler: (modeObj?: { mode?: string }) => void
	): void;
	off(
		event: "vim-mode-change",
		handler: (modeObj?: { mode?: string }) => void
	): void;
}

function hasModifier(e: KeyboardEvent): boolean {
	return e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
}

/** True when focus is in a text field where our keys must not be hijacked. */
function isEditableTarget(): boolean {
	const el = activeDocument.activeElement as HTMLElement | null;
	if (!el) return false;
	const tag = el.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	if (el.isContentEditable) return true;
	return false;
}
