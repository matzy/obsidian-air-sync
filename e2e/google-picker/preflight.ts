import { constants } from "node:fs";
import { access, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { PickerE2EError } from "./oracle";

export interface PickerRuntime {
	executable: string;
	profileDir: string;
	chromeExecutable: string;
	chromeProfileDir: string;
	timeoutMs: number;
}

export interface PreflightInputs {
	nodeVersion?: string;
	hasWebSocket?: boolean;
	env?: NodeJS.ProcessEnv;
	repoDir?: string;
	platformRelease?: string;
	accessPath?: typeof access;
	mkdirPath?: typeof mkdir;
	realpathPath?: typeof realpath;
	statPath?: typeof lstat;
	openPath?: typeof open;
	convertWslPath?: (path: string) => string;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;

export async function preflight(inputs: PreflightInputs = {}): Promise<PickerRuntime> {
	const env = inputs.env ?? process.env;
	const major = Number((inputs.nodeVersion ?? process.versions.node).split(".")[0]);
	if (major !== 20 && major !== 22) throw new PickerE2EError("node-version", "preflight");
	if ((inputs.hasWebSocket ?? typeof globalThis.WebSocket === "function") !== true) {
		throw new PickerE2EError("websocket-unavailable", "preflight");
	}
	const executable = env.AIRSYNC_E2E_GOOGLE_PICKER_CHROME ?? "";
	const profileDir = env.AIRSYNC_E2E_GOOGLE_PICKER_USER_DATA_DIR ?? "";
	if (!executable || !isAbsolute(executable)) throw new PickerE2EError("chrome-path", "preflight");
	if (!profileDir || !isAbsolute(profileDir)) throw new PickerE2EError("profile-path", "preflight");
	const isWsl = (inputs.platformRelease ?? "").toLowerCase().includes("microsoft") || env.WSL_DISTRO_NAME !== undefined;
	const usesWindowsChromeFromWsl = isWsl && executable.toLowerCase().endsWith(".exe");
	// Native Linux Chrome needs a Linux display. Windows Chrome launched from
	// WSL renders through Windows and does not require WSLg display variables.
	if (!usesWindowsChromeFromWsl && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
		throw new PickerE2EError("display-unavailable", "preflight");
	}

	const accessPath = inputs.accessPath ?? access;
	const mkdirPath = inputs.mkdirPath ?? mkdir;
	const realpathPath = inputs.realpathPath ?? realpath;
	const statPath = inputs.statPath ?? lstat;
	const openPath = inputs.openPath ?? open;
	try {
		await accessPath(executable, constants.X_OK);
	} catch {
		throw new PickerE2EError("chrome-not-executable", "preflight");
	}
	try {
		await mkdirPath(profileDir, { recursive: true });
		const profile = await realpathPath(profileDir);
		const repo = await realpathPath(inputs.repoDir ?? process.cwd());
		const fromRepo = relative(repo, profile);
		if (fromRepo === "" || (!fromRepo.startsWith("..") && !isAbsolute(fromRepo))) {
			throw new PickerE2EError("profile-inside-repository", "preflight");
		}
		for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
			try {
				await statPath(resolve(profile, lock));
				throw new PickerE2EError("profile-locked", "preflight");
			} catch (error) {
				if (error instanceof PickerE2EError) throw error;
			}
		}
		const probePath = resolve(profile, ".airsync-picker-write-check");
		const probe = await openPath(probePath, "wx");
		await probe.close();
		await unlink(probePath);
		await accessPath(profile, constants.W_OK);
	} catch (error) {
		if (error instanceof PickerE2EError) throw error;
		throw new PickerE2EError("profile-unusable", "preflight");
	}

	const timeoutSeconds = Number(env.AIRSYNC_E2E_GOOGLE_PICKER_TIMEOUT_SECONDS ?? DEFAULT_TIMEOUT_MS / 1000);
	if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds * 1000 > MAX_TIMEOUT_MS) {
		throw new PickerE2EError("timeout-invalid", "preflight");
	}

	const chromeExecutable = executable;
	let chromeProfileDir = profileDir;
	if (usesWindowsChromeFromWsl) {
		const convert = inputs.convertWslPath ?? ((path: string) => execFileSync("wslpath", ["-w", path], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim());
		try {
			// Validate both conversions, but keep /mnt/c/... for Linux spawn().
			// Only the user-data-dir argument consumed by Windows Chrome needs a
			// Windows path.
			const windowsExecutable = convert(executable);
			chromeProfileDir = convert(profileDir);
			if (!windowsExecutable || !chromeProfileDir) throw new Error("empty conversion");
		} catch {
			throw new PickerE2EError("wsl-path-conversion", "preflight");
		}
	}
	return { executable, profileDir, chromeExecutable, chromeProfileDir, timeoutMs: timeoutSeconds * 1000 };
}
