import { App } from "obsidian";

/**
 * Scrolls the active view's scroll container. Works for both Reading view
 * (`.markdown-preview-view`) and the editor (`.cm-scroller`), so scrolling keeps
 * working even outside the Vimium reading layer.
 */
export class Scroller {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	lineDown(step: number): void {
		this.scrollBy(step);
	}

	lineUp(step: number): void {
		this.scrollBy(-step);
	}

	halfPageDown(): void {
		const el = this.getScroller();
		if (el) this.scrollBy(el.clientHeight / 2);
	}

	halfPageUp(): void {
		const el = this.getScroller();
		if (el) this.scrollBy(-el.clientHeight / 2);
	}

	toTop(): void {
		this.getScroller()?.scrollTo({ top: 0 });
	}

	toBottom(): void {
		const el = this.getScroller();
		if (el) el.scrollTo({ top: el.scrollHeight });
	}

	private scrollBy(delta: number): void {
		this.getScroller()?.scrollBy({ top: delta });
	}

	private getScroller(): HTMLElement | null {
		const leaf = this.app.workspace.getMostRecentLeaf();
		const root = leaf?.view?.containerEl ?? document.body;
		const selectors = [".markdown-preview-view", ".cm-scroller", ".view-content"];
		for (const sel of selectors) {
			const el = root.querySelector<HTMLElement>(sel);
			if (el && el.scrollHeight > el.clientHeight) return el;
		}
		// Fall back to whichever of the candidates exists, even if not scrollable.
		for (const sel of selectors) {
			const el = root.querySelector<HTMLElement>(sel);
			if (el) return el;
		}
		return null;
	}
}
