import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { resolve } from "node:path";
import {
	type NavigationEvidence,
	PickerE2EError,
	PRODUCTION_WORKER_ORIGIN,
	selectOrderedExternalNavigation,
} from "./oracle";
import type { PickerRuntime } from "./preflight";

interface CdpMessage {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	error?: unknown;
}

class CdpConnection {
	private readonly socket: WebSocket;
	private nextId = 1;
	private pending = new Map<number, { resolve: () => void; reject: () => void }>();
	private listeners = new Set<(message: CdpMessage) => void>();

	private constructor(socket: WebSocket) {
		this.socket = socket;
		socket.addEventListener("message", (event) => {
			let message: CdpMessage;
			try {
				message = JSON.parse(String(event.data)) as CdpMessage;
			} catch {
				return;
			}
			if (typeof message.id === "number") {
				const pending = this.pending.get(message.id);
				if (pending) {
					this.pending.delete(message.id);
					if (message.error) pending.reject();
					else pending.resolve();
				}
			}
			for (const listener of this.listeners) listener(message);
		});
	}

	static connect(url: string): Promise<CdpConnection> {
		return new Promise((resolveConnection, rejectConnection) => {
			const socket = new WebSocket(url);
			const fail = (): void => rejectConnection(new PickerE2EError("cdp-connect", "browser-launch"));
			socket.addEventListener("error", fail, { once: true });
			socket.addEventListener("open", () => resolveConnection(new CdpConnection(socket)), { once: true });
		});
	}

	send(method: string, params?: Record<string, unknown>): Promise<void> {
		const id = this.nextId++;
		return new Promise((resolveCommand, rejectCommand) => {
			this.pending.set(id, {
				resolve: resolveCommand,
				reject: () => rejectCommand(new PickerE2EError("cdp-command", "browser-launch")),
			});
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	onEvent(listener: (message: CdpMessage) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	close(): void {
		this.socket.close();
	}
}

interface PageTarget {
	id: string;
	type: string;
	url: string;
	webSocketDebuggerUrl: string;
}

function getJson<T>(port: number, path: string): Promise<T> {
	return new Promise((resolveJson, rejectJson) => {
		const request = http.get({ host: "127.0.0.1", port, path }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => { body += chunk; });
			response.on("end", () => {
				try {
					resolveJson(JSON.parse(body) as T);
				} catch {
					rejectJson(new PickerE2EError("cdp-discovery", "browser-launch"));
				}
			});
		});
		request.on("error", () => rejectJson(new PickerE2EError("cdp-discovery", "browser-launch")));
	});
}

function waitForDevToolsPort(profileDir: string, timeoutMs: number): Promise<number> {
	const activePortPath = resolve(profileDir, "DevToolsActivePort");
	return new Promise((resolvePort, rejectPort) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			watcher.close();
			callback();
		};
		const inspect = (): void => {
			void readFile(activePortPath, "utf8").then((contents) => {
				const port = Number(contents.split(/\r?\n/, 1)[0]);
				if (Number.isInteger(port) && port > 0) finish(() => resolvePort(port));
			}).catch(() => undefined);
		};
		const watcher = watch(profileDir, inspect);
		timer = setTimeout(() => finish(() => rejectPort(new PickerE2EError("devtools-port-timeout", "browser-launch"))), timeoutMs);
		inspect();
	});
}

function evidenceFromMessage(
	message: CdpMessage,
	sequence: number,
	targetId: string,
	sessionId: string,
): NavigationEvidence | undefined {
	const params = message.params ?? {};
	if (message.method === "Page.frameRequestedNavigation") {
		if (typeof params.url !== "string" || typeof params.frameId !== "string") return undefined;
		return { sequence, targetId, sessionId, frameId: params.frameId, url: params.url, source: message.method };
	}
	if (message.method === "Network.requestWillBeSent") {
		const request = params.request as Record<string, unknown> | undefined;
		if (!request || typeof request.url !== "string" || typeof params.frameId !== "string") return undefined;
		return {
			sequence,
			targetId,
			sessionId,
			frameId: params.frameId,
			loaderId: typeof params.loaderId === "string" ? params.loaderId : undefined,
			url: request.url,
			source: message.method,
		};
	}
	return undefined;
}

export interface ChromeProbeDependencies {
	spawnChrome?: typeof spawn;
}

export async function captureExternalNavigation(
	runtime: PickerRuntime,
	authorizationUrl: string,
	dependencies: ChromeProbeDependencies = {},
): Promise<NavigationEvidence> {
	const spawnChrome = dependencies.spawnChrome ?? spawn;
	let child: ChildProcess | undefined;
	let cdp: CdpConnection | undefined;
	let removeSignals: (() => void) | undefined;
	let captureTimer: ReturnType<typeof setTimeout> | undefined;
	let unsubscribeCapture: (() => void) | undefined;
	let rejectCapture: ((error: PickerE2EError) => void) | undefined;
	try {
		child = spawnChrome(runtime.executable, [
			`--user-data-dir=${runtime.chromeProfileDir}`,
			"--remote-debugging-port=0",
			"--no-first-run",
			"--no-default-browser-check",
			"about:blank",
		], { detached: true, stdio: "ignore" });
		if (!child.pid) throw new PickerE2EError("chrome-spawn", "browser-launch");
		const stop = (): void => {
			rejectCapture?.(new PickerE2EError("signal", "cleanup"));
			void cleanupOwnedProcess(child);
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		removeSignals = () => {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
		};

		const port = await waitForDevToolsPort(runtime.profileDir, Math.min(runtime.timeoutMs, 15_000));
		const targets = await getJson<PageTarget[]>(port, "/json/list");
		const target = targets.find((candidate) => candidate.type === "page" && candidate.url === "about:blank");
		if (!target) throw new PickerE2EError("cdp-target", "browser-launch");
		cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
		await cdp.send("Page.enable");
		await cdp.send("Network.enable");

		const sessionId = `page:${target.id}`;
		const events: NavigationEvidence[] = [];
		let sequence = 0;
		const captured = new Promise<NavigationEvidence>((resolveEvidence, rejectEvidence) => {
			rejectCapture = rejectEvidence;
			captureTimer = setTimeout(() => {
				rejectEvidence(new PickerE2EError(
					events.some((event) => event.url.startsWith(PRODUCTION_WORKER_ORIGIN))
						? "external-navigation-timeout"
						: "worker-navigation-timeout",
					events.some((event) => event.url.startsWith(PRODUCTION_WORKER_ORIGIN))
						? "external-navigation"
						: "worker-callback",
				));
			}, runtime.timeoutMs);
			unsubscribeCapture = cdp!.onEvent((message) => {
				const evidence = evidenceFromMessage(message, ++sequence, target.id, sessionId);
				if (!evidence) return;
				events.push(evidence);
				try {
					const selected = selectOrderedExternalNavigation(events);
					if (captureTimer) clearTimeout(captureTimer);
					unsubscribeCapture?.();
					resolveEvidence(selected);
				} catch {
					// An incomplete sequence is expected while the user finishes consent and selection.
				}
			});
		});
		await cdp.send("Page.navigate", { url: authorizationUrl });
		return await captured;
	} catch (error) {
		if (error instanceof PickerE2EError) throw error;
		throw new PickerE2EError("browser-probe", "browser-launch");
	} finally {
		if (captureTimer) clearTimeout(captureTimer);
		unsubscribeCapture?.();
		removeSignals?.();
		cdp?.close();
		await cleanupOwnedProcess(child);
	}
}

export async function cleanupOwnedProcess(child: ChildProcess | undefined): Promise<void> {
	if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		try { child.kill("SIGTERM"); } catch { /* already gone */ }
	}
	await new Promise<void>((resolveExit) => {
		const timer = setTimeout(() => {
			try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
			resolveExit();
		}, 2_000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolveExit();
		});
	});
}
