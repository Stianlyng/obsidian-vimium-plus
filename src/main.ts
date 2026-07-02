import { Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	VimiumSettings,
	VimiumSettingTab,
} from "./settings";
import { ModeManager } from "./mode";
import { HintEngine } from "./hints/hint-engine";
import { Scroller } from "./scroll";
import {
	OmniOpenModal,
	collectBookmarkItems,
	collectRecentFileItems,
} from "./omnibar";

export default class VimiumPlugin extends Plugin {
	settings!: VimiumSettings;

	private modeManager!: ModeManager;
	private hintEngine!: HintEngine;
	private scroller!: Scroller;

	private indicatorEl: HTMLElement | null = null;
	// Keys buffered while they are still a prefix of some key sequence.
	private pendingKeys = "";
	private pendingTimer: number | null = null;

	// Editor config we override and must restore on unload.
	private prevVimMode: unknown = undefined;
	private prevDefaultViewMode: unknown = undefined;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.modeManager = new ModeManager(this.app, this.settings, () =>
			this.refreshModeIndicator()
		);
		this.hintEngine = new HintEngine(this.app, this.settings, () =>
			this.refreshModeIndicator()
		);
		this.scroller = new Scroller(this.app);

		this.applyEditorConfig();

		this.addSettingTab(new VimiumSettingTab(this.app, this));

		// Capture-phase so we intercept before CodeMirror / Obsidian handlers.
		this.registerDomEvent(
			activeDocument,
			"keydown",
			(e) => this.onKeyDown(e),
			{ capture: true }
		);

		// Keep newly-activated notes in Reading view while in reading mode.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				void this.modeManager.forceReading(leaf);
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

		this.app.workspace.onLayoutReady(() => this.refreshModeIndicator());
	}

	onunload(): void {
		this.hintEngine?.hide();
		this.indicatorEl?.remove();
		this.indicatorEl = null;
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
	}

	private applyEditorConfig(): void {
		const vault = this.app.vault;
		if (this.settings.enableNativeVim) {
			this.prevVimMode = vault.getConfig("vimMode");
			vault.setConfig("vimMode", true);
		}
		if (this.settings.forceReadingView) {
			this.prevDefaultViewMode = vault.getConfig("defaultViewMode");
			vault.setConfig("defaultViewMode", "preview");
		}
	}

	private restoreEditorConfig(): void {
		const vault = this.app.vault;
		if (this.prevVimMode !== undefined) {
			vault.setConfig("vimMode", this.prevVimMode);
		}
		if (this.prevDefaultViewMode !== undefined) {
			vault.setConfig("defaultViewMode", this.prevDefaultViewMode);
		}
	}

	// ---- commands -----------------------------------------------------------

	private registerCommands(): void {
		this.addCommand({
			id: "show-hints",
			name: "Show click hints",
			callback: () => this.hintEngine.show(false),
		});
		this.addCommand({
			id: "show-hints-new-tab",
			name: "Show click hints (open in new tab)",
			callback: () => this.hintEngine.show(true),
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

		if (this.modeManager.mode === "editing") {
			if (e.key === "Escape" && !hasModifier(e)) {
				if (this.modeManager.handleEditingEscape()) {
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

	/** Every multi-key-capable target: custom bindings first, then `gg`. */
	private sequenceTargets(): { seq: string; run: () => void }[] {
		const targets: { seq: string; run: () => void }[] = this.settings.keyBindings
			.filter((b) => b.key.length > 0 && b.commandId)
			.map((b) => ({
				seq: b.key,
				run: () => void this.app.commands.executeCommandById(b.commandId),
			}));
		targets.push({ seq: "gg", run: () => this.scroller.toTop() });
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
		switch (key) {
			case "f":
				this.hintEngine.show(false);
				return true;
			case "F":
				this.hintEngine.show(true);
				return true;
			case "j":
				this.scroller.lineDown(this.settings.scrollStep);
				return true;
			case "k":
				this.scroller.lineUp(this.settings.scrollStep);
				return true;
			case "J":
				this.app.commands.executeCommandById("workspace:next-tab");
				return true;
			case "K":
				this.app.commands.executeCommandById("workspace:previous-tab");
				return true;
			case "d":
				this.scroller.halfPageDown();
				return true;
			case "u":
				this.scroller.halfPageUp();
				return true;
			case "G":
				this.scroller.toBottom();
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
				this.app.commands.executeCommandById("app:go-back");
				return true;
			case "L":
				this.app.commands.executeCommandById("app:go-forward");
				return true;
		}

		return false;
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
			this.indicatorEl = activeDocument.body.createDiv({
				cls: "vimium-mode-indicator",
			});
		}
		const label =
			this.modeManager.mode === "editing" ? "-- EDITING --" : "-- READING --";
		this.indicatorEl.setText(label);
	}
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
