import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGoogleDriveFolderPickerUrl } from "../src/fs/googledrive/folder-picker-url";
import {
	createGoogleE2EAuth,
	GOOGLE_E2E_REFRESH_TOKEN_ENV,
	readGoogleE2ECreds,
} from "./helpers/google-auth";

const require = createRequire(import.meta.url);
const { cleanupGooglePickerChrome, runGooglePickerChrome } = require("./google-picker-chrome.cjs") as {
	cleanupGooglePickerChrome: () => Promise<void>;
	runGooglePickerChrome: (command: { mode: string; url: string }) => Promise<PickerHostResult>;
};
const INVALID_PUBLIC_KEY = "invalid-picker-key";

interface PickerHostResult {
	ok: boolean;
	stage: string;
	error_class: string | null;
	token_present: boolean;
	interactive: boolean;
	chrome_identity: boolean;
	signal?: {
		dialog: boolean;
		drive_location: boolean;
		browser_control: boolean;
		child_frame: boolean;
	};
}

async function stopOnSigint(): Promise<never> {
	await cleanupGooglePickerChrome();
	process.exit(130);
}

async function stopOnSigterm(): Promise<never> {
	await cleanupGooglePickerChrome();
	process.exit(143);
}

beforeAll(() => {
	process.once("SIGINT", stopOnSigint);
	process.once("SIGTERM", stopOnSigterm);
});

afterAll(async () => {
	await cleanupGooglePickerChrome();
	process.removeListener("SIGINT", stopOnSigint);
	process.removeListener("SIGTERM", stopOnSigterm);
});

function pickerUrl(accessToken: string, apiKey?: string): string {
	return buildGoogleDriveFolderPickerUrl({ state: "e2e-state", accessToken, apiKey });
}

const pickerCreds = readGoogleE2ECreds();
let pickerAccessTokenPromise: Promise<string> | undefined;

function getPickerAccessToken(): Promise<string> {
	if (!pickerCreds) {
		return Promise.reject(new Error(`Missing ${GOOGLE_E2E_REFRESH_TOKEN_ENV}`));
	}
	if (!pickerAccessTokenPromise) {
		const auth = createGoogleE2EAuth(pickerCreds.refreshToken);
		pickerAccessTokenPromise = auth.getAccessToken(false);
	}
	return pickerAccessTokenPromise;
}

if (!pickerCreds) {
	console.warn(
		`[e2e] Google Picker credentialed cases not executed: missing ${GOOGLE_E2E_REFRESH_TOKEN_ENV}.`,
	);
}

describe("Google Picker — system Chrome/Chromium live observer", () => {
	it("classifies the token-empty control before the Google Picker opens", async () => {
		const result = await runGooglePickerChrome({ mode: "token-empty", url: pickerUrl("") });
		expect(result).toMatchObject({
			ok: false,
			stage: "pre-picker",
			error_class: "token-empty",
			token_present: false,
			interactive: false,
			chrome_identity: true,
		});
	});

	it.skipIf(!pickerCreds)(
		`classifies the invalid-key control with ${GOOGLE_E2E_REFRESH_TOKEN_ENV}`,
		async () => {
			// A valid OAuth token isolates the changed variable to the developer key;
			// a synthetic token could be rejected first and would not test this observer.
			const accessToken = await getPickerAccessToken();
			const result = await runGooglePickerChrome({
				mode: "invalid-key",
				url: pickerUrl(accessToken, INVALID_PUBLIC_KEY),
			});
			expect(result).toMatchObject({
				ok: false,
				error_class: "developer-key-invalid",
				token_present: true,
				interactive: false,
				chrome_identity: true,
			});
		},
	);

	it.skipIf(!pickerCreds)(
		`reaches an interactive Drive folder browser with ${GOOGLE_E2E_REFRESH_TOKEN_ENV}`,
		async () => {
			const accessToken = await getPickerAccessToken();
			const result = await runGooglePickerChrome({ mode: "valid", url: pickerUrl(accessToken) });
			expect(result).toMatchObject({
				ok: true,
				stage: "interactive-ready",
				error_class: null,
				token_present: true,
				interactive: true,
				chrome_identity: true,
				signal: {
					dialog: true,
					drive_location: true,
					browser_control: true,
					child_frame: true,
				},
			});
		},
	);
});
