import { App } from "obsidian";
import { VimiumSettings } from "../settings";
import { generateHintStrings } from "./labels";

interface Hint {
	label: string;
	el: HTMLElement;
	marker: HTMLElement;
}

/**
 * Renders Vimium-style click hints over visible, clickable elements and routes
 * typed characters to activate the matching target.
 */
export class HintEngine {
	private app: App;
	private settings: VimiumSettings;

	private container: HTMLElement | null = null;
	private hints: Hint[] = [];
	private typed = "";
	private newTab = false;
	private onExit: () => void;

	constructor(app: App, settings: VimiumSettings, onExit: () => void) {
		this.app = app;
		this.settings = settings;
		this.onExit = onExit;
	}

	get active(): boolean {
		return this.container !== null;
	}

	/** Collect targets, render markers, and enter hint capture. */
	show(newTab: boolean): void {
		this.hide();
		this.newTab = newTab;

		const targets = this.collectTargets();
		if (targets.length === 0) return;

		const labels = generateHintStrings(targets.length, this.settings.hintChars);

		const container = document.body.createDiv({ cls: "vimium-hint-container" });
		container.style.setProperty(
			"--vimium-hint-font-size",
			`${this.settings.hintFontSize}px`
		);
		this.container = container;
		this.typed = "";

		targets.forEach((el, i) => {
			const label = labels[i];
			const rect = el.getBoundingClientRect();
			const marker = container.createSpan({ cls: "vimium-hint-marker" });
			marker.dataset.label = label;
			marker.setText(label);
			marker.style.left = `${Math.max(0, rect.left)}px`;
			marker.style.top = `${Math.max(0, rect.top)}px`;
			this.hints.push({ label, el, marker });
		});
	}

	/** Remove markers and reset state. */
	hide(): void {
		this.container?.remove();
		this.container = null;
		this.hints = [];
		this.typed = "";
	}

	/**
	 * Feed a keydown to the active hint session. Returns true if the event was
	 * consumed (caller should preventDefault/stopPropagation).
	 */
	handleKey(e: KeyboardEvent): boolean {
		if (!this.active) return false;

		if (e.key === "Escape") {
			this.cancel();
			return true;
		}

		if (e.key === "Backspace") {
			this.typed = this.typed.slice(0, -1);
			this.refilter();
			return true;
		}

		// Only single printable letters are hint input.
		if (e.key.length !== 1 || !/[a-zA-Z]/.test(e.key)) {
			return false;
		}

		const ch = e.key.toLowerCase();
		const candidate = this.typed + ch;
		const stillMatches = this.hints.some((h) => h.label.startsWith(candidate));
		if (!stillMatches) {
			// Ignore characters that lead nowhere.
			return true;
		}

		this.typed = candidate;
		const exact = this.hints.find((h) => h.label === this.typed);
		if (exact) {
			this.activate(exact.el);
			return true;
		}

		this.refilter();
		return true;
	}

	private cancel(): void {
		this.hide();
		this.onExit();
	}

	/** Update marker visibility / typed-prefix styling against `this.typed`. */
	private refilter(): void {
		for (const hint of this.hints) {
			const matches = hint.label.startsWith(this.typed);
			hint.marker.toggleClass("vimium-hint-filtered", !matches);
			if (matches && this.typed.length > 0) {
				hint.marker.empty();
				hint.marker.createSpan({
					cls: "vimium-hint-typed",
					text: this.typed,
				});
				hint.marker.appendText(hint.label.slice(this.typed.length));
			} else {
				hint.marker.setText(hint.label);
			}
		}
	}

	private activate(el: HTMLElement): void {
		this.hide();
		this.onExit();

		if (this.newTab) {
			this.activateNewTab(el);
		} else {
			el.click();
		}
	}

	private activateNewTab(el: HTMLElement): void {
		const linktext = el.getAttribute("data-href") ?? el.getAttribute("href");
		const isInternal =
			el.classList.contains("internal-link") ||
			(el.tagName === "A" &&
				linktext != null &&
				!/^[a-z]+:\/\//i.test(linktext) &&
				!linktext.startsWith("#"));

		if (isInternal && linktext) {
			const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
			this.app.workspace.openLinkText(linktext, sourcePath, true);
			return;
		}

		// Fall back to a modifier-click so Obsidian's own handlers open a new tab.
		el.dispatchEvent(
			new MouseEvent("click", {
				bubbles: true,
				cancelable: true,
				view: window,
				ctrlKey: true,
				metaKey: true,
			})
		);
	}

	private collectTargets(): HTMLElement[] {
		const seen = new Set<Element>();
		const targets: HTMLElement[] = [];

		for (const selector of this.settings.selectors) {
			let matches: NodeListOf<Element>;
			try {
				matches = document.querySelectorAll(selector);
			} catch {
				// Skip invalid selectors rather than aborting the whole pass.
				continue;
			}
			matches.forEach((node) => {
				if (!(node instanceof HTMLElement)) return;
				if (seen.has(node)) return;
				if (!isVisible(node)) return;
				seen.add(node);
				targets.push(node);
			});
		}

		return targets;
	}
}

function isVisible(el: HTMLElement): boolean {
	const rect = el.getBoundingClientRect();
	if (rect.width === 0 || rect.height === 0) return false;
	if (
		rect.bottom < 0 ||
		rect.right < 0 ||
		rect.top > window.innerHeight ||
		rect.left > window.innerWidth
	) {
		return false;
	}
	const style = window.getComputedStyle(el);
	if (
		style.visibility === "hidden" ||
		style.display === "none" ||
		style.opacity === "0"
	) {
		return false;
	}
	return true;
}
