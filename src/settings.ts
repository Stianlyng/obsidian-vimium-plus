import { App, PluginSettingTab, Setting } from "obsidian";
import type VimiumPlugin from "./main";

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
};

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
						const cleaned = value.toLowerCase().replace(/[^a-z]/g, "");
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
					.setDynamicTooltip()
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
					.setDynamicTooltip()
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
					.setDynamicTooltip()
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
				text.inputEl.style.width = "100%";
				text.inputEl.style.fontFamily = "var(--font-monospace, monospace)";
			});
	}
}
