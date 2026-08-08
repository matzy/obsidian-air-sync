import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preflight, type PreflightInputs } from "./preflight";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function validInputs(): Promise<PreflightInputs> {
	const root = await mkdtemp(resolve(tmpdir(), "airsync-picker-preflight-"));
	cleanup.push(root);
	const executable = resolve(root, "chrome");
	await symlink(process.execPath, executable);
	return {
		nodeVersion: "22.0.0",
		hasWebSocket: true,
		env: {
			DISPLAY: ":99",
			AIRSYNC_E2E_GOOGLE_PICKER_CHROME: executable,
			AIRSYNC_E2E_GOOGLE_PICKER_USER_DATA_DIR: resolve(root, "profile"),
		},
		repoDir: process.cwd(),
		platformRelease: "linux",
	};
}

describe("Google Picker hard preflight", () => {
	it("accepts a supported explicit external profile", async () => {
		const result = await preflight(await validInputs());
		expect(result.timeoutMs).toBe(300_000);
	});

	it.each([
		["node-version", { nodeVersion: "21.0.0" }],
		["websocket-unavailable", { hasWebSocket: false }],
	])("hard-fails %s before launch", async (errorClass, override) => {
		const base = await validInputs();
		await expect(preflight({ ...base, ...override } as PreflightInputs)).rejects.toThrow(errorClass);
	});

	it("hard-fails a native Linux Chrome without a display before launch", async () => {
		const base = await validInputs();
		delete base.env!.DISPLAY;
		await expect(preflight(base)).rejects.toThrow("display-unavailable");
	});

	it("rejects a missing explicit Chrome path", async () => {
		const base = await validInputs();
		delete base.env!.AIRSYNC_E2E_GOOGLE_PICKER_CHROME;
		await expect(preflight(base)).rejects.toThrow("chrome-path");
	});

	it("rejects a repository-local profile", async () => {
		const base = await validInputs();
		base.env!.AIRSYNC_E2E_GOOGLE_PICKER_USER_DATA_DIR = resolve(process.cwd(), ".picker-profile");
		await expect(preflight(base)).rejects.toThrow("profile-inside-repository");
	});

	it("rejects a locked profile", async () => {
		const base = await validInputs();
		await preflight(base);
		await symlink("locked", resolve(base.env!.AIRSYNC_E2E_GOOGLE_PICKER_USER_DATA_DIR!, "SingletonLock"));
		await expect(preflight(base)).rejects.toThrow("profile-locked");
	});

	it("rejects an invalid timeout", async () => {
		const base = await validInputs();
		base.env!.AIRSYNC_E2E_GOOGLE_PICKER_TIMEOUT_SECONDS = "601";
		await expect(preflight(base)).rejects.toThrow("timeout-invalid");
	});

	it("requires successful WSL path conversion before launch", async () => {
		const base = await validInputs();
		base.env!.AIRSYNC_E2E_GOOGLE_PICKER_CHROME += ".exe";
		base.accessPath = async () => undefined;
		base.platformRelease = "microsoft-standard-WSL2";
		base.convertWslPath = () => { throw new Error("unavailable"); };
		await expect(preflight(base)).rejects.toThrow("wsl-path-conversion");
	});

	it("launches Windows Chrome through WSL and passes it a Windows profile path", async () => {
		const base = await validInputs();
		base.env!.AIRSYNC_E2E_GOOGLE_PICKER_CHROME += ".exe";
		delete base.env!.DISPLAY;
		base.accessPath = async () => undefined;
		base.platformRelease = "microsoft-standard-WSL2";
		base.convertWslPath = (path) => `WIN:${path}`;
		const runtime = await preflight(base);
		expect(runtime.chromeExecutable).toBe(base.env!.AIRSYNC_E2E_GOOGLE_PICKER_CHROME);
		expect(runtime.chromeProfileDir).toBe(`WIN:${base.env!.AIRSYNC_E2E_GOOGLE_PICKER_USER_DATA_DIR}`);
	});
});
