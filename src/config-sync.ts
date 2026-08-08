import type { AirSyncSettings } from "./settings";

/**
 * Escape gitignore/glob metacharacters (`\ ! # * ? [ ]`) so a literal path
 * segment (e.g. a user-renamed `configDir`) can't be misread as glob syntax —
 * a leading `!` or `#` in particular would otherwise turn a whole pattern
 * into a negation/comment instead of matching the literal folder name.
 */
function escapeGlobChars(segment: string): string {
	return segment.replace(/[\\!#*?[\]]/g, "\\$&");
}

/**
 * Gitignore-style patterns prepended to the user's own ignore patterns when
 * config sync is enabled. Lets through root JSON and the optional portable
 * scopes selected in settings. The active community plugin list belongs to
 * the plugins scope rather than the generic root-JSON scope. This plugin's own
 * data.json stays excluded — syncing it would let one device's backend
 * credentials/vaultId overwrite another's. `configDir` is passed in
 * (`Vault#configDir`) rather than hardcoded, since it's user-configurable.
 *
 * This exclusion of the plugin's own data.json is advisory/for display only:
 * it lives in the user-overridable ignorePatterns list, so `isExcluded()`
 * additionally enforces it unconditionally via `isOwnPluginDataPath()` —
 * don't rely on this array alone to keep credentials from syncing.
 */
export function getConfigSyncIgnorePatterns(
	settings: AirSyncSettings,
	configDir: string,
	pluginId: string,
): string[] {
	const dir = escapeGlobChars(configDir);
	const optionalSubtrees = [
		["plugins", settings.syncConfigPlugins],
		["snippets", settings.syncConfigSnippets],
		["themes", settings.syncConfigThemes],
		["icons", settings.syncConfigIcons],
	] as const;
	const optionalPatterns = optionalSubtrees.flatMap(([subtree, enabled]) =>
		enabled ? [`!${dir}/${subtree}`, `!${dir}/${subtree}/**`] : [],
	);
	return [
		`${dir}/**`,
		...(settings.syncConfigJsonFiles ? [`!${dir}/*.json`] : []),
		// This root JSON file controls which community plugins are active, so its
		// ownership follows Sync plugins even when Sync config files differs.
		...(settings.syncConfigPlugins
			? [`!${dir}/community-plugins.json`]
			: [`${dir}/community-plugins.json`]),
		`${dir}/workspace.json`,
		`${dir}/workspace-mobile.json`,
		...optionalPatterns,
		// Display-only: always shadowed by the unconditional isOwnPluginDataPath()
		// check in isExcluded(), which enforces this regardless of ignorePatterns.
		// Kept here only so the Settings UI can show the full injected list.
		...(settings.syncConfigPlugins
			? [`${dir}/plugins/${escapeGlobChars(pluginId)}/**`]
			: []),
	];
}

/** syncDotPaths, augmented with the vault's config directory when config sync is enabled. */
export function getEffectiveSyncDotPaths(settings: AirSyncSettings, configDir: string): string[] {
	return settings.enableConfigSync
		? [...settings.syncDotPaths, configDir]
		: settings.syncDotPaths;
}

/** ignorePatterns, with the built-in config-sync patterns prepended when enabled. */
export function getEffectiveIgnorePatterns(
	settings: AirSyncSettings,
	configDir: string,
	pluginId: string,
): string[] {
	return settings.enableConfigSync
		? [...getConfigSyncIgnorePatterns(settings, configDir, pluginId), ...settings.ignorePatterns]
		: settings.ignorePatterns;
}

/**
 * This plugin's own settings file under the vault's config directory. Checked
 * as an unconditional, non-overridable exclusion (see `isExcluded()`) rather
 * than relying solely on the ignore-pattern list above, since gitignore's
 * last-match-wins semantics would otherwise let a user's own `ignorePatterns`
 * entry (e.g. a broad `!**` or `!*.json`) silently un-ignore it and sync this
 * device's backend credentials/vaultId to another device.
 */
export function isOwnPluginDataPath(path: string, configDir: string, pluginId: string): boolean {
	return path === `${configDir}/plugins/${pluginId}/data.json`;
}
