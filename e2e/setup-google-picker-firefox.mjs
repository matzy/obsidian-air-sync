import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const installRoot = process.env.AIRSYNC_E2E_FIREFOX_INSTALL_DIR || join(homedir(), ".cache", "obsidian-air-sync", "firefox-e2e");
const firefoxDir = join(installRoot, "firefox");
const driverDir = join(installRoot, "geckodriver");
const firefoxPath = join(firefoxDir, "firefox");
const geckodriverPath = join(driverDir, "geckodriver");
const profileDir = join(installRoot, "profile");

async function download(url, destination) {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
	await pipeline(response.body, createWriteStream(destination, { mode: 0o600 }));
}

function run(command, args) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`${basename(command)} exited with ${code}`)));
	});
}

function upsertEnv(values) {
	const path = resolve(process.cwd(), ".env.e2e");
	let lines = [];
	try {
		lines = readFileSync(path, "utf8").split("\n");
	} catch {
		// Create the gitignored file when this is the first E2E setup.
	}
	for (const [key, value] of Object.entries(values)) {
		const index = lines.findIndex((line) => line.startsWith(`${key}=`));
		if (index >= 0) lines[index] = `${key}=${value}`;
		else lines.push(`${key}=${value}`);
	}
	writeFileSync(path, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
}

mkdirSync(installRoot, { recursive: true });
mkdirSync(profileDir, { recursive: true });

if (!existsSync(firefoxPath)) {
	const archive = join(tmpdir(), `airsync-firefox-${process.pid}.tar.xz`);
	try {
		process.stdout.write("Downloading Mozilla Firefox...\n");
		await download("https://download.mozilla.org/?product=firefox-latest-ssl&os=linux64&lang=en-US", archive);
		rmSync(firefoxDir, { recursive: true, force: true });
		mkdirSync(firefoxDir, { recursive: true });
		await run("tar", ["-xJf", archive, "--strip-components=1", "-C", firefoxDir]);
	} finally {
		rmSync(archive, { force: true });
	}
}

if (!existsSync(geckodriverPath)) {
	process.stdout.write("Resolving the latest Mozilla GeckoDriver...\n");
	const release = await fetch("https://api.github.com/repos/mozilla/geckodriver/releases/latest", {
		headers: { Accept: "application/vnd.github+json", "User-Agent": "obsidian-air-sync-e2e-setup" },
	});
	if (!release.ok) throw new Error(`GeckoDriver release lookup failed (${release.status})`);
	const metadata = await release.json();
	const asset = metadata.assets?.find((item) => /linux64\.tar\.gz$/.test(item.name));
	if (!asset?.browser_download_url) throw new Error("Latest GeckoDriver release has no linux64 archive");
	const archive = join(tmpdir(), `airsync-geckodriver-${process.pid}.tar.gz`);
	try {
		await download(asset.browser_download_url, archive);
		rmSync(driverDir, { recursive: true, force: true });
		mkdirSync(driverDir, { recursive: true });
		await run("tar", ["-xzf", archive, "-C", driverDir]);
		await run("chmod", ["0700", geckodriverPath]);
	} finally {
		rmSync(archive, { force: true });
	}
}

upsertEnv({
	AIRSYNC_E2E_FIREFOX_PATH: firefoxPath,
	AIRSYNC_E2E_GECKODRIVER_PATH: geckodriverPath,
	AIRSYNC_E2E_FIREFOX_PROFILE_DIR: profileDir,
});

process.stdout.write(`Firefox E2E environment installed under ${installRoot}\n`);
