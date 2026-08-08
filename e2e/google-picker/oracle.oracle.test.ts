import { describe, expect, it } from "vitest";
import {
	assertNoSecrets,
	parseCallbackEnvelope,
	PickerE2EError,
	safeFailure,
	selectOrderedExternalNavigation,
	type NavigationEvidence,
	validateAuthorizationUrl,
} from "./oracle";

const state = "state_S3ntinel";
const worker = "https://auth-airsync.takezo.dev/google/callback?opaque=worker_S3ntinel";
const deepLink = "obsidian://air-sync-auth?state=state_S3ntinel&picked_file_ids=folder_S3ntinel&access_token=token_S3ntinel&expires_in=3600";

function event(overrides: Partial<NavigationEvidence>): NavigationEvidence {
	return {
		sequence: 1,
		targetId: "target-a",
		sessionId: "session-a",
		frameId: "frame-a",
		loaderId: "loader-a",
		url: worker,
		source: "Network.requestWillBeSent",
		...overrides,
	};
}

describe("Google Picker callback oracle", () => {
	it("accepts only a same-session Worker-before-external sequence", () => {
		const selected = selectOrderedExternalNavigation([
			event({ sequence: 10 }),
			event({ sequence: 11, url: deepLink, source: "Page.frameRequestedNavigation", loaderId: undefined }),
		]);
		expect(selected.url).toBe(deepLink);
	});

	it.each([
		["pre-Worker", [event({ sequence: 2, url: deepLink }), event({ sequence: 3 })]],
		["another target", [event({ sequence: 2 }), event({ sequence: 3, url: deepLink, targetId: "target-b" })]],
		["another session", [event({ sequence: 2 }), event({ sequence: 3, url: deepLink, sessionId: "session-b" })]],
		["another frame", [event({ sequence: 2 }), event({ sequence: 3, url: deepLink, frameId: "frame-b" })]],
		["another loader", [event({ sequence: 2 }), event({ sequence: 3, url: deepLink, loaderId: "loader-b" })]],
		["DOM-only absence", [event({ sequence: 2 })]],
	])("rejects %s evidence", (_name, events) => {
		expect(() => selectOrderedExternalNavigation(events)).toThrow("ordered-external-navigation-missing");
	});

	it("parses exact state, one id, token, and positive expiry", () => {
		expect(parseCallbackEnvelope(deepLink, state)).toEqual({
			accessToken: "token_S3ntinel",
			expiresIn: 3600,
			pickedFileId: "folder_S3ntinel",
			state,
		});
	});

	it.each([
		["wrong route", deepLink.replace("air-sync-auth", "other")],
		["wrong state", deepLink.replace(state, "wrong")],
		["duplicate id", `${deepLink}&picked_file_ids=second`],
		["bad id", deepLink.replace("folder_S3ntinel", "bad/id")],
		["missing token", deepLink.replace("access_token=token_S3ntinel&", "")],
		["zero expiry", deepLink.replace("expires_in=3600", "expires_in=0")],
	])("rejects %s", (_name, url) => {
		expect(() => parseCallbackEnvelope(url, state)).toThrow(PickerE2EError);
	});

	it("pins the production authorization contract without exposing it", () => {
		const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
		url.search = new URLSearchParams({
			trigger_onepick: "true",
			allow_folder_selection: "true",
			mimetypes: "application/vnd.google-apps.folder",
			scope: "https://www.googleapis.com/auth/drive.file",
			prompt: "consent",
			state,
		}).toString();
		expect(() => validateAuthorizationUrl(url.toString(), state)).not.toThrow();
		expect(() => validateAuthorizationUrl(url.toString().replace("trigger_onepick=true", "trigger_onepick=false"), state))
			.toThrow("authorization-contract");
	});
});

describe("secret-safe failures", () => {
	it("serializes parse, assertion, transport, child, timeout, and cleanup failures as fixed metadata", () => {
		const sentinels = [
			"authorization_S3ntinel?query=1",
			"token_S3ntinel",
			"state_S3ntinel",
			"folder_S3ntinel",
			"cookie_S3ntinel",
			worker,
			deepLink,
			"cdp_S3ntinel",
			"child_stdout_S3ntinel",
			"child_stderr_S3ntinel",
		];
		const observable = [
			safeFailure(new Error(sentinels.join(" "))),
			safeFailure(new PickerE2EError("drive-request", "drive-folder")),
			safeFailure(new PickerE2EError("external-navigation-timeout", "external-navigation")),
		].join("\n");
		expect(() => assertNoSecrets(observable, sentinels)).not.toThrow();
	});

	it("proves the disclosure detector rejects an intentionally unredacted fixture", () => {
		expect(() => assertNoSecrets(`failure: ${deepLink}`, [deepLink])).toThrow("secret-disclosure");
	});
});
