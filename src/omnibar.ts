import { App, BookmarkItem, SuggestModal, prepareFuzzySearch } from "obsidian";

/** One openable entry in the omnibar: a bookmark, recent file, or URL. */
export interface OmniItem {
	title: string;
	/** Path or URL, shown muted under the title and used for deduping. */
	detail: string;
	open: (newTab: boolean) => void;
}

/**
 * Flatten the Bookmarks core plugin's tree into openable items. Groups are
 * recursed into; folder/search/graph bookmarks have no clean "open" hook and
 * are skipped.
 */
export function collectBookmarkItems(app: App): OmniItem[] {
	const instance = app.internalPlugins.getEnabledPluginById("bookmarks");
	if (!instance) return [];

	const out: OmniItem[] = [];
	const walk = (items: BookmarkItem[]): void => {
		for (const item of items) {
			if (item.type === "group") {
				walk(item.items ?? []);
			} else if (item.type === "file" && item.path) {
				const linktext = item.path + (item.subpath ?? "");
				out.push({
					title: item.title || linktext,
					detail: linktext,
					open: (newTab) =>
						void app.workspace.openLinkText(linktext, "", newTab),
				});
			} else if (item.type === "url" && item.url) {
				const url = item.url;
				out.push({
					title: item.title || url,
					detail: url,
					open: () => window.open(url),
				});
			}
		}
	};
	walk(instance.items);
	return out;
}

/** Recently opened files, as "history" entries for the omnibar. */
export function collectRecentFileItems(app: App): OmniItem[] {
	return app.workspace.getLastOpenFiles().map((path) => ({
		title: path.replace(/\.md$/, ""),
		detail: path,
		open: (newTab: boolean) =>
			void app.workspace.openLinkText(path, "", newTab),
	}));
}

/**
 * Fuzzy picker over openable items. With `allowUrl`, a query that looks like a
 * web address gets an "Open URL" entry on top.
 */
export class OmniOpenModal extends SuggestModal<OmniItem> {
	constructor(
		app: App,
		private items: OmniItem[],
		private newTab: boolean,
		private allowUrl: boolean
	) {
		super(app);
		this.setPlaceholder(
			allowUrl ? "Bookmark, recent file, or URL…" : "Open bookmark…"
		);
	}

	getSuggestions(query: string): OmniItem[] {
		const trimmed = query.trim();
		let matches: OmniItem[];
		if (trimmed === "") {
			matches = [...this.items];
		} else {
			const fuzzy = prepareFuzzySearch(trimmed);
			matches = this.items
				.map((item) => ({
					item,
					match: fuzzy(item.title) ?? fuzzy(item.detail),
				}))
				.filter((s) => s.match !== null)
				.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
				.map((s) => s.item);
		}

		if (this.allowUrl && /^([a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(trimmed)) {
			const url = trimmed.startsWith("www.") ? `https://${trimmed}` : trimmed;
			matches.unshift({
				title: `Open URL: ${url}`,
				detail: url,
				open: () => window.open(url),
			});
		}
		return matches;
	}

	renderSuggestion(item: OmniItem, el: HTMLElement): void {
		el.createDiv({ text: item.title });
		if (item.detail !== item.title) {
			el.createDiv({ cls: "vimium-omni-detail", text: item.detail });
		}
	}

	onChooseSuggestion(item: OmniItem): void {
		item.open(this.newTab);
	}
}
