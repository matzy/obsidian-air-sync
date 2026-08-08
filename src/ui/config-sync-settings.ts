import { Setting } from "obsidian";
import type AirSyncPlugin from "../main";
import { getConfigSyncIgnorePatterns } from "../config-sync";

interface ConfigSubtreeSetting {
	key:
		| "syncConfigJsonFiles"
		| "syncConfigPlugins"
		| "syncConfigSnippets"
		| "syncConfigThemes"
		| "syncConfigIcons";
	name: string;
	paths: string[];
	description: string;
}

const CONFIG_SUBTREE_SETTINGS: ConfigSubtreeSetting[] = [
	{
		key: "syncConfigJsonFiles",
		name: "Sync config files",
		paths: ["*.json"],
		description:
			"Sync root JSON config files, excluding the active community plugin list and device-specific workspace state.",
	},
	{
		key: "syncConfigPlugins",
		name: "Sync plugins",
		paths: ["plugins/", "community-plugins.json"],
		description:
			"Sync installed plugins, their settings, and the active community plugin list, excluding Air Sync's own data.",
	},
	{
		key: "syncConfigSnippets",
		name: "Sync snippets",
		paths: ["snippets/"],
		description: "Sync CSS snippets.",
	},
	{
		key: "syncConfigThemes",
		name: "Sync themes",
		paths: ["themes/"],
		description: "Sync installed themes.",
	},
	{
		key: "syncConfigIcons",
		name: "Sync icons",
		paths: ["icons/"],
		description: "Sync custom icons.",
	},
];

export function renderConfigSyncSettings(
	containerEl: HTMLElement,
	plugin: AirSyncPlugin,
	rerender: () => void,
): void {
	const configDir = plugin.app.vault.configDir;

	new Setting(containerEl)
		.setName("Enable Obsidian config sync")
		.setDesc(
			`Sync Obsidian's own config directory (${configDir}/) — hotkeys, plugin settings, and selected ` +
				"portable folders. Device-specific window layout is deliberately excluded. This is Obsidian's " +
				"internal metadata; syncing it across devices may cause settings loss or plugin malfunction.",
		)
		.addToggle((toggle) =>
			toggle
				.setValue(plugin.settings.enableConfigSync)
				.onChange(async (value) => {
					plugin.settings.enableConfigSync = value;
					await plugin.saveSettings();
					rerender();
				}),
		);

	if (!plugin.settings.enableConfigSync) return;

	for (const option of CONFIG_SUBTREE_SETTINGS) {
		const paths = option.paths.map((path) => `${configDir}/${path}`).join(", ");
		new Setting(containerEl)
			.setName(option.name)
			.setDesc(`${option.description} (${paths})`)
			.addToggle((toggle) =>
				toggle
					.setValue(plugin.settings[option.key])
					.onChange(async (value) => {
						plugin.settings[option.key] = value;
						await plugin.saveSettings();
						rerender();
					}),
			);
	}

	renderSyncTiming(containerEl);
	renderInjectedPatterns(containerEl, plugin, configDir);
}

function renderSyncTiming(containerEl: HTMLElement): void {
	const description = createFragment();
	description.createEl("p", {
		text:
			"Config changes aren't synced immediately — they're picked up the next time a sync runs " +
			"(triggered by another vault change, returning to the app, or Sync now).",
	});
	description.createEl("p", {
		text:
			"After a sync finishes, reload the affected plugins, themes, and snippets (or restart Obsidian) " +
			"for the synced settings to take effect.",
	});
	new Setting(containerEl).setName("Sync timing").setDesc(description);
}

function renderInjectedPatterns(
	containerEl: HTMLElement,
	plugin: AirSyncPlugin,
	configDir: string,
): void {
	const description = createFragment();
	description.appendText("Added automatically to the top of your Ignore patterns above:");
	description.createEl("pre", {
		text: getConfigSyncIgnorePatterns(
			plugin.settings,
			configDir,
			plugin.manifest.id,
		).join("\n"),
	});
	new Setting(containerEl).setName("Injected ignore patterns").setDesc(description);
}
