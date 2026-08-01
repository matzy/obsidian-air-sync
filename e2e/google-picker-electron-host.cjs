const { app, BrowserWindow } = require("electron");

const profilePath = process.env.AIRSYNC_E2E_ELECTRON_USER_DATA_DIR;
if (!profilePath) throw new Error("Missing AIRSYNC_E2E_ELECTRON_USER_DATA_DIR");
app.setPath("userData", profilePath);
app.commandLine.appendSwitch("disable-background-mode");

const debugPort = process.env.AIRSYNC_E2E_ELECTRON_DEBUG_PORT;
if (debugPort) {
	app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
	app.commandLine.appendSwitch("remote-debugging-port", debugPort);
}

const bootstrap = process.env.AIRSYNC_E2E_ELECTRON_BOOTSTRAP === "1";

app.whenReady().then(async () => {
	const window = new BrowserWindow({
		show: bootstrap,
		width: 1000,
		height: 760,
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
	});
	await window.loadURL(bootstrap ? "https://drive.google.com/" : "about:blank");
});

app.on("window-all-closed", () => app.quit());
