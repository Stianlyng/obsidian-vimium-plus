import { App, MarkdownView, WorkspaceLeaf } from "obsidian";
import { VimiumSettings } from "./settings";

export type Mode = "reading" | "editing";

/**
 * Owns the reading/editing mode state, forces notes into Reading view while in
 * reading mode, flips into the editor on `i`, and handles the Escape exit back
 * to reading.
 */
export class ModeManager {
	private app: App;
	private settings: VimiumSettings;
	private onChange: () => void;

	private _mode: Mode = "reading";

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

		const centerLine = this.getReadingCenterLine(view);

		this._mode = "editing";
		this.onChange();

		await this.setLeafMode(view.leaf, "source");
		const fresh = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (fresh && centerLine !== null) {
			const pos = { line: centerLine, ch: 0 };
			fresh.editor.setCursor(pos);
			fresh.editor.scrollIntoView({ from: pos, to: pos }, true);
		}
		fresh?.editor.focus();
	}

	/**
	 * Estimate which source line sits at the vertical center of the Reading
	 * view's viewport, so `enterEditing` can drop the cursor there instead of
	 * wherever the editor's cursor last happened to be. Obsidian only exposes
	 * the top-of-viewport line (`previewMode.getScroll()`), so the center is
	 * approximated by scaling the total line count by how much of the
	 * document's rendered height is currently visible.
	 */
	private getReadingCenterLine(view: MarkdownView): number | null {
		const totalLines = view.editor.lineCount();
		if (totalLines <= 0) return null;

		const container = view.containerEl.querySelector<HTMLElement>(
			".markdown-preview-view"
		);
		if (!container || container.scrollHeight <= 0) return null;

		const topLine = view.previewMode.getScroll();
		const viewportLines =
			(container.clientHeight / container.scrollHeight) * totalLines;
		const centerLine = Math.round(topLine + viewportLines / 2);

		return Math.min(Math.max(centerLine, 0), totalLines - 1);
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
	 * Handle an Escape press while in editing mode. In Vim insert mode the key
	 * is left for native Vim (insert→normal); otherwise it returns to reading.
	 * Returns true if it triggered the exit (consume the event).
	 */
	handleEditingEscape(vimInsert: boolean): boolean {
		if (vimInsert) return false;
		void this.exitToReading();
		return true;
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
