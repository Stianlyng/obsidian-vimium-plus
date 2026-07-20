/**
 * The script injected into Web viewer guests (Electron `<webview>` pages).
 *
 * SERIALIZATION CONTRACT: `initWebviewVimium` is shipped to the guest as
 * `"(" + initWebviewVimium.toString() + ")(" + JSON.stringify(config) + ")"`.
 * It must therefore be fully self-contained — no imports and no references to
 * anything outside its own body (esbuild minification renames module-scope
 * identifiers, which would leave dangling names in the serialized source).
 * TypeScript types are fine; they are erased. Stick to syntax that esbuild
 * lowers inline for es2018 (no constructs that emit runtime helpers).
 *
 * Guest limitations, by design: top frame only (cross-origin iframes are
 * unreachable), no shadow-DOM hint targets, and pages that registered
 * window-capture key handlers before injection can still swallow keys.
 */

/** Actions the guest can run. `tab*` are forwarded to the host as messages. */
export type GuestAction =
	| "scrollDown"
	| "scrollUp"
	| "halfDown"
	| "halfUp"
	| "top"
	| "bottom"
	| "hints"
	| "hintsNewTab"
	| "historyBack"
	| "historyForward"
	| "tabNext"
	| "tabPrev"
	| "tabNew"
	| "tabClose";

export interface WebviewGuestConfig {
	/** Pixels scrolled per j/k press. */
	scrollStep: number;
	/** Hint label alphabet, in priority order. */
	hintChars: string;
	/** Hint marker font size in px. */
	hintFontSize: number;
	/** Multi-key chord timeout; keep in sync with VimiumPlugin.CHORD_TIMEOUT_MS. */
	chordTimeoutMs: number;
	/** Key sequence → action table (built-ins minus custom-shadowed sequences). */
	keys: Record<string, GuestAction>;
}

interface GuestHint {
	label: string;
	el: HTMLElement;
	marker: HTMLElement;
}

interface GuestController {
	version: number;
	run(action: GuestAction): void;
	startHints(newTab: boolean): number;
	feedHintKey(key: string): boolean;
	destroy(): void;
}

export function initWebviewVimium(config: WebviewGuestConfig): void {
	const FLAG = "__vimiumPlusWebview";
	const win = window as unknown as Record<string, unknown>;

	// Idempotent re-init: tear down any previous instance (settings re-inject,
	// plugin reload) before installing this one.
	const prev = win[FLAG] as GuestController | undefined;
	if (prev && typeof prev.destroy === "function") {
		try {
			prev.destroy();
		} catch {
			// Never let a broken previous instance block re-injection.
		}
	}

	// ---- guest → host messaging ------------------------------------------
	// The host listens for the webview's console-message event and only acts
	// on a fixed whitelist of message types; anything here is forgeable by the
	// page itself, so it must stay benign.
	function send(msg: Record<string, unknown>): void {
		try {
			console.log("__vimium_plus__:" + JSON.stringify(msg));
		} catch {
			// Ignore: messaging is best-effort.
		}
	}

	// ---- focus / editable detection ---------------------------------------
	function deepActiveElement(): Element | null {
		let el: Element | null = document.activeElement;
		while (el && el.shadowRoot && el.shadowRoot.activeElement) {
			el = el.shadowRoot.activeElement;
		}
		return el;
	}

	function isEditable(el: Element | null): boolean {
		if (!el) return false;
		const tag = el.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
		return (el as HTMLElement).isContentEditable === true;
	}

	// ---- scrolling ----------------------------------------------------------
	// Prefer the document scroller; fall back to the largest scrollable
	// descendant for app-shell pages (Gmail-style) whose root never scrolls.
	let cachedScrollRoot: Element | null = null;

	function isScrollable(el: Element): boolean {
		if (el.scrollHeight <= el.clientHeight + 8) return false;
		const overflowY = window.getComputedStyle(el).overflowY;
		return overflowY === "auto" || overflowY === "scroll";
	}

	function getScrollRoot(): Element {
		const root = document.scrollingElement || document.documentElement;
		if (root && root.scrollHeight > root.clientHeight + 4) return root;
		if (
			cachedScrollRoot &&
			cachedScrollRoot.isConnected &&
			isScrollable(cachedScrollRoot)
		) {
			return cachedScrollRoot;
		}
		cachedScrollRoot = null;
		const all = document.querySelectorAll("*");
		const limit = Math.min(all.length, 2000);
		let best: Element | null = null;
		let bestArea = 0;
		for (let i = 0; i < limit; i++) {
			const el = all[i];
			// Cheap size check first; getComputedStyle is the expensive part.
			if (el.scrollHeight <= el.clientHeight + 8) continue;
			if (!isScrollable(el)) continue;
			const rect = el.getBoundingClientRect();
			const area = rect.width * rect.height;
			if (area > bestArea) {
				bestArea = area;
				best = el;
			}
		}
		if (best) cachedScrollRoot = best;
		return best || root || document.body;
	}

	// "instant" so sites that set CSS scroll-behavior:smooth can't hijack the
	// step feel ("auto" would follow the page's CSS).
	function scrollByY(delta: number): void {
		getScrollRoot().scrollBy({ top: delta, behavior: "instant" });
	}

	function scrollHalfPage(direction: 1 | -1): void {
		const el = getScrollRoot();
		el.scrollBy({ top: (direction * el.clientHeight) / 2, behavior: "instant" });
	}

	function scrollToEnd(direction: "top" | "bottom"): void {
		const el = getScrollRoot();
		el.scrollTo({
			top: direction === "top" ? 0 : el.scrollHeight,
			behavior: "instant",
		});
	}

	// ---- hint labels (port of src/hints/labels.ts) --------------------------
	function generateHintStrings(count: number, chars: string): string[] {
		const seen: Record<string, boolean> = {};
		const unique: string[] = [];
		for (const ch of chars.split("")) {
			if (!seen[ch]) {
				seen[ch] = true;
				unique.push(ch);
			}
		}
		const alphabet = unique.length > 1 ? unique : ["s", "a", "d", "f"];
		if (count <= 0) return [];

		const hints: string[] = [""];
		let offset = 0;
		while (hints.length - offset < count || hints.length === 1) {
			const hint = hints[offset++];
			for (const ch of alphabet) {
				hints.push(ch + hint);
			}
		}
		return hints
			.slice(offset, offset + count)
			.map((s) => s.split("").reverse().join(""))
			.sort();
	}

	// ---- hint targets (port of src/hints/hint-engine.ts semantics) ----------
	const HINT_SELECTORS = [
		"a[href]",
		"button",
		"input",
		"select",
		"textarea",
		"summary",
		"[onclick]",
		'[role="button"]',
		'[role="link"]',
		'[role="tab"]',
		'[role="menuitem"]',
		'[contenteditable=""]',
		'[contenteditable="true"]',
	].join(", ");

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

	function collectTargets(): HTMLElement[] {
		const targets: HTMLElement[] = [];
		document.querySelectorAll(HINT_SELECTORS).forEach((node) => {
			if (!(node instanceof HTMLElement)) return;
			if ((node as unknown as { disabled?: boolean }).disabled === true) return;
			if (!isVisible(node)) return;
			targets.push(node);
		});
		return targets;
	}

	// ---- hint rendering ------------------------------------------------------
	// All styling goes through CSSOM property assignment: strict page CSP
	// (style-src without unsafe-inline) blocks <style> elements and style
	// attributes, but not direct .style writes. Visual parity with the host's
	// .vimium-hint-marker rules in styles.css.
	const MARKER_STYLE: Partial<CSSStyleDeclaration> = {
		position: "fixed",
		display: "inline-block",
		padding: "0 3px",
		border: "1px solid #c08a00",
		borderRadius: "3px",
		background: "linear-gradient(#fff785, #ffc542)",
		color: "#302505",
		fontFamily: "monospace",
		fontSize: config.hintFontSize + "px",
		fontWeight: "700",
		lineHeight: "1.4",
		textTransform: "uppercase",
		boxShadow: "0 2px 4px rgba(0, 0, 0, 0.3)",
		whiteSpace: "nowrap",
		pointerEvents: "none",
	};

	interface HintSession {
		container: HTMLElement;
		hints: GuestHint[];
		typed: string;
		newTab: boolean;
	}
	let hintSession: HintSession | null = null;

	function renderMarkerText(hint: GuestHint, typed: string): void {
		hint.marker.textContent = "";
		if (typed.length > 0 && hint.label.indexOf(typed) === 0) {
			const typedSpan = document.createElement("span");
			typedSpan.textContent = typed;
			typedSpan.style.color = "#d4a017";
			typedSpan.style.opacity = "0.55";
			hint.marker.appendChild(typedSpan);
			hint.marker.appendChild(
				document.createTextNode(hint.label.slice(typed.length))
			);
		} else {
			hint.marker.textContent = hint.label;
		}
	}

	function refilterHints(): void {
		if (!hintSession) return;
		for (const hint of hintSession.hints) {
			const matches = hint.label.indexOf(hintSession.typed) === 0;
			hint.marker.style.display = matches ? "inline-block" : "none";
			renderMarkerText(hint, matches ? hintSession.typed : "");
		}
	}

	function endHints(): void {
		if (!hintSession) return;
		hintSession.container.remove();
		hintSession = null;
		send({ type: "hints", active: false });
	}

	function startHints(newTab: boolean): number {
		// Quiet teardown when restarting: an "active: false" for the replaced
		// session could reach the host after the new session armed its relay
		// and wrongly clear it. The follow-up "active: true" converges state.
		if (hintSession) {
			hintSession.container.remove();
			hintSession = null;
		}
		const targets = collectTargets();
		if (targets.length === 0) return 0;

		const labels = generateHintStrings(targets.length, config.hintChars);
		const container = document.createElement("div");
		container.setAttribute("data-vimium-plus-hints", "");
		Object.assign(container.style, {
			position: "fixed",
			inset: "0",
			pointerEvents: "none",
			zIndex: "2147483647",
		});

		const hints: GuestHint[] = [];
		targets.forEach((el, i) => {
			const rect = el.getBoundingClientRect();
			const marker = document.createElement("span");
			Object.assign(marker.style, MARKER_STYLE);
			marker.style.left = Math.max(0, rect.left) + "px";
			marker.style.top = Math.max(0, rect.top) + "px";
			const hint: GuestHint = { label: labels[i], el, marker };
			renderMarkerText(hint, "");
			container.appendChild(marker);
			hints.push(hint);
		});

		(document.body || document.documentElement).appendChild(container);
		hintSession = { container, hints, typed: "", newTab };
		send({ type: "hints", active: true });
		return targets.length;
	}

	function isTextEditableTarget(el: HTMLElement): boolean {
		const tag = el.tagName;
		if (tag === "TEXTAREA" || tag === "SELECT") return true;
		if (el.isContentEditable) return true;
		if (tag === "INPUT") {
			const type = (el as HTMLInputElement).type;
			return !/^(button|submit|reset|checkbox|radio|file|image|color|range)$/.test(
				type
			);
		}
		return false;
	}

	function activateHint(el: HTMLElement, newTab: boolean): void {
		endHints();
		if (newTab) {
			// Resolve the nearest link and let the host open it in a new Web
			// viewer tab; non-links just get a plain click.
			const link = el.closest("a[href]") as HTMLAnchorElement | null;
			const url = link ? link.href : "";
			if (/^https?:\/\//i.test(url)) {
				send({ type: "open-url", url });
				return;
			}
		}
		if (isTextEditableTarget(el)) {
			el.focus();
		} else {
			el.click();
		}
	}

	/**
	 * Feed one key into the active hint session. Also the entry point for the
	 * host-side relay, which forwards plain `e.key` strings — an uppercase
	 * final letter is how Shift (force new tab) survives the relay.
	 */
	function feedHintKey(key: string): boolean {
		if (!hintSession) return false;
		if (key === "Escape") {
			endHints();
			return true;
		}
		if (key === "Backspace") {
			hintSession.typed = hintSession.typed.slice(0, -1);
			refilterHints();
			return true;
		}
		if (key.length !== 1 || !/[a-zA-Z]/.test(key)) return false;

		const shiftFinal = key !== key.toLowerCase();
		const candidate = hintSession.typed + key.toLowerCase();
		const stillMatches = hintSession.hints.some(
			(h) => h.label.indexOf(candidate) === 0
		);
		// Swallow characters that lead nowhere.
		if (!stillMatches) return true;

		hintSession.typed = candidate;
		const exact = hintSession.hints.find((h) => h.label === candidate);
		if (exact) {
			activateHint(exact.el, hintSession.newTab || shiftFinal);
			return true;
		}
		refilterHints();
		return true;
	}

	// ---- actions -------------------------------------------------------------
	function runAction(action: GuestAction): void {
		switch (action) {
			case "scrollDown":
				scrollByY(config.scrollStep);
				break;
			case "scrollUp":
				scrollByY(-config.scrollStep);
				break;
			case "halfDown":
				scrollHalfPage(1);
				break;
			case "halfUp":
				scrollHalfPage(-1);
				break;
			case "top":
				scrollToEnd("top");
				break;
			case "bottom":
				scrollToEnd("bottom");
				break;
			case "hints":
				startHints(false);
				break;
			case "hintsNewTab":
				startHints(true);
				break;
			case "historyBack":
				history.back();
				break;
			case "historyForward":
				history.forward();
				break;
			case "tabNext":
				send({ type: "tab", action: "next" });
				break;
			case "tabPrev":
				send({ type: "tab", action: "prev" });
				break;
			case "tabNew":
				send({ type: "tab", action: "new" });
				break;
			case "tabClose":
				send({ type: "tab", action: "close" });
				break;
		}
	}

	// ---- chord state machine (port of VimiumPlugin.feedKey) -------------------
	let pendingKeys = "";
	let pendingTimer: number | null = null;

	function clearPending(): void {
		pendingKeys = "";
		if (pendingTimer !== null) {
			window.clearTimeout(pendingTimer);
			pendingTimer = null;
		}
	}

	function setPending(candidate: string, exact: GuestAction | undefined): void {
		clearPending();
		pendingKeys = candidate;
		pendingTimer = window.setTimeout(() => {
			pendingKeys = "";
			pendingTimer = null;
			// Chord never completed: fall back to what the buffered keys meant
			// on their own.
			if (exact) runAction(exact);
		}, config.chordTimeoutMs);
	}

	function feedKey(key: string): boolean {
		const hadPending = pendingKeys.length > 0;
		const candidate = pendingKeys + key;
		const exact = config.keys[candidate];
		let extendable = false;
		for (const seq in config.keys) {
			if (seq.length > candidate.length && seq.indexOf(candidate) === 0) {
				extendable = true;
				break;
			}
		}
		if (extendable) {
			setPending(candidate, exact);
			return true;
		}
		clearPending();
		if (exact) {
			runAction(exact);
			return true;
		}
		if (hadPending) {
			// Dead-end chord: drop the buffered prefix, give this key a fresh start.
			return feedKey(key);
		}
		return false;
	}

	// ---- key capture -----------------------------------------------------------
	// window + capture puts us at the very front of the capture path, ahead of
	// site handlers registered on document (e.g. YouTube's j/k seek keys).
	function onKeyDown(e: KeyboardEvent): void {
		if (hintSession) {
			if (feedHintKey(e.key)) {
				e.preventDefault();
				e.stopImmediatePropagation();
			}
			return;
		}
		// Leave OS/Obsidian shortcuts untouched. Shift is ours (G, F, J, ...).
		if (e.ctrlKey || e.metaKey || e.altKey) return;

		const target = deepActiveElement();
		if (isEditable(target)) {
			if (e.key === "Escape") {
				(target as HTMLElement).blur();
				e.preventDefault();
				e.stopImmediatePropagation();
			}
			return;
		}
		if (e.key === "Escape") {
			// Hand focus back to Obsidian. Deliberately NOT consumed, so page
			// Escape handlers (closing modals etc.) still run.
			send({ type: "focus-host" });
			return;
		}
		// Pure modifier presses must not pollute the sequence buffer.
		if (e.key === "Shift") return;

		if (feedKey(e.key)) {
			e.preventDefault();
			e.stopImmediatePropagation();
		}
	}

	window.addEventListener("keydown", onKeyDown, { capture: true });

	const controller: GuestController = {
		version: 1,
		run: runAction,
		startHints,
		feedHintKey,
		destroy: () => {
			window.removeEventListener("keydown", onKeyDown, { capture: true });
			clearPending();
			endHints();
			delete win[FLAG];
		},
	};
	win[FLAG] = controller;
}
