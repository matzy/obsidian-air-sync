import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// The Picker suite launches an installed system Chrome/Chromium. Its only requestUrl
// call is the OAuth refresh needed to mint a short-lived Picker access token; keep
// that setup call on Node fetch so the dedicated system-browser path has no Electron
// dependency. Avoid starting the REST-only Electron net host (and its fixed port).
const pickerOnly = process.argv.some((arg) => arg.includes("google-picker"));
if (pickerOnly) process.env.AIRSYNC_E2E_TRANSPORT ??= "fetch";

/**
 * Standalone vitest config for the opt-in real-cloud e2e (ADR 0003). It is NEVER
 * picked up by `npm test` (the default config includes only the src test glob)
 * and is invoked solely by `npm run test:e2e`.
 *
 * The crucial difference from the default config: `obsidian` is aliased to the
 * e2e shim (real `requestUrl`), not the reject-everything mock, so the contract
 * runs against the live APIs.
 */
export default defineConfig({
	test: {
		include: ["e2e/**/*.e2e.ts"],
		// Launch the Electron `net` host once for the run: every requestUrl in the e2e
		// goes through the real desktop engine (not fetch), so redirect-auth /
		// Content-Length / empty-body behaviours match production. See request-url.ts.
		globalSetup: pickerOnly ? [] : ["./e2e/electron-net-setup.ts"],
		// Generous: a single Dropbox 429 backoff is capped at 64s
		// (MAX_RATE_LIMIT_DELAY_MS), and a test may do several writes — so a 60s
		// per-test timeout can trip on rate-limit backoff alone under sequential load.
		testTimeout: 180_000,
		hookTimeout: 180_000,
		// Run the per-backend files in PARALLEL (different services = different
		// rate-limit buckets), while tests WITHIN each file stay sequential (vitest
		// default), so a single backend is never hammered concurrently.
		fileParallelism: true,
	},
	resolve: {
		alias: {
			obsidian: resolve(__dirname, "obsidian.shim.ts"),
		},
	},
});
