import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGoogleDriveFolderPickerUrl } from "../src/fs/googledrive/folder-picker-url";
import {
	createGoogleE2EAuth,
	GOOGLE_E2E_REFRESH_TOKEN_ENV,
	readGoogleE2ECreds,
} from "./helpers/google-auth";

const require = createRequire(import.meta.url);
const { cleanupGooglePickerFirefox, runGooglePickerFirefox } = require("./google-picker-firefox.cjs") as {
	cleanupGooglePickerFirefox: () => Promise<void>;
	runGooglePickerFirefox: (command: { mode: string; url: string }) => Promise<PickerHostResult>;
};
const INVALID_PUBLIC_KEY = "invalid-picker-key";

interface PickerHostResult {
	ok: boolean;
	stage: string;
	error_class: string | null;
	token_present: boolean;
	interactive: boolean;
	firefox_identity: boolean;
	signal?: {
		dialog: boolean;
		drive_location: boolean;
		browser_control: boolean;
		child_frame: boolean;
	};
}

async function stopOnSigint(): Promise<never> {
	await cleanupGooglePickerFirefox();
	process.exit(130);
}

async function stopOnSigterm(): Promise<never> {
	await cleanupGooglePickerFirefox();
	process.exit(143);
}

beforeAll(() => {
	process.once("SIGINT", stopOnSigint);
	process.once("SIGTERM", stopOnSigterm);
});

afterAll(async () => {
	await cleanupGooglePickerFirefox();
	process.removeListener("SIGINT", stopOnSigint);
	process.removeListener("SIGTERM", stopOnSigterm);
});

function pickerUrl(accessToken: string, apiKey?: string): string {
	return buildGoogleDriveFolderPickerUrl({ state: "e2e-firefox-state", accessToken, apiKey });
}

const pickerCreds = readGoogleE2ECreds();
let pickerAccessTokenPromise: Promise<string> | undefined;

function getPickerAccessToken(): Promise<string> {
	if (!pickerCreds) return Promise.reject(new Error(`Missing ${GOOGLE_E2E_REFRESH_TOKEN_ENV}`));
	if (!pickerAccessTokenPromise) {
		const auth = createGoogleE2EAuth(pickerCreds.refreshToken);
		pickerAccessTokenPromise = auth.getAccessToken(false);
	}
	return pickerAccessTokenPromise;
}

describe("Google Picker — Firefox WebDriver BiDi live observer", () => {
	it("classifies the token-empty control before the Google Picker opens", async () => {
		const result = await runGooglePickerFirefox({ mode: "token-empty", url: pickerUrl("") });
		expect(result).toMatchObject({
			ok: false,
			stage: "pre-picker",
			error_class: "token-empty",
			token_present: false,
			interactive: false,
			firefox_identity: true,
		});
	});

	it.skipIf(!pickerCreds)("classifies the invalid-key control", async () => {
		const accessToken = await getPickerAccessToken();
		const result = await runGooglePickerFirefox({
			mode: "invalid-key",
			url: pickerUrl(accessToken, INVALID_PUBLIC_KEY),
		});
		expect(result).toMatchObject({
			ok: false,
			error_class: "developer-key-invalid",
			token_present: true,
			interactive: false,
			firefox_identity: true,
		});
	});

	it.skipIf(!pickerCreds)("reaches an interactive Drive folder browser", async () => {
		const accessToken = await getPickerAccessToken();
		const result = await runGooglePickerFirefox({ mode: "valid", url: pickerUrl(accessToken) });
		expect(result).toMatchObject({
			ok: true,
			stage: "interactive-ready",
			error_class: null,
			token_present: true,
			interactive: true,
			firefox_identity: true,
			signal: {
				dialog: true,
				drive_location: true,
				browser_control: true,
				child_frame: true,
			},
		});
	});
});
