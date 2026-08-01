import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

for (const line of readFileSync(resolve(process.cwd(), ".env.e2e"), "utf8").split("\n")) {
	const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
	if (match?.[1] && !(match[1] in process.env)) {
		process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
	}
}

const require = createRequire(import.meta.url);
const { bootstrapGooglePickerElectron } = require("./google-picker-chrome.cjs");

process.stdout.write(
	"Sign in to the Google test account in the dedicated Electron window, open Google Drive, then close that window.\n",
);
await bootstrapGooglePickerElectron(process.env.AIRSYNC_E2E_ELECTRON_USER_DATA_DIR);
process.stdout.write("Google Picker Electron profile bootstrap completed.\n");
