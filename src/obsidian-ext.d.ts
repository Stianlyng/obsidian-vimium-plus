import "obsidian";

// Type augmentations for internal Obsidian APIs that are stable in practice but
// not part of the published type definitions.
declare module "obsidian" {
	interface App {
		commands: {
			executeCommandById(id: string): boolean;
		};
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
