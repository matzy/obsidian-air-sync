import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAuth, GoogleAuthDirect } from "../src/fs/googledrive/auth";
import { createGoogleE2EAuth, readGoogleE2ECreds } from "./helpers/google-auth";

const GOOGLE_ENV_KEYS = [
	"AIRSYNC_E2E_GOOGLE_REFRESH_TOKEN",
	"AIRSYNC_E2E_GOOGLE_CLIENT_ID",
	"AIRSYNC_E2E_GOOGLE_CLIENT_SECRET",
] as const;

let originalEnv: Record<(typeof GOOGLE_ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
	originalEnv = Object.fromEntries(
		GOOGLE_ENV_KEYS.map((key) => [key, process.env[key]]),
	) as typeof originalEnv;
	for (const key of GOOGLE_ENV_KEYS) delete process.env[key];
	vi.spyOn(process, "cwd").mockReturnValue("/__airsync_google_auth_test_no_dotenv__");
});

afterEach(() => {
	for (const key of GOOGLE_ENV_KEYS) {
		const value = originalEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	vi.restoreAllMocks();
});

describe("shared Google E2E auth contract", () => {
	it("keeps the dedicated Picker run independent of the Electron net host", () => {
		expect(process.env.AIRSYNC_E2E_TRANSPORT).toBe("fetch");
	});

	it("reads the refresh token produced by the existing Google bootstrap", () => {
		process.env.AIRSYNC_E2E_GOOGLE_REFRESH_TOKEN = "shared-google-refresh-token";

		expect(readGoogleE2ECreds()).toEqual({ refreshToken: "shared-google-refresh-token" });
	});

	it("uses the built-in Google auth when client credentials are absent", () => {
		const auth = createGoogleE2EAuth("shared-google-refresh-token");

		expect(auth).toBeInstanceOf(GoogleAuth);
		expect(auth.getTokenState()).toEqual({
			refreshToken: "shared-google-refresh-token",
			accessToken: "",
			accessTokenExpiry: 0,
		});
	});

	it("uses direct Google auth when both client credentials are present", () => {
		process.env.AIRSYNC_E2E_GOOGLE_CLIENT_ID = "e2e-client-id";
		process.env.AIRSYNC_E2E_GOOGLE_CLIENT_SECRET = "e2e-client-secret";

		const auth = createGoogleE2EAuth("shared-google-refresh-token");

		expect(auth).toBeInstanceOf(GoogleAuthDirect);
		expect(auth.getTokenState()).toEqual({
			refreshToken: "shared-google-refresh-token",
			accessToken: "",
			accessTokenExpiry: 0,
		});
	});
});
