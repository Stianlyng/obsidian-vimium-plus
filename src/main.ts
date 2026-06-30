import { Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	VimiumSettings,
	VimiumSettingTab,
} from "./settings";
import { ModeManager } from "./mode";
import { HintEngine } from "./hints/hint-engine";
import { Scroller } from "./scroll";

export default class VimiumPlugin extends Plugin {
	settings!: VimiumSettings;

	private modeManager!: ModeManager;
	private hintEngine!: HintEngine;
	private scroller!: Scroller;

	private indicatorEl: HTMLElement | null = null;
	private pendingG = false;
	private pendingGTimer: number | null = null;

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
			document,
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
		this.restoreEditorConfig();
	}

	// ---- settings -----------------------------------------------------------

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
		const key = e.key;

		// `gg` → top. Track a pending leading `g`.
		if (key === "g" && !e.shiftKey) {
			if (this.pendingG) {
				this.clearPendingG();
				this.scroller.toTop();
			} else {
				this.setPendingG();
			}
			return true;
		}
		// Any other key cancels a half-typed `g`.
		this.clearPendingG();

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
			default:
				return false;
		}
	}

	private setPendingG(): void {
		this.pendingG = true;
		this.pendingGTimer = window.setTimeout(() => {
			this.pendingG = false;
			this.pendingGTimer = null;
		}, 600);
	}

	private clearPendingG(): void {
		this.pendingG = false;
		if (this.pendingGTimer !== null) {
			window.clearTimeout(this.pendingGTimer);
			this.pendingGTimer = null;
		}
	}

	// ---- mode indicator -----------------------------------------------------

	refreshModeIndicator(): void {
		if (!this.settings.showModeIndicator) {
			this.indicatorEl?.remove();
			this.indicatorEl = null;
			return;
		}
		if (!this.indicatorEl) {
			this.indicatorEl = document.body.createDiv({
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
	const el = document.activeElement as HTMLElement | null;
	if (!el) return false;
	const tag = el.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	if (el.isContentEditable) return true;
	return false;
}
