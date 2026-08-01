const { spawn, spawnSync } = require("node:child_process");
const { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, watch } = require("node:fs");
const http = require("node:http");
const { tmpdir } = require("node:os");
const { delimiter, join } = require("node:path");

const WATCHDOG_MS = 55_000;
const CLEANUP_MS = 2_000;
const activeRuns = new Set();

class PickerChromeError extends Error {
	constructor(stage, errorClass) {
		super("Google Picker system Chrome observer failed");
		this.stage = stage;
		this.errorClass = errorClass;
	}
}

function isExecutable(path, windowsExecutable = false) {
	try {
		accessSync(path, windowsExecutable ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function findOnPath(name) {
	for (const directory of (process.env.PATH || "").split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, name);
		if (isExecutable(candidate)) return candidate;
	}
	return null;
}

function resolveChromeExecutable() {
	const explicit = process.env.AIRSYNC_E2E_CHROME_PATH;
	if (explicit) {
		if (isExecutable(explicit, process.platform === "linux" && explicit.toLowerCase().endsWith(".exe"))) {
			return explicit;
		}
		throw new Error("AIRSYNC_E2E_CHROME_PATH does not name an executable system Chrome/Chromium");
	}
	for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
		const candidate = findOnPath(name);
		if (candidate) return candidate;
	}
	const absoluteCandidates =
		process.platform === "darwin"
			? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
			: process.platform === "win32"
				? [
						join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
						join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
					]
				: [
						"/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
						"/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
					];
	for (const candidate of absoluteCandidates) {
		if (candidate && isExecutable(candidate, candidate.toLowerCase().endsWith(".exe"))) return candidate;
	}
	throw new Error("System Chrome/Chromium was not found; set AIRSYNC_E2E_CHROME_PATH");
}

function windowsProfilePath(executable, profilePath) {
	if (process.platform !== "linux" || !executable.toLowerCase().endsWith(".exe")) return profilePath;
	const converted = spawnSync("wslpath", ["-w", profilePath], { encoding: "utf8", windowsHide: true });
	if (converted.status !== 0 || !converted.stdout.trim()) {
		throw new Error("Unable to prepare an isolated Windows Chrome profile from WSL");
	}
	return converted.stdout.trim();
}

function parseDevToolsActivePort(profilePath) {
	try {
		const [port, browserPath] = readFileSync(join(profilePath, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
		if (!port || !/^\d+$/.test(port) || !browserPath?.startsWith("/devtools/browser/")) return null;
		return `ws://127.0.0.1:${port}${browserPath}`;
	} catch {
		return null;
	}
}

function waitForDevTools(profilePath, child, signal) {
	const immediate = parseDevToolsActivePort(profilePath);
	if (immediate) return Promise.resolve(immediate);
	return new Promise((resolve, reject) => {
		let observer;
		let poller;
		const done = (error, value) => {
			observer?.close();
			if (poller) clearInterval(poller);
			child.removeListener("exit", onExit);
			child.removeListener("error", onError);
			signal.removeEventListener("abort", onAbort);
			error ? reject(error) : resolve(value);
		};
		const inspect = () => {
			const endpoint = parseDevToolsActivePort(profilePath);
			if (endpoint) done(null, endpoint);
		};
		const onExit = () => done(new PickerChromeError("launch", "browser-exited"));
		const onError = () => done(new PickerChromeError("launch", "browser-launch"));
		const onAbort = () => done(new PickerChromeError("watchdog", "timeout"));
		observer = watch(profilePath, inspect);
		poller = setInterval(inspect, 50);
		child.once("exit", onExit);
		child.once("error", onError);
		signal.addEventListener("abort", onAbort, { once: true });
		inspect();
	});
}

class CdpClient {
	constructor(socket, signal) {
		this.socket = socket;
		this.nextId = 1;
		this.pending = new Map();
		this.waiters = new Set();
		socket.addEventListener("message", (event) => this.onMessage(event.data));
		socket.addEventListener("close", () => this.failPending());
		signal.addEventListener("abort", () => this.failPending(), { once: true });
	}

	static connect(endpoint, signal) {
		if (typeof WebSocket !== "function") throw new Error("This Node runtime does not provide WebSocket");
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(endpoint);
			const onAbort = () => {
				socket.close();
				reject(new PickerChromeError("watchdog", "timeout"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			socket.addEventListener("open", () => {
				signal.removeEventListener("abort", onAbort);
				resolve(new CdpClient(socket, signal));
			}, { once: true });
			socket.addEventListener("error", () => reject(new PickerChromeError("cdp", "connection")), { once: true });
		});
	}

	onMessage(raw) {
		let message;
		try {
			message = JSON.parse(String(raw));
		} catch {
			this.failPending();
			return;
		}
		if (message.id) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			message.error ? pending.reject(new PickerChromeError("cdp", "command")) : pending.resolve(message.result);
			return;
		}
		for (const waiter of this.waiters) {
			if (waiter.method === message.method && waiter.sessionId === message.sessionId) {
				this.waiters.delete(waiter);
				waiter.resolve(message.params);
			}
		}
	}

	failPending() {
		const error = new PickerChromeError("cdp", "disconnected");
		for (const pending of this.pending.values()) pending.reject(error);
		for (const waiter of this.waiters) waiter.reject(error);
		this.pending.clear();
		this.waiters.clear();
	}

	send(method, params = {}, sessionId) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
			} catch {
				this.pending.delete(id);
				reject(new PickerChromeError("cdp", "command"));
			}
		});
	}

	waitFor(method, sessionId) {
		return new Promise((resolve, reject) => this.waiters.add({ method, sessionId, resolve, reject }));
	}

	close() {
		this.socket.close();
	}
}

function chromeIdentity(version) {
	const product = typeof version?.product === "string" ? version.product : "";
	const userAgent = typeof version?.userAgent === "string" ? version.userAgent : "";
	return /(?:Chrome|Chromium)\//.test(`${product} ${userAgent}`) && !/Electron/i.test(`${product} ${userAgent}`);
}

function electronIdentity(version) {
	const userAgent = typeof version?.userAgent === "string" ? version.userAgent : "";
	return /Electron\//i.test(userAgent);
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPickerHostDocument(client, sessionId) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			const ready = await client.send("Runtime.evaluate", {
				expression: `location.hostname === "airsync.takezo.dev" &&
					document.readyState === "complete" &&
					Boolean(document.querySelector("#content")) &&
					Boolean(document.querySelector("#choose"))`,
				returnByValue: true,
			}, sessionId);
			if (ready?.result?.value === true) return;
		} catch (error) {
			// A navigation can replace the execution context between polling calls.
			if (!(error instanceof PickerChromeError) || error.errorClass !== "command") throw error;
		}
		await delay(50);
	}
	throw new PickerChromeError("pre-picker", "missing-control");
}

async function evaluateValue(client, sessionId, expression, contextId) {
	const evaluated = await client.send("Runtime.evaluate", {
		expression,
		returnByValue: true,
		...(contextId ? { contextId } : {}),
	}, sessionId);
	return evaluated?.result?.value;
}

async function waitForPickerSdk(client, sessionId) {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const ready = await evaluateValue(
			client,
			sessionId,
			"Boolean(globalThis.google?.picker?.PickerBuilder)",
		);
		if (ready === true) return;
		const hostError = await evaluateValue(
			client,
			sessionId,
			"document.querySelector('#content .error')?.textContent || ''",
		);
		if (typeof hostError === "string" && hostError) {
			throw new PickerChromeError("picker-sdk", "picker-load");
		}
		await delay(100);
	}
	throw new PickerChromeError("picker-sdk", "timeout");
}

function flattenFrames(frameTree) {
	const result = [];
	const visit = (node) => {
		if (node?.frame) result.push(node.frame);
		for (const child of node?.childFrames || []) visit(child);
	};
	visit(frameTree);
	return result;
}

async function inspectPickerFrames(client, sessionId) {
	const tree = await client.send("Page.getFrameTree", {}, sessionId);
	const frames = flattenFrames(tree?.frameTree).filter((frame) => frame.parentId);
	const combined = {
		developerKeyInvalid: false,
		driveLocation: false,
		browserControl: false,
		childFrame: frames.length > 0,
	};
	for (const frame of frames) {
		try {
			const accessibility = await client.send("Accessibility.getFullAXTree", { frameId: frame.id }, sessionId);
			const axNodes = accessibility?.nodes || [];
			const axText = axNodes
				.flatMap((node) => [node.name?.value, node.description?.value])
				.filter((value) => typeof value === "string")
				.join("\n");
			const interactiveRoles = new Set(["button", "textbox", "searchbox", "tree", "listbox", "grid"]);
			const locationRoles = new Set(["navigation", "tree", "treeitem", "tab", "list", "listitem", "listbox", "grid", "row"]);
			combined.developerKeyInvalid ||= /(?:developer|api) key[^\n]{0,80}(?:invalid|not valid)|invalid[^\n]{0,80}(?:developer|api) key/i.test(axText);
			combined.driveLocation ||= /(?:My Drive|Shared drives|Shared with me|Recent|マイドライブ|共有ドライブ|共有アイテム|最近使用したアイテム)/i.test(axText);
			combined.driveLocation ||= axNodes.some((node) => locationRoles.has(node.role?.value));
			combined.browserControl ||= axNodes.some((node) => interactiveRoles.has(node.role?.value));

			const world = await client.send("Page.createIsolatedWorld", {
				frameId: frame.id,
				worldName: "air-sync-picker-e2e",
				grantUniveralAccess: false,
			}, sessionId);
			const observed = await evaluateValue(
				client,
				sessionId,
				`(() => {
					const text = document.body?.innerText || "";
					return {
						developerKeyInvalid: /(?:developer|api) key[^\\n]{0,80}(?:invalid|not valid)|invalid[^\\n]{0,80}(?:developer|api) key/i.test(text),
						driveLocation: /(?:My Drive|Shared drives|Shared with me|Recent|マイドライブ|共有ドライブ|共有アイテム|最近使用したアイテム)/i.test(text),
						browserControl: Boolean(document.querySelector('input, [role="tree"], [role="listbox"], [aria-label*="Search"], [aria-label*="検索"]')),
					};
				})()`,
				world?.executionContextId,
			);
			if (!observed || typeof observed !== "object") continue;
			combined.developerKeyInvalid ||= observed.developerKeyInvalid === true;
			combined.driveLocation ||= observed.driveLocation === true;
			combined.browserControl ||= observed.browserControl === true;
		} catch {
			// Cross-process frames can appear before their execution context is ready.
		}
	}
	return combined;
}

async function inspectPickerTargets(client, targetSessions) {
	const targets = await client.send("Target.getTargets");
	const pickerTargets = (targets?.targetInfos || []).filter((target) =>
		target.type === "iframe" && /(?:google|gstatic)\.(?:com|com\.[a-z]{2}|[a-z]{2})/i.test(target.url || ""),
	);
	const combined = {
		developerKeyInvalid: false,
		driveLocation: false,
		browserControl: false,
		childFrame: pickerTargets.length > 0,
		targetAttached: false,
		targetEvaluated: false,
		bodyNonEmpty: false,
		googleError: false,
		signIn: false,
		loading: false,
	};
	for (const target of pickerTargets) {
		try {
			let childSessionId = targetSessions.get(target.targetId);
			if (!childSessionId) {
				const attached = await client.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
				childSessionId = attached.sessionId;
				targetSessions.set(target.targetId, childSessionId);
				await Promise.all([
					client.send("Runtime.enable", {}, childSessionId),
					client.send("Accessibility.enable", {}, childSessionId),
				]);
			}
			combined.targetAttached = true;
			const accessibility = await client.send("Accessibility.getFullAXTree", {}, childSessionId);
			const axNodes = accessibility?.nodes || [];
			const axText = axNodes
				.flatMap((node) => [node.name?.value, node.description?.value])
				.filter((value) => typeof value === "string")
				.join("\n");
			const interactiveRoles = new Set(["button", "textbox", "searchbox", "tree", "listbox", "grid"]);
			const locationRoles = new Set(["navigation", "tree", "treeitem", "tab", "list", "listitem", "listbox", "grid", "row"]);
			combined.developerKeyInvalid ||= /(?:developer|api) key[^\n]{0,80}(?:invalid|not valid)|invalid[^\n]{0,80}(?:developer|api) key/i.test(axText);
			combined.googleError ||= /(?:error|invalid|unauthorized|permission|oauth|app id|developer key)/i.test(axText);
			combined.driveLocation ||= /(?:My Drive|Shared drives|Shared with me|Recent|マイドライブ|共有ドライブ|共有アイテム|最近使用したアイテム)/i.test(axText);
			combined.driveLocation ||= axNodes.some((node) => locationRoles.has(node.role?.value));
			combined.browserControl ||= axNodes.some((node) => interactiveRoles.has(node.role?.value));
			combined.signIn ||= /(?:sign in|ログイン)/i.test(axText);
			combined.loading ||= /(?:loading|読み込み)/i.test(axText);
			const observed = await evaluateValue(
				client,
				childSessionId,
				`(() => {
					const text = document.body?.innerText || "";
					return {
						bodyNonEmpty: text.trim().length > 0,
						developerKeyInvalid: /(?:developer|api) key[^\\n]{0,80}(?:invalid|not valid)|invalid[^\\n]{0,80}(?:developer|api) key/i.test(text),
						googleError: /(?:error|invalid|unauthorized|permission|oauth|app id|developer key)/i.test(text),
						signIn: /(?:sign in|ログイン)/i.test(text),
						loading: /(?:loading|読み込み)/i.test(text),
						driveLocation: /(?:My Drive|Shared drives|Shared with me|Recent|マイドライブ|共有ドライブ|共有アイテム|最近使用したアイテム)/i.test(text),
						browserControl: Boolean(document.querySelector('input, [role="tree"], [role="listbox"], [role="grid"], [aria-label*="Search"], [aria-label*="検索"]')),
					};
				})()`,
			);
			if (!observed || typeof observed !== "object") continue;
			combined.targetEvaluated = true;
			combined.bodyNonEmpty ||= observed.bodyNonEmpty === true;
			combined.developerKeyInvalid ||= observed.developerKeyInvalid === true;
			combined.googleError ||= observed.googleError === true;
			combined.signIn ||= observed.signIn === true;
			combined.loading ||= observed.loading === true;
			combined.driveLocation ||= observed.driveLocation === true;
			combined.browserControl ||= observed.browserControl === true;
		} catch {
			// Targets can disappear or swap processes while the Picker initializes.
		}
	}
	return combined;
}

async function credentialedPickerOracle(client, sessionId, mode) {
	await waitForPickerSdk(client, sessionId);
	await evaluateValue(client, sessionId, "document.querySelector('#choose').click(); true");
	const deadline = Date.now() + 45_000;
	const targetSessions = new Map();
	let last = {
		dialog: false,
		developerKeyInvalid: false,
		driveLocation: false,
		browserControl: false,
		childFrame: false,
		targetAttached: false,
		targetEvaluated: false,
		bodyNonEmpty: false,
		googleError: false,
		signIn: false,
		loading: false,
	};
	while (Date.now() < deadline) {
		const top = await evaluateValue(
			client,
			sessionId,
			`({
				dialog: Boolean(document.querySelector('[role="dialog"], .picker-dialog')),
				hostError: document.querySelector('#content .error')?.textContent || '',
			})`,
		);
		const frame = await inspectPickerFrames(client, sessionId);
		const target = await inspectPickerTargets(client, targetSessions);
		frame.developerKeyInvalid ||= target.developerKeyInvalid;
		frame.driveLocation ||= target.driveLocation;
		frame.browserControl ||= target.browserControl;
		frame.childFrame ||= target.childFrame;
		frame.targetAttached = target.targetAttached;
		frame.targetEvaluated = target.targetEvaluated;
		frame.bodyNonEmpty = target.bodyNonEmpty;
		frame.googleError = target.googleError;
		frame.signIn = target.signIn;
		frame.loading = target.loading;
		last = { dialog: top?.dialog === true, ...frame };
		if (mode === "invalid-key" && frame.developerKeyInvalid) {
			return { kind: "invalid-key", dialog: top?.dialog === true, ...frame };
		}
		if (mode === "valid" && top?.dialog === true && frame.childFrame && frame.driveLocation && frame.browserControl) {
			return { kind: "interactive", dialog: true, ...frame };
		}
		if (typeof top?.hostError === "string" && top.hostError) {
			throw new PickerChromeError("picker", "host-error");
		}
		await delay(200);
	}
	const flags = `d${Number(last.dialog)}f${Number(last.childFrame)}a${Number(last.targetAttached)}e${Number(last.targetEvaluated)}t${Number(last.bodyNonEmpty)}g${Number(last.googleError)}s${Number(last.signIn)}w${Number(last.loading)}l${Number(last.driveLocation)}b${Number(last.browserControl)}k${Number(last.developerKeyInvalid)}`;
	throw new PickerChromeError(
		"picker",
		mode === "invalid-key" ? `invalid-key-not-observed-${flags}` : `interactive-timeout-${flags}`,
	);
}

async function tokenEmptyOracle(client, sessionId) {
	const document = await client.send("DOM.getDocument", { depth: 1 }, sessionId);
	const rootNodeId = document?.root?.nodeId;
	if (!rootNodeId) throw new PickerChromeError("document", "missing-document");
	const [content, choose] = await Promise.all([
		client.send("DOM.querySelector", { nodeId: rootNodeId, selector: "#content" }, sessionId),
		client.send("DOM.querySelector", { nodeId: rootNodeId, selector: "#choose" }, sessionId),
	]);
	if (!content?.nodeId || !choose?.nodeId) throw new PickerChromeError("pre-picker", "missing-control");
	const installed = await client.send("Runtime.evaluate", {
		expression: `(() => {
			const content = document.querySelector("#content");
			if (!content) return false;
			globalThis.__airSyncPickerErrorPromise = new Promise((resolve) => {
				const inspect = () => {
					const error = document.querySelector("#content .error");
					if (error && /access token/i.test(error.textContent || "")) resolve(true);
				};
				new MutationObserver(inspect).observe(content, { childList: true, subtree: true });
			});
			return true;
		})()`,
		returnByValue: true,
	}, sessionId);
	if (installed?.result?.value !== true) throw new PickerChromeError("pre-picker", "observer-install");
	const resolved = await client.send("DOM.resolveNode", { nodeId: choose.nodeId }, sessionId);
	const objectId = resolved?.object?.objectId;
	if (!objectId) throw new PickerChromeError("pre-picker", "missing-control");
	await client.send("Runtime.callFunctionOn", {
		objectId,
		functionDeclaration: "function () { this.click(); return true; }",
		returnByValue: true,
	}, sessionId);
	const observed = await client.send("Runtime.evaluate", {
		expression: "globalThis.__airSyncPickerErrorPromise",
		awaitPromise: true,
		returnByValue: true,
	}, sessionId);
	return observed?.result?.value === true;
}

function waitForExit(child, timeoutMs) {
	if (child.exitCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

function settleWithin(promise, timeoutMs) {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, timeoutMs);
		promise.then(() => {
			clearTimeout(timer);
			resolve();
		}, () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

function killProcessGroup(child) {
	if (!child?.pid) return;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		try { child.kill("SIGKILL"); } catch { /* already exited */ }
	}
}

function reservePort() {
	return new Promise((resolve, reject) => {
		const server = http.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close((error) => error ? reject(error) : resolve(port));
		});
	});
}

function readElectronEndpoint(port) {
	return new Promise((resolve) => {
		const request = http.get(`http://127.0.0.1:${port}/json/version`, (response) => {
			let body = "";
			response.on("data", (chunk) => (body += chunk));
			response.on("end", () => {
				try {
					resolve(JSON.parse(body).webSocketDebuggerUrl || null);
				} catch {
					resolve(null);
				}
			});
		});
		request.on("error", () => resolve(null));
		request.setTimeout(500, () => {
			request.destroy();
			resolve(null);
		});
	});
}

async function waitForElectronEndpoint(port, child, signal) {
	while (!signal.aborted) {
		if (child.exitCode !== null) throw new PickerChromeError("launch", "electron-exited");
		const endpoint = await readElectronEndpoint(port);
		if (endpoint) return endpoint;
		await delay(100);
	}
	throw new PickerChromeError("watchdog", "timeout");
}

async function cleanupRun(run) {
	if (run.cleaning) return run.cleaning;
	run.cleaning = (async () => {
		if (run.client) await settleWithin(run.client.send("Browser.close"), CLEANUP_MS);
		if (run.child && !(await waitForExit(run.child, CLEANUP_MS))) killProcessGroup(run.child);
		try { run.client?.close(); } catch { /* already disconnected */ }
		if (run.temporaryProfile) rmSync(run.profilePath, { recursive: true, force: true });
		activeRuns.delete(run);
	})();
	return run.cleaning;
}

async function cleanupGooglePickerChrome() {
	await Promise.all([...activeRuns].map(cleanupRun));
}

async function observeGooglePicker(client, command, identity) {
	const version = await client.send("Browser.getVersion");
	if (!identity.check(version)) throw new PickerChromeError("identity", identity.errorClass);
	let targetId;
	if (identity.reusePage) {
		const targets = await client.send("Target.getTargets");
		targetId = targets?.targetInfos?.find((target) => target.type === "page")?.targetId;
		if (!targetId) throw new PickerChromeError("target", "missing-electron-window");
	} else {
		const target = await client.send("Target.createTarget", { url: "about:blank" });
		targetId = target.targetId;
	}
	const attached = await client.send("Target.attachToTarget", { targetId, flatten: true });
	const sessionId = attached.sessionId;
	await Promise.all([
		client.send("Page.enable", {}, sessionId),
		client.send("Runtime.enable", {}, sessionId),
		client.send("DOM.enable", {}, sessionId),
		client.send("Accessibility.enable", {}, sessionId),
		client.send("Network.enable", {}, sessionId),
	]);
	if (command.mode === "token-empty") {
		await client.send("Network.setBlockedURLs", { urls: ["https://apis.google.com/js/api.js*"] }, sessionId);
	}
	await client.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `Object.defineProperty(globalThis, "__airSyncPickerTokenPresent", {
			value: Boolean(new URLSearchParams(location.hash.replace(/^#/, "")).get("token")),
			configurable: false
		});`,
	}, sessionId);
	await client.send("Page.navigate", { url: command.url }, sessionId);
	await waitForPickerHostDocument(client, sessionId);
	const token = await client.send("Runtime.evaluate", {
		expression: "globalThis.__airSyncPickerTokenPresent",
		returnByValue: true,
	}, sessionId);
	if (typeof token?.result?.value !== "boolean") throw new PickerChromeError("pre-scrub", "token-observation");
	const tokenPresent = token.result.value;
	if (command.mode !== "token-empty") {
		if (!tokenPresent) throw new PickerChromeError("pre-picker", "token-empty");
		const observed = await credentialedPickerOracle(client, sessionId, command.mode);
		if (observed.kind === "invalid-key") {
			return {
				ok: false,
				stage: "picker-error",
				error_class: "developer-key-invalid",
				token_present: true,
				interactive: false,
			};
		}
		return {
			ok: true,
			stage: "interactive-ready",
			error_class: null,
			token_present: true,
			interactive: true,
			signal: {
				dialog: observed.dialog,
				drive_location: observed.driveLocation,
				browser_control: observed.browserControl,
				child_frame: observed.childFrame,
			},
		};
	}
	const observed = await tokenEmptyOracle(client, sessionId);
	return {
		ok: false,
		stage: "pre-picker",
		error_class: observed ? "token-empty" : "unexpected-page-error",
		token_present: tokenPresent,
		interactive: false,
	};
}

async function runGooglePickerChrome(command) {
	const executable = resolveChromeExecutable();
	const configuredProfile = process.env.AIRSYNC_E2E_CHROME_USER_DATA_DIR;
	const profilePath = configuredProfile || mkdtempSync(join(tmpdir(), "airsync-picker-chrome-"));
	if (configuredProfile) mkdirSync(profilePath, { recursive: true });
	const run = { child: null, client: null, profilePath, temporaryProfile: !configuredProfile, cleaning: null };
	const controller = new AbortController();
	const watchdog = setTimeout(() => controller.abort(), WATCHDOG_MS);
	try {
		const chromeProfile = windowsProfilePath(executable, profilePath);
		rmSync(join(profilePath, "DevToolsActivePort"), { force: true });
		run.child = spawn(executable, [
			"--headless=new", "--disable-gpu", "--disable-extensions", "--disable-default-apps",
			"--disable-background-mode", "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1",
			"--remote-debugging-port=0", `--user-data-dir=${chromeProfile}`, "about:blank",
		], { detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		run.child.stdout?.resume();
		run.child.stderr?.resume();
		activeRuns.add(run);
		const endpoint = await waitForDevTools(profilePath, run.child, controller.signal);
		run.client = await CdpClient.connect(endpoint, controller.signal);
		return { ...(await observeGooglePicker(run.client, command, { check: chromeIdentity, errorClass: "not-system-chrome" })), chrome_identity: true };
	} catch (error) {
		if (error instanceof PickerChromeError) {
			return {
				ok: false,
				stage: error.stage,
				error_class: error.errorClass,
				token_present: false,
				interactive: false,
				chrome_identity: error.errorClass === "not-system-chrome" ? false : Boolean(run.client),
			};
		}
		throw error;
	} finally {
		clearTimeout(watchdog);
		await cleanupRun(run);
	}
}

function electronLaunch(profilePath, extraEnv = {}) {
	const electronPath = require("electron");
	const hostScript = join(__dirname, "google-picker-electron-host.cjs");
	const headless = process.platform === "linux" && !process.env.DISPLAY;
	const executable = headless ? "xvfb-run" : electronPath;
	const args = headless
		? ["-a", electronPath, hostScript, "--no-sandbox"]
		: [hostScript, "--no-sandbox"];
	return spawn(executable, args, {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, AIRSYNC_E2E_ELECTRON_USER_DATA_DIR: profilePath, ...extraEnv },
	});
}

async function runGooglePickerElectron(command) {
	const configuredProfile = process.env.AIRSYNC_E2E_ELECTRON_USER_DATA_DIR;
	const profilePath = configuredProfile || mkdtempSync(join(tmpdir(), "airsync-picker-electron-"));
	if (configuredProfile) mkdirSync(profilePath, { recursive: true });
	const port = await reservePort();
	const run = { child: null, client: null, profilePath, temporaryProfile: !configuredProfile, cleaning: null };
	const controller = new AbortController();
	const watchdog = setTimeout(() => controller.abort(), WATCHDOG_MS);
	try {
		run.child = electronLaunch(profilePath, { AIRSYNC_E2E_ELECTRON_DEBUG_PORT: String(port) });
		run.child.stdout?.resume();
		run.child.stderr?.resume();
		activeRuns.add(run);
		const endpoint = await waitForElectronEndpoint(port, run.child, controller.signal);
		run.client = await CdpClient.connect(endpoint, controller.signal);
		return {
			...(await observeGooglePicker(run.client, command, {
				check: electronIdentity,
				errorClass: "not-electron",
				reusePage: true,
			})),
			electron_identity: true,
		};
	} catch (error) {
		if (error instanceof PickerChromeError) {
			return {
				ok: false,
				stage: error.stage,
				error_class: error.errorClass,
				token_present: false,
				interactive: false,
				electron_identity: error.errorClass === "not-electron" ? false : Boolean(run.client),
			};
		}
		throw error;
	} finally {
		clearTimeout(watchdog);
		await cleanupRun(run);
	}
}

async function bootstrapGooglePickerChrome(profilePath) {
	if (!profilePath) throw new Error("Missing AIRSYNC_E2E_CHROME_USER_DATA_DIR");
	const executable = resolveChromeExecutable();
	mkdirSync(profilePath, { recursive: true });
	const chromeProfile = windowsProfilePath(executable, profilePath);
	const child = spawn(executable, [
		`--user-data-dir=${chromeProfile}`,
		"--disable-background-mode",
		"--no-first-run",
		"--no-default-browser-check",
		"https://drive.google.com/",
	], { stdio: "ignore", windowsHide: false });
	await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Chrome exited with code ${code}`)));
	});
}

async function bootstrapGooglePickerElectron(profilePath) {
	if (!profilePath) throw new Error("Missing AIRSYNC_E2E_ELECTRON_USER_DATA_DIR");
	mkdirSync(profilePath, { recursive: true });
	const child = electronLaunch(profilePath, { AIRSYNC_E2E_ELECTRON_BOOTSTRAP: "1" });
	child.stdout?.resume();
	child.stderr?.resume();
	await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Electron exited with code ${code}`)));
	});
}

module.exports = {
	bootstrapGooglePickerChrome,
	bootstrapGooglePickerElectron,
	cleanupGooglePickerChrome,
	runGooglePickerChrome,
	runGooglePickerElectron,
};
