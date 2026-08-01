import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

for (const line of readFileSync(resolve(process.cwd(), ".env.e2e"), "utf8").split("\n")) {
	const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
	if (match?.[1] && !(match[1] in process.env)) {
		process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
	}
}

const firefoxPath = process.env.AIRSYNC_E2E_FIREFOX_PATH;
const profilePath = process.env.AIRSYNC_E2E_FIREFOX_PROFILE_DIR;
if (!firefoxPath || !profilePath) throw new Error("Run npm run e2e:setup:google-picker:firefox first");

const clientId = process.env.AIRSYNC_E2E_GOOGLE_CLIENT_ID;
const clientSecret = process.env.AIRSYNC_E2E_GOOGLE_CLIENT_SECRET;
const refreshToken = process.env.AIRSYNC_E2E_GOOGLE_REFRESH_TOKEN;
if (!clientId || !clientSecret || !refreshToken) {
	throw new Error("Missing Google E2E OAuth credentials in .env.e2e");
}

const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
	method: "POST",
	headers: { "Content-Type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		refresh_token: refreshToken,
		grant_type: "refresh_token",
	}),
});
const tokenPayload = await tokenResponse.json();
if (!tokenResponse.ok || typeof tokenPayload.access_token !== "string") {
	throw new Error("Unable to refresh the Google E2E access token");
}

// Public, referrer-restricted production Picker key; keep in sync with folder-picker-url.ts.
const pickerKey = "AIzaSyDyXTKejmlaTcBIDCx3lJYFhDMmyRKRZwc";
const pickerUrl = `https://airsync.takezo.dev/googledrive-folder?state=e2e-firefox-bootstrap&apiKey=${encodeURIComponent(pickerKey)}#token=${encodeURIComponent(tokenPayload.access_token)}`;

process.stdout.write(
	"Sign in if requested, click Allow cookies in the Picker, confirm the Drive folder browser appears, then close Firefox.\n",
);
const child = spawn(firefoxPath, ["-no-remote", "-profile", profilePath, pickerUrl], {
	stdio: "ignore",
});
await new Promise((resolveRun, reject) => {
	child.once("error", reject);
	child.once("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`Firefox exited with ${code}`)));
});
process.stdout.write("Google Picker Firefox profile bootstrap completed.\n");
