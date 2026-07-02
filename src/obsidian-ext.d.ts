import "obsidian";

// Type augmentations for internal Obsidian APIs that are stable in practice but
// not part of the published type definitions.
declare module "obsidian" {
	interface App {
		commands: {
			executeCommandById(id: string): boolean;
			listCommands(): Command[];
		};
		internalPlugins: {
			getEnabledPluginById(
				id: "bookmarks"
			): BookmarksPluginInstance | null;
		};
	}

	/** An entry in the Bookmarks core plugin's (possibly nested) item tree. */
	interface BookmarkItem {
		type: "file" | "folder" | "search" | "graph" | "group" | "url";
		title?: string;
		path?: string;
		subpath?: string;
		url?: string;
		items?: BookmarkItem[];
	}

	interface BookmarksPluginInstance {
		items: BookmarkItem[];
	}

	interface Vault {
		getConfig(key: string): unknown;
		setConfig(key: string, value: unknown): void;
	}

	interface MarkdownView {
		// 'source' (incl. live preview) or 'preview' (reading view).
		getMode(): "source" | "preview";
	}
}
