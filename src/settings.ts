import {
	App,
	Command,
	FuzzySuggestModal,
	Modal,
	Notice,
	PluginSettingTab,
	Setting,
	TextComponent,
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

/** A user-defined key that runs a shell command in reading mode. */
export interface TerminalCommand {
	/** Key sequence, like KeyBinding.key. Empty = unset. */
	key: string;
	/** Shell command template; {{path}}, {{folder}}, {{vault}} are substituted. */
	command: string;
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
	/** Show a small mode indicator pill. */
	showModeIndicator: boolean;
	/** Inject vim keys and hints into Web viewer tabs (Electron webviews). */
	enableWebviewIntegration: boolean;
	/** Custom reading-mode key bindings. They override the built-in keys. */
	keyBindings: KeyBinding[];
	/** Keys that spawn a shell command (desktop only). */
	terminalCommands: TerminalCommand[];
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
	showModeIndicator: true,
	enableWebviewIntegration: true,
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
	terminalCommands: [],
};

/** Asks the user to confirm a binding that shadows or delays a built-in key. */
class ConfirmKeyModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		private heading: string,
		private message: string,
		private confirmLabel: string,
		private onResult: (confirmed: boolean) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.heading);
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((button) =>
				button
					.setButtonText(this.confirmLabel)
					.setDestructive()
					.setCta()
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
			.addText((text) => {
				text
					.setValue(this.plugin.settings.hintChars)
					.onChange(async (value) => {
						const cleaned = [
							...new Set(value.toLowerCase().replace(/[^a-z]/g, "")),
						].join("");
						this.plugin.settings.hintChars = cleaned || DEFAULT_SETTINGS.hintChars;
						await this.plugin.saveSettings();
					});
				// Show what was actually saved (deduped/lowercased, or the
				// default if the field was emptied).
				text.inputEl.addEventListener("blur", () => {
					text.setValue(this.plugin.settings.hintChars);
				});
			});

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
			.setDesc("Open every note in Reading view so the Vimium layer is always active by default. Changes the editor's global default view mode; the previous value is restored when this is turned off or the plugin is disabled.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.forceReadingView)
					.onChange(async (value) => {
						this.plugin.settings.forceReadingView = value;
						await this.plugin.saveSettings();
						this.plugin.applyForceReadingView(value);
					})
			);

		new Setting(containerEl)
			.setName("Enable native Vim")
			.setDesc("Turn on Obsidian's built-in Vim key bindings so 'i' drops you into a Vim editor. Changes the editor's global Vim setting; the previous value is restored when this is turned off or the plugin is disabled.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableNativeVim)
					.onChange(async (value) => {
						this.plugin.settings.enableNativeVim = value;
						await this.plugin.saveSettings();
						this.plugin.applyNativeVim(value);
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
			.setName("Web viewer integration")
			.setDesc("Inject the vim keys (scrolling, hints, tab switching) into Web viewer pages. Custom key bindings and terminal commands still require focus to be outside the page.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableWebviewIntegration)
					.onChange(async (value) => {
						this.plugin.settings.enableWebviewIntegration = value;
						await this.plugin.saveSettings();
						this.plugin.applyWebviewIntegration(value);
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
		this.displayTerminalCommands(containerEl);
	}

	private displayKeyBindings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Custom key bindings").setHeading();
		containerEl.createEl("p", {
			text: "Bind a key — or a sequence like gT — to any command from the command palette. Active in reading mode. Custom bindings override the built-in keys (you'll be asked to confirm).",
			cls: "setting-item-description",
		});

		this.plugin.settings.keyBindings.forEach((binding, index) => {
			const row = new Setting(containerEl);
			row.settingEl.addClass("vimium-keybinding-row");

			row.addText((text) => {
				text.setPlaceholder("Key(s)").setValue(binding.key);
				text.inputEl.addClass("vimium-keybinding-key");
				this.attachKeySequenceField(
					text,
					() => binding.key,
					(key) => {
						binding.key = key;
					},
					(key) =>
						this.plugin.settings.keyBindings.some(
							(other) => other !== binding && other.key === key
						) ||
						this.plugin.settings.terminalCommands.some(
							(t) => t.key === key
						)
				);
			});

			row.addButton((button) => {
				button
					.setButtonText(binding.commandName || "Choose command…")
					.onClick(() => {
						new CommandSuggestModal(this.app, (command) => {
							binding.commandId = command.id;
							binding.commandName = command.name;
							button.setButtonText(command.name);
							void this.plugin.saveSettings();
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

	private displayTerminalCommands(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Terminal commands").setHeading();
		containerEl.createEl("p", {
			text: "Bind a key — or a sequence — to a shell command, active in reading mode. {{path}} (active note), {{folder}} (the note's folder), and {{vault}} (vault root) are replaced with quoted absolute paths, and the command runs from the note's folder. Example: kitty --directory {{folder}}",
			cls: "setting-item-description",
		});

		this.plugin.settings.terminalCommands.forEach((cmd, index) => {
			const row = new Setting(containerEl);
			row.settingEl.addClass("vimium-terminal-row");

			row.addText((text) => {
				text.setPlaceholder("Key(s)").setValue(cmd.key);
				text.inputEl.addClass("vimium-keybinding-key");
				this.attachKeySequenceField(
					text,
					() => cmd.key,
					(key) => {
						cmd.key = key;
					},
					(key) =>
						this.plugin.settings.terminalCommands.some(
							(other) => other !== cmd && other.key === key
						) ||
						this.plugin.settings.keyBindings.some((b) => b.key === key)
				);
			});

			row.addText((text) => {
				text.setPlaceholder("Shell command…").setValue(cmd.command);
				text.inputEl.addClass("vimium-terminal-command");
				text.onChange(async (value) => {
					cmd.command = value.trim();
					await this.plugin.saveSettings();
				});
			});

			row.addExtraButton((button) => {
				button
					.setIcon("trash")
					.setTooltip("Remove command")
					.onClick(async () => {
						this.plugin.settings.terminalCommands.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					});
			});
		});

		new Setting(containerEl).addButton((button) => {
			button.setButtonText("Add terminal command").onClick(async () => {
				this.plugin.settings.terminalCommands.push({
					key: "",
					command: "",
				});
				await this.plugin.saveSettings();
				this.display();
			});
		});
	}

	/**
	 * Wire a key-sequence text field. Committed on blur/Enter, not per
	 * keystroke, so a sequence like "gT" is validated as a whole. Rejects keys
	 * already bound elsewhere and asks for confirmation before shadowing or
	 * delaying a built-in key.
	 */
	private attachKeySequenceField(
		text: TextComponent,
		getKey: () => string,
		setKey: (key: string) => void,
		isDuplicate: (key: string) => boolean
	): void {
		const commit = (): void => {
			const newKey = text.inputEl.value.trim();
			if (newKey === getKey()) return;
			if (newKey && isDuplicate(newKey)) {
				new Notice(`"${newKey}" is already bound to another command.`);
				text.setValue(getKey());
				return;
			}
			const apply = (): void => {
				setKey(newKey);
				void this.plugin.saveSettings();
			};
			const done = (ok: boolean): void => {
				if (ok) apply();
				else text.setValue(getKey());
			};
			const first = newKey.charAt(0);
			if ((newKey.length === 1 && BUILTIN_KEYS[newKey]) || newKey === "gg") {
				const shadowed = newKey === "gg" ? "gg" : newKey;
				new ConfirmKeyModal(
					this.app,
					"Override built-in key?",
					`"${shadowed}" is a built-in key (${BUILTIN_KEYS[first]}). Binding a command to it will override the built-in action in reading mode.`,
					"Override",
					done
				).open();
			} else if (newKey.length > 1 && BUILTIN_KEYS[first]) {
				new ConfirmKeyModal(
					this.app,
					"Delay built-in key?",
					`This sequence starts with "${first}", a built-in key (${BUILTIN_KEYS[first]}). While the plugin waits for the rest of the sequence, the built-in action will only run after a short chord timeout.`,
					"Bind anyway",
					done
				).open();
			} else {
				apply();
			}
		};
		text.inputEl.addEventListener("change", commit);
		text.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") text.inputEl.blur();
		});
	}
}
