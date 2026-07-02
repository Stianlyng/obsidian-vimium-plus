import {
	App,
	Command,
	FuzzySuggestModal,
	Modal,
	PluginSettingTab,
	Setting,
} from "obsidian";
import type VimiumPlugin from "./main";

/** Built-in reading-mode keys and what they do; used to warn before a custom binding shadows one. */
export const BUILTIN_KEYS: Record<string, string> = {
	f: "show click hints",
	F: "show click hints in a new tab",
	j: "scroll down",
	k: "scroll up",
	J: "next tab",
	K: "previous tab",
	d: "half-page down",
	u: "half-page up",
	g: "jump to top (gg)",
	G: "jump to bottom",
	i: "enter editing mode",
	b: "bookmark search",
	B: "bookmark search in a new tab",
	O: "omnibar in a new tab",
	H: "go back in history",
	L: "go forward in history",
	"/": "search current file",
	t: "new tab",
	x: "close tab",
	X: "restore closed tab",
};

/** A user-defined key that runs a command palette command in reading mode. */
export interface KeyBinding {
	/** KeyboardEvent.key value, e.g. "x", "X", "ArrowDown". Empty = unset. */
	key: string;
	/** Command id, e.g. "editor:toggle-bold". Empty = unset. */
	commandId: string;
	/** Command display name, kept so the row stays readable if the command's plugin is disabled. */
	commandName: string;
}

export interface VimiumSettings {
	/** Characters used to build hint labels (in priority order). */
	hintChars: string;
	/** CSS selectors whose matching, visible elements become hint targets. */
	selectors: string[];
	/** Font size (px) of hint markers. */
	hintFontSize: number;
	/** Pixels scrolled per j/k press. */
	scrollStep: number;
	/** Force every opened note into Reading view (the Vimium layer). */
	forceReadingView: boolean;
	/** Turn on Obsidian's native Vim key bindings on load. */
	enableNativeVim: boolean;
	/** Max gap (ms) between the two Escapes that exit editing mode. */
	doubleEscapeMs: number;
	/** Show a small mode indicator pill. */
	showModeIndicator: boolean;
	/** Custom reading-mode key bindings. They override the built-in keys. */
	keyBindings: KeyBinding[];
}

export const DEFAULT_SELECTORS = [
	// App chrome
	".workspace-tab-header",
	".workspace-tab-header-inner",
	".side-dock-ribbon-action",
	".clickable-icon",
	".nav-file-title",
	".nav-folder-title",
	".tree-item-self",
	".menu-item",
	// Rendered note content (Reading view)
	".markdown-preview-view a",
	".markdown-preview-view .internal-link",
	".markdown-preview-view .external-link",
	".markdown-preview-view .tag",
	".markdown-preview-view .task-list-item-checkbox",
	".markdown-preview-view button",
	".markdown-embed-link",
];

export const DEFAULT_SETTINGS: VimiumSettings = {
	// Home-row-first alphabet, like Vimium.
	hintChars: "sadfjklewcmpgh",
	selectors: DEFAULT_SELECTORS,
	hintFontSize: 11,
	scrollStep: 70,
	forceReadingView: true,
	enableNativeVim: true,
	doubleEscapeMs: 400,
	showModeIndicator: true,
	keyBindings: [
		{
			key: "p",
			commandId: "command-palette:open",
			commandName: "Command palette: Open command palette",
		},
		{
			key: "o",
			commandId: "switcher:open",
			commandName: "Quick switcher: Open quick switcher",
		},
	],
};

/** Asks the user to confirm shadowing a built-in key with a custom binding. */
class ConfirmOverrideModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		private key: string,
		private action: string,
		private onResult: (confirmed: boolean) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Override built-in key?");
		this.contentEl.createEl("p", {
			text: `"${this.key}" is a built-in key (${this.action}). Binding a command to it will override the built-in action in reading mode.`,
		});
		new Setting(this.contentEl)
			.addButton((button) =>
				button
					.setButtonText("Override")
					.setWarning()
					.onClick(() => {
						this.confirmed = true;
						this.close();
					})
			)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => this.close())
			);
	}

	onClose(): void {
		this.contentEl.empty();
		this.onResult(this.confirmed);
	}
}

/** Fuzzy picker over every command in the command palette. */
class CommandSuggestModal extends FuzzySuggestModal<Command> {
	constructor(app: App, private onChoose: (command: Command) => void) {
		super(app);
		this.setPlaceholder("Pick a command…");
	}

	getItems(): Command[] {
		return this.app.commands.listCommands();
	}

	getItemText(command: Command): string {
		return command.name;
	}

	onChooseItem(command: Command): void {
		this.onChoose(command);
	}
}

export class VimiumSettingTab extends PluginSettingTab {
	plugin: VimiumPlugin;

	constructor(app: App, plugin: VimiumPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Hint characters")
			.setDesc("Characters used to generate hint labels, in priority order.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.hintChars)
					.onChange(async (value) => {
						const cleaned = [
							...new Set(value.toLowerCase().replace(/[^a-z]/g, "")),
						].join("");
						this.plugin.settings.hintChars = cleaned || DEFAULT_SETTINGS.hintChars;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Hint font size")
			.setDesc("Font size of the hint markers, in pixels.")
			.addSlider((slider) =>
				slider
					.setLimits(8, 24, 1)
					.setValue(this.plugin.settings.hintFontSize)
					.onChange(async (value) => {
						this.plugin.settings.hintFontSize = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Scroll step")
			.setDesc("Pixels scrolled per j / k press.")
			.addSlider((slider) =>
				slider
					.setLimits(20, 300, 10)
					.setValue(this.plugin.settings.scrollStep)
					.onChange(async (value) => {
						this.plugin.settings.scrollStep = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Force Reading view")
			.setDesc("Open every note in Reading view so the Vimium layer is always active by default.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.forceReadingView)
					.onChange(async (value) => {
						this.plugin.settings.forceReadingView = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enable native Vim on load")
			.setDesc("Turn on Obsidian's built-in Vim key bindings so 'i' drops you into a Vim editor.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableNativeVim)
					.onChange(async (value) => {
						this.plugin.settings.enableNativeVim = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Double-Escape timeout")
			.setDesc("Max gap, in milliseconds, between the two Escapes that return you to Reading mode.")
			.addSlider((slider) =>
				slider
					.setLimits(150, 800, 50)
					.setValue(this.plugin.settings.doubleEscapeMs)
					.onChange(async (value) => {
						this.plugin.settings.doubleEscapeMs = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show mode indicator")
			.setDesc("Show a small pill indicating the current mode.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showModeIndicator)
					.onChange(async (value) => {
						this.plugin.settings.showModeIndicator = value;
						await this.plugin.saveSettings();
						this.plugin.refreshModeIndicator();
					})
			);

		new Setting(containerEl)
			.setName("Hint target selectors")
			.setDesc("One CSS selector per line. Visible elements matching any selector become hint targets.")
			.addTextArea((text) => {
				text
					.setValue(this.plugin.settings.selectors.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.selectors = value
							.split("\n")
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 12;
				text.inputEl.addClass("vimium-selectors-input");
			});

		this.displayKeyBindings(containerEl);
	}

	private displayKeyBindings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Custom key bindings").setHeading();
		containerEl.createEl("p", {
			text: "Bind a key to any command from the command palette. Active in reading mode. Custom bindings override the built-in keys (you'll be asked to confirm).",
			cls: "setting-item-description",
		});

		this.plugin.settings.keyBindings.forEach((binding, index) => {
			const row = new Setting(containerEl);
			row.settingEl.addClass("vimium-keybinding-row");

			row.addText((text) => {
				text.setPlaceholder("Key").setValue(binding.key);
				text.inputEl.addClass("vimium-keybinding-key");
				text.inputEl.readOnly = true;
				// Capture the next key press instead of parsing typed text, so
				// keys like "ArrowDown" or shifted characters work naturally.
				text.inputEl.addEventListener("keydown", (e) => {
					if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
					e.preventDefault();
					const newKey = e.key === "Backspace" ? "" : e.key;
					const apply = () => {
						binding.key = newKey;
						text.setValue(newKey);
						void this.plugin.saveSettings();
					};
					const builtin = newKey ? BUILTIN_KEYS[newKey] : undefined;
					if (builtin) {
						new ConfirmOverrideModal(this.app, newKey, builtin, (ok) => {
							if (ok) apply();
						}).open();
					} else {
						apply();
					}
				});
			});

			row.addButton((button) => {
				button
					.setButtonText(binding.commandName || "Choose command…")
					.onClick(() => {
						new CommandSuggestModal(this.app, async (command) => {
							binding.commandId = command.id;
							binding.commandName = command.name;
							await this.plugin.saveSettings();
							button.setButtonText(command.name);
						}).open();
					});
			});

			row.addExtraButton((button) => {
				button
					.setIcon("trash")
					.setTooltip("Remove binding")
					.onClick(async () => {
						this.plugin.settings.keyBindings.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					});
			});
		});

		new Setting(containerEl).addButton((button) => {
			button.setButtonText("Add binding").onClick(async () => {
				this.plugin.settings.keyBindings.push({
					key: "",
					commandId: "",
					commandName: "",
				});
				await this.plugin.saveSettings();
				this.display();
			});
		});
	}
}
