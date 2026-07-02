import { App, MarkdownView, WorkspaceLeaf } from "obsidian";
import { VimiumSettings } from "./settings";

export type Mode = "reading" | "editing";

/**
 * Owns the reading/editing mode state, forces notes into Reading view while in
 * reading mode, flips into the editor on `i`, and implements the double-Escape
 * exit back to reading.
 */
export class ModeManager {
	private app: App;
	private settings: VimiumSettings;
	private onChange: () => void;

	private _mode: Mode = "reading";
	private lastEscape = 0;

	constructor(app: App, settings: VimiumSettings, onChange: () => void) {
		this.app = app;
		this.settings = settings;
		this.onChange = onChange;
	}

	get mode(): Mode {
		return this._mode;
	}

	/** Switch the active note into the editor (live preview) and focus it. */
	async enterEditing(): Promise<void> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		this._mode = "editing";
		this.lastEscape = 0;
		this.onChange();

		await this.setLeafMode(view.leaf, "source");
		const fresh = this.app.workspace.getActiveViewOfType(MarkdownView);
		fresh?.editor.focus();
	}

	/** Switch the active note back into Reading view. */
	async exitToReading(): Promise<void> {
		this._mode = "reading";
		this.onChange();

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) {
			await this.setLeafMode(view.leaf, "preview");
			// Move focus off the (now hidden) editor so global keys are captured.
			(activeDocument.activeElement as HTMLElement | null)?.blur?.();
		}
	}

	/**
	 * Handle an Escape press while in editing mode. The first Escape is left for
	 * native Vim (insert→normal); a second Escape within the timeout returns to
	 * reading. Returns true if it triggered the exit (consume the event).
	 */
	handleEditingEscape(): boolean {
		const now = Date.now();
		if (now - this.lastEscape <= this.settings.doubleEscapeMs) {
			this.lastEscape = 0;
			void this.exitToReading();
			return true;
		}
		this.lastEscape = now;
		return false;
	}

	/**
	 * Re-derive the mode from the active markdown view's actual state, so
	 * external view-mode toggles (pencil icon, Ctrl+E) can't leave us stale.
	 */
	syncFromView(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		const actual: Mode = view.getMode() === "preview" ? "reading" : "editing";
		if (actual !== this._mode) {
			this._mode = actual;
			this.lastEscape = 0;
			this.onChange();
		}
	}

	/** Force the given markdown leaf into Reading view, if not already. */
	async forceReading(leaf: WorkspaceLeaf | null): Promise<void> {
		if (!this.settings.forceReadingView) return;
		if (this._mode !== "reading") return;
		if (!leaf) return;
		const state = leaf.getViewState();
		if (state.type !== "markdown") return;
		if (state.state?.mode === "preview") return;
		await this.setLeafMode(leaf, "preview");
	}

	private async setLeafMode(
		leaf: WorkspaceLeaf,
		mode: "source" | "preview"
	): Promise<void> {
		const state = leaf.getViewState();
		if (state.type !== "markdown") return;
		state.state = { ...state.state, mode };
		if (mode === "source") {
			// Prefer live preview rather than raw source.
			state.state.source = false;
		}
		await leaf.setViewState(state);
	}
}
