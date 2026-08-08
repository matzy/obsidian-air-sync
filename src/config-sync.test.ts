import { describe, it, expect } from "vitest";
import ignore from "ignore";
import { mockSettings } from "./__mocks__/sync-test-helpers";
import { DEFAULT_SETTINGS } from "./settings";
import {
	getConfigSyncIgnorePatterns,
	getEffectiveSyncDotPaths,
	getEffectiveIgnorePatterns,
	isOwnPluginDataPath,
} from "./config-sync";

// A vault's configDir is user-configurable, so tests use a value distinct from
// the (arbitrary) Obsidian default to prove the logic doesn't hardcode it.
const TEST_CONFIG_DIR = "cfg";
const TEST_PLUGIN_ID = "test-plugin";

describe("getEffectiveSyncDotPaths", () => {
	it("leaves syncDotPaths unchanged when config sync is disabled", () => {
		const settings = mockSettings({ enableConfigSync: false, syncDotPaths: [".templates"] });
		expect(getEffectiveSyncDotPaths(settings, TEST_CONFIG_DIR)).toEqual([".templates"]);
	});

	it("appends the config directory when config sync is enabled", () => {
		const settings = mockSettings({ enableConfigSync: true, syncDotPaths: [".templates"] });
		expect(getEffectiveSyncDotPaths(settings, TEST_CONFIG_DIR)).toEqual([
			".templates",
			TEST_CONFIG_DIR,
		]);
	});
});

describe("getEffectiveIgnorePatterns", () => {
	it("leaves ignorePatterns unchanged when config sync is disabled", () => {
		const settings = mockSettings({ enableConfigSync: false, ignorePatterns: ["*.tmp"] });
		expect(getEffectiveIgnorePatterns(settings, TEST_CONFIG_DIR, TEST_PLUGIN_ID)).toEqual(["*.tmp"]);
	});

	it("prepends the built-in patterns when config sync is enabled", () => {
		const settings = mockSettings({ enableConfigSync: true, ignorePatterns: ["*.tmp"] });
		expect(getEffectiveIgnorePatterns(settings, TEST_CONFIG_DIR, TEST_PLUGIN_ID)).toEqual([
			...getConfigSyncIgnorePatterns(settings, TEST_CONFIG_DIR, TEST_PLUGIN_ID),
			"*.tmp",
		]);
	});
});

describe("getConfigSyncIgnorePatterns", () => {
	it("preserves existing root JSON and plugins scopes while keeping new subtrees opt-in", () => {
		expect(DEFAULT_SETTINGS).toMatchObject({
			syncConfigJsonFiles: true,
			syncConfigPlugins: true,
			syncConfigSnippets: false,
			syncConfigThemes: false,
			syncConfigIcons: false,
		});
	});

	it("includes root JSON config files only when enabled and always excludes workspace state", () => {
		const disabled = mockSettings({ enableConfigSync: true, syncConfigJsonFiles: false });
		const enabled = mockSettings({ enableConfigSync: true, syncConfigJsonFiles: true });
		const disabledPatterns = getConfigSyncIgnorePatterns(
			disabled,
			TEST_CONFIG_DIR,
			TEST_PLUGIN_ID,
		);
		const enabledPatterns = getConfigSyncIgnorePatterns(
			enabled,
			TEST_CONFIG_DIR,
			TEST_PLUGIN_ID,
		);

		expect(disabledPatterns).not.toContain(`!${TEST_CONFIG_DIR}/*.json`);
		expect(enabledPatterns).toContain(`!${TEST_CONFIG_DIR}/*.json`);
		expect(ignore().add(disabledPatterns).ignores(`${TEST_CONFIG_DIR}/app.json`)).toBe(true);
		expect(ignore().add(enabledPatterns).ignores(`${TEST_CONFIG_DIR}/app.json`)).toBe(false);
		expect(ignore().add(enabledPatterns).ignores(`${TEST_CONFIG_DIR}/workspace.json`)).toBe(true);
		expect(
			ignore().add(enabledPatterns).ignores(`${TEST_CONFIG_DIR}/workspace-mobile.json`),
		).toBe(true);
	});

	it.each([
		{ syncConfigJsonFiles: false, syncConfigPlugins: false },
		{ syncConfigJsonFiles: true, syncConfigPlugins: false },
		{ syncConfigJsonFiles: false, syncConfigPlugins: true },
		{ syncConfigJsonFiles: true, syncConfigPlugins: true },
	])(
		"classifies the active community plugin list with plugins: $syncConfigJsonFiles/$syncConfigPlugins",
		({ syncConfigJsonFiles, syncConfigPlugins }) => {
			const settings = mockSettings({
				enableConfigSync: true,
				syncConfigJsonFiles,
				syncConfigPlugins,
			});
			const patterns = getConfigSyncIgnorePatterns(
				settings,
				TEST_CONFIG_DIR,
				TEST_PLUGIN_ID,
			);
			const matcher = ignore().add(patterns);

			expect(matcher.ignores(`${TEST_CONFIG_DIR}/app.json`)).toBe(
				!syncConfigJsonFiles,
			);
			expect(matcher.ignores(`${TEST_CONFIG_DIR}/community-plugins.json`)).toBe(
				!syncConfigPlugins,
			);
			expect(
				matcher.ignores(`${TEST_CONFIG_DIR}/plugins/other-plugin/data.json`),
			).toBe(!syncConfigPlugins);
			expect(patterns).toContain(
				syncConfigPlugins
					? `!${TEST_CONFIG_DIR}/community-plugins.json`
					: `${TEST_CONFIG_DIR}/community-plugins.json`,
			);
		},
	);

	it.each([
		["snippets", "syncConfigSnippets"],
		["themes", "syncConfigThemes"],
		["icons", "syncConfigIcons"],
	] as const)("includes %s only when its setting is enabled", (directory, setting) => {
		const disabled = mockSettings({ enableConfigSync: true, [setting]: false });
		const enabled = mockSettings({ enableConfigSync: true, [setting]: true });

		expect(
			ignore()
				.add(getConfigSyncIgnorePatterns(disabled, TEST_CONFIG_DIR, TEST_PLUGIN_ID))
				.ignores(`${TEST_CONFIG_DIR}/${directory}/example.css`),
		).toBe(true);
		const enabledMatcher = ignore().add(
			getConfigSyncIgnorePatterns(enabled, TEST_CONFIG_DIR, TEST_PLUGIN_ID),
		);
		expect(
			getConfigSyncIgnorePatterns(disabled, TEST_CONFIG_DIR, TEST_PLUGIN_ID),
		).not.toContain(`!${TEST_CONFIG_DIR}/${directory}`);
		expect(
			getConfigSyncIgnorePatterns(enabled, TEST_CONFIG_DIR, TEST_PLUGIN_ID),
		).toContain(`!${TEST_CONFIG_DIR}/${directory}`);
		expect(enabledMatcher.ignores(`${TEST_CONFIG_DIR}/${directory}`)).toBe(false);
		expect(enabledMatcher.ignores(`${TEST_CONFIG_DIR}/${directory}/example.css`)).toBe(false);
	});

	it("escapes glob-special characters in configDir and pluginId", () => {
		// A configDir starting with "!" or "#" is a legal folder name (Obsidian's
		// config-dir-redirect marker file imposes no character restrictions), but
		// unescaped it would be read as a gitignore negation/comment instead of a
		// literal path, silently disabling every built-in pattern.
		const patterns = getConfigSyncIgnorePatterns(mockSettings(), "!cfg", "plugin[x]");
		const matcher = ignore().add(patterns);

		expect(matcher.ignores("!cfg/workspace.json")).toBe(true);
		expect(matcher.ignores("!cfg/plugins/plugin[x]/data.json")).toBe(true);
		expect(matcher.ignores("!cfg/plugins/plugin[x]/other-file.json")).toBe(true);
		expect(matcher.ignores("!cfg/plugins/other-plugin/data.json")).toBe(false);
	});
});

describe("isOwnPluginDataPath", () => {
	it("matches only this plugin's own data.json under the config directory", () => {
		expect(isOwnPluginDataPath(`${TEST_CONFIG_DIR}/plugins/${TEST_PLUGIN_ID}/data.json`, TEST_CONFIG_DIR, TEST_PLUGIN_ID)).toBe(true);
		expect(isOwnPluginDataPath(`${TEST_CONFIG_DIR}/plugins/other-plugin/data.json`, TEST_CONFIG_DIR, TEST_PLUGIN_ID)).toBe(false);
		expect(isOwnPluginDataPath(`${TEST_CONFIG_DIR}/workspace.json`, TEST_CONFIG_DIR, TEST_PLUGIN_ID)).toBe(false);
	});
});
