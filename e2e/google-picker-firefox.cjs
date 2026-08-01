const { spawn } = require("node:child_process");
const http = require("node:http");

const WATCHDOG_MS = 60_000;
const activeRuns = new Set();

class FirefoxPickerError extends Error {
	constructor(stage, errorClass) {
		super("Google Picker Firefox observer failed");
		this.stage = stage;
		this.errorClass = errorClass;
	}
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

async function webdriverRequest(port, method, path, body) {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		method,
		headers: body ? { "Content-Type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	const payload = await response.json();
	if (!response.ok || payload.value?.error) {
		throw new FirefoxPickerError("webdriver", payload.value?.error || `http-${response.status}`);
	}
	return payload.value;
}

async function waitForDriver(port, child, signal) {
	while (!signal.aborted) {
		if (child.exitCode !== null) throw new FirefoxPickerError("launch", "geckodriver-exited");
		try {
			const status = await webdriverRequest(port, "GET", "/status");
			if (status.ready) return;
		} catch {
			// GeckoDriver has not bound the port yet.
		}
		await delay(100);
	}
	throw new FirefoxPickerError("watchdog", "timeout");
}

class BidiClient {
	constructor(socket, signal) {
		this.socket = socket;
		this.nextId = 1;
		this.pending = new Map();
		socket.addEventListener("message", (event) => this.onMessage(event.data));
		socket.addEventListener("close", () => this.failPending());
		signal.addEventListener("abort", () => this.failPending(), { once: true });
	}

	static connect(endpoint, signal) {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(endpoint);
			socket.addEventListener("open", () => resolve(new BidiClient(socket, signal)), { once: true });
			socket.addEventListener("error", () => reject(new FirefoxPickerError("bidi", "connection")), { once: true });
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
		if (!message.id) return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		message.type === "error"
			? pending.reject(new FirefoxPickerError("bidi", message.error || "command"))
			: pending.resolve(message.result);
	}

	failPending() {
		const error = new FirefoxPickerError("bidi", "disconnected");
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	send(method, params = {}) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	close() {
		this.socket.close();
	}
}

function remoteValue(value) {
	return value?.type === "success" ? value.result?.value : undefined;
}

async function evaluate(client, context, expression) {
	return remoteValue(await client.send("script.evaluate", {
		expression,
		target: { context },
		awaitPromise: true,
		resultOwnership: "none",
	}));
}

async function clickCookieConsent(client, context) {
	const located = await client.send("script.evaluate", {
		expression: `(() => {
			const roots = [document];
			for (const root of roots) {
				for (const element of root.querySelectorAll("*")) {
					if (element.shadowRoot) roots.push(element.shadowRoot);
					const text = [element.textContent || "", element.getAttribute("aria-label") || ""].join(" ");
					if (element.matches('button, [role="button"]') && /(?:allow|accept).{0,30}cookies|cookies.{0,30}(?:allow|accept)|Cookie.{0,30}許可/i.test(text)) return element;
				}
			}
			return null;
		})()`,
		target: { context },
		awaitPromise: false,
		resultOwnership: "root",
	});
	const sharedId = located?.type === "success" ? located.result?.sharedId : undefined;
	if (!sharedId) return false;
	await client.send("input.performActions", {
		context,
		actions: [{
			type: "pointer",
			id: "air-sync-firefox-mouse",
			parameters: { pointerType: "mouse" },
			actions: [
				{ type: "pointerMove", x: 0, y: 0, duration: 0, origin: { type: "element", element: { sharedId } } },
				{ type: "pointerDown", button: 0 },
				{ type: "pointerUp", button: 0 },
			],
		}],
	});
	await client.send("input.releaseActions", { context });
	return true;
}

function flattenContexts(contexts) {
	const result = [];
	const visit = (context) => {
		result.push(context);
		for (const child of context.children || []) visit(child);
	};
	for (const context of contexts || []) visit(context);
	return result;
}

async function waitForHost(client, context) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			const ready = await evaluate(client, context, `location.hostname === "airsync.takezo.dev" &&
				document.readyState === "complete" && Boolean(document.querySelector("#content")) &&
				Boolean(document.querySelector("#choose"))`);
			if (ready === true) return;
		} catch {
			// Navigation can replace the realm between polls.
		}
		await delay(50);
	}
	throw new FirefoxPickerError("pre-picker", "missing-control");
}

async function tokenEmptyOracle(client, context) {
	const observed = await evaluate(client, context, `(() => {
		const button = document.querySelector("#choose");
		if (!button) return false;
		button.click();
		return Boolean(document.querySelector("#content .error")?.textContent?.match(/access token/i));
	})()`);
	return observed === true;
}

async function waitForSdk(client, context) {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (await evaluate(client, context, "Boolean(globalThis.google?.picker?.PickerBuilder)")) return;
		await delay(100);
	}
	throw new FirefoxPickerError("picker-sdk", "timeout");
}

async function credentialedOracle(client, topContext, mode) {
	await waitForSdk(client, topContext);
	await evaluate(client, topContext, "document.querySelector('#choose').click(); true");
	const deadline = Date.now() + 45_000;
	let last = {
		dialog: false,
		childContext: false,
		pickerContext: false,
		bodyNonEmpty: false,
		developerKeyInvalid: false,
		driveLocation: false,
		browserControl: false,
		cookieConsent: false,
		signIn: false,
		googleError: false,
	};
	while (Date.now() < deadline) {
		const tree = await client.send("browsingContext.getTree", {});
		const contexts = flattenContexts(tree.contexts).filter((context) => context.context !== topContext);
		const pickerContext = contexts.some((context) => /(?:\/picker(?:\/|\?|$)|picker\.)/i.test(context.url || ""));
		const topObserved = await evaluate(
			client,
			topContext,
			`(() => {
				const text = document.querySelector('[role="dialog"], .picker-dialog')?.textContent || '';
				return JSON.stringify({
					dialog: Boolean(document.querySelector('[role="dialog"], .picker-dialog')),
					developerKeyInvalid: /(?:developer|api) key[^\\n]{0,80}(?:invalid|not valid)|invalid[^\\n]{0,80}(?:developer|api) key/i.test(text),
				});
			})()`,
		);
		const top = typeof topObserved === "string" ? JSON.parse(topObserved) : {};
		let developerKeyInvalid = top.developerKeyInvalid === true;
		let driveLocation = false;
		let browserControl = false;
		let cookieConsent = false;
		let signIn = false;
		let bodyNonEmpty = false;
		let googleError = false;
		for (const context of contexts) {
			try {
				const observed = await evaluate(client, context.context, `(() => {
					const roots = [document];
					const textParts = [document.body?.innerText || ""];
					let deepControl = false;
					let cookieConsent = false;
					for (const root of roots) {
						for (const element of root.querySelectorAll("*")) {
							const accessibleText = [element.textContent || "", element.getAttribute("aria-label") || ""].join(" ");
							if (element.matches('button, [role="button"]') && /(?:allow|accept).{0,30}cookies|cookies.{0,30}(?:allow|accept)|Cookie.{0,30}許可/i.test(accessibleText)) {
								cookieConsent = true;
							}
							for (const attribute of ["aria-label", "aria-description", "title", "alt", "value"]) {
								const value = element.getAttribute(attribute);
								if (value) textParts.push(value);
							}
							if (element.matches('button, input, [role="button"], [role="textbox"], [role="searchbox"], [role="tree"], [role="listbox"], [role="grid"]')) deepControl = true;
							if (element.shadowRoot) {
								roots.push(element.shadowRoot);
								textParts.push(element.shadowRoot.textContent || "");
							}
						}
					}
					const text = textParts.join("\\n");
					cookieConsent ||= /necessary cookies|(?:allow|accept).{0,30}cookies|Cookie.{0,30}許可/i.test(text);
					return JSON.stringify({
						bodyNonEmpty: text.trim().length > 0,
						developerKeyInvalid: /(?:developer|api) key[^\\n]{0,80}(?:invalid|not valid)|invalid[^\\n]{0,80}(?:developer|api) key/i.test(text),
						googleError: /(?:error|invalid|unauthorized|permission|oauth|app id|developer key)/i.test(text),
						driveLocation: /(?:My Drive|Shared drives|Shared with me|Recent|folder|マイ\\s*ドライブ|共有ドライブ|共有アイテム|最近使用したアイテム|フォルダ)/i.test(text) || Boolean(document.querySelector('[role="navigation"], [role="tree"], [role="treeitem"], [role="tab"], [role="list"], [role="listitem"], [role="listbox"], [role="grid"], [role="row"]')),
						browserControl: deepControl,
						cookieConsent,
						signIn: /(?:sign in|ログイン)/i.test(text),
					});
				})()`);
				const parsed = typeof observed === "string" ? JSON.parse(observed) : {};
				bodyNonEmpty ||= parsed.bodyNonEmpty === true;
				developerKeyInvalid ||= parsed.developerKeyInvalid === true;
				googleError ||= parsed.googleError === true;
				driveLocation ||= parsed.driveLocation === true;
				browserControl ||= parsed.browserControl === true;
				cookieConsent ||= parsed.cookieConsent === true;
				if (parsed.cookieConsent === true) await clickCookieConsent(client, context.context);
				signIn ||= parsed.signIn === true;
			} catch {
				// Contexts can be replaced while the Picker initializes.
			}
		}
		driveLocation ||= pickerContext && bodyNonEmpty && browserControl && !cookieConsent && !signIn && !googleError;
		last = {
			dialog: top.dialog === true,
			childContext: contexts.length > 0,
			pickerContext,
			bodyNonEmpty,
			developerKeyInvalid,
			driveLocation,
			browserControl,
			cookieConsent,
			signIn,
			googleError,
		};
		if (developerKeyInvalid) return { kind: "invalid-key" };
		if (mode === "valid" && top.dialog && pickerContext && driveLocation && browserControl && !signIn) {
			return { kind: "interactive", dialog: true, childFrame: true, driveLocation, browserControl };
		}
		await delay(200);
	}
	const flags = `d${Number(last.dialog)}c${Number(last.childContext)}p${Number(last.pickerContext)}t${Number(last.bodyNonEmpty)}g${Number(last.googleError)}s${Number(last.signIn)}l${Number(last.driveLocation)}b${Number(last.browserControl)}k${Number(last.developerKeyInvalid)}`;
	throw new FirefoxPickerError(
		"picker",
		mode === "invalid-key" ? `invalid-key-not-observed-${flags}` : `interactive-timeout-${flags}`,
	);
}

async function observe(client, command) {
	const tree = await client.send("browsingContext.getTree", { maxDepth: 0 });
	const context = tree.contexts?.[0]?.context;
	if (!context) throw new FirefoxPickerError("identity", "missing-firefox-context");
	await client.send("script.addPreloadScript", {
		functionDeclaration: `() => Object.defineProperty(globalThis, "__airSyncPickerTokenPresent", {
			value: Boolean(new URLSearchParams(location.hash.replace(/^#/, "")).get("token")),
			configurable: false
		})`,
		contexts: [context],
	});
	await client.send("browsingContext.navigate", { context, url: command.url, wait: "complete" });
	await waitForHost(client, context);
	const tokenPresent = await evaluate(client, context, "globalThis.__airSyncPickerTokenPresent");
	if (typeof tokenPresent !== "boolean") throw new FirefoxPickerError("pre-scrub", "token-observation");
	if (command.mode === "token-empty") {
		const tokenEmpty = await tokenEmptyOracle(client, context);
		return { ok: false, stage: "pre-picker", error_class: tokenEmpty ? "token-empty" : "unexpected-page-error", token_present: tokenPresent, interactive: false };
	}
	if (!tokenPresent) throw new FirefoxPickerError("pre-picker", "token-empty");
	const picker = await credentialedOracle(client, context, command.mode);
	if (picker.kind === "invalid-key") {
		return { ok: false, stage: "picker-error", error_class: "developer-key-invalid", token_present: true, interactive: false };
	}
	return {
		ok: true,
		stage: "interactive-ready",
		error_class: null,
		token_present: true,
		interactive: true,
		signal: {
			dialog: picker.dialog,
			drive_location: picker.driveLocation,
			browser_control: picker.browserControl,
			child_frame: picker.childFrame,
		},
	};
}

async function cleanupRun(run) {
	if (run.cleaning) return run.cleaning;
	run.cleaning = (async () => {
		if (run.sessionId) {
			try { await webdriverRequest(run.port, "DELETE", `/session/${run.sessionId}`); } catch { /* already closed */ }
		}
		try { run.client?.close(); } catch { /* already closed */ }
		if (run.child?.pid) {
			try { process.kill(-run.child.pid, "SIGKILL"); } catch { try { run.child.kill("SIGKILL"); } catch { /* exited */ } }
		}
		activeRuns.delete(run);
	})();
	return run.cleaning;
}

async function cleanupGooglePickerFirefox() {
	await Promise.all([...activeRuns].map(cleanupRun));
}

async function runGooglePickerFirefox(command) {
	const firefoxPath = process.env.AIRSYNC_E2E_FIREFOX_PATH;
	const driverPath = process.env.AIRSYNC_E2E_GECKODRIVER_PATH;
	const profilePath = process.env.AIRSYNC_E2E_FIREFOX_PROFILE_DIR;
	if (!firefoxPath || !driverPath || !profilePath) {
		throw new Error("Missing Firefox E2E paths; run npm run e2e:setup:google-picker:firefox");
	}
	const port = await reservePort();
	const run = { child: null, client: null, sessionId: null, port, cleaning: null };
	const controller = new AbortController();
	const watchdog = setTimeout(() => controller.abort(), WATCHDOG_MS);
	try {
		run.child = spawn(driverPath, ["--host", "127.0.0.1", "--port", String(port), "--log", "fatal"], {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		run.child.stdout?.resume();
		run.child.stderr?.resume();
		activeRuns.add(run);
		await waitForDriver(port, run.child, controller.signal);
		const session = await webdriverRequest(port, "POST", "/session", {
			capabilities: {
				alwaysMatch: {
					browserName: "firefox",
					webSocketUrl: true,
					"moz:firefoxOptions": {
						binary: firefoxPath,
						args: ["-headless", "-profile", profilePath],
					},
				},
			},
		});
		run.sessionId = session.sessionId;
		if (session.capabilities?.browserName !== "firefox" || !session.capabilities?.webSocketUrl) {
			throw new FirefoxPickerError("identity", "not-firefox");
		}
		run.client = await BidiClient.connect(session.capabilities.webSocketUrl, controller.signal);
		return { ...(await observe(run.client, command)), firefox_identity: true };
	} catch (error) {
		if (error instanceof FirefoxPickerError) {
			const tokenPresent = error.stage === "picker" || error.stage === "picker-sdk";
			return { ok: false, stage: error.stage, error_class: error.errorClass, token_present: tokenPresent, interactive: false, firefox_identity: Boolean(run.sessionId) };
		}
		throw error;
	} finally {
		clearTimeout(watchdog);
		await cleanupRun(run);
	}
}

module.exports = { cleanupGooglePickerFirefox, runGooglePickerFirefox };
