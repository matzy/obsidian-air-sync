import * as fflateRuntime from "fflate";

const runtimeValue: unknown = fflateRuntime;

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
	return typeof value === "function";
}

function codec(name: "deflateSync" | "inflateSync", data: Uint8Array): Uint8Array<ArrayBuffer> {
	if (typeof runtimeValue !== "object" || runtimeValue === null) {
		throw new Error("fflate runtime module is unavailable");
	}
	const candidate: unknown = (runtimeValue as Record<string, unknown>)[name];
	if (!isCallable(candidate)) throw new Error(`fflate ${name} is unavailable`);
	const result = candidate(data);
	if (result instanceof Uint8Array) return Uint8Array.from(result);
	throw new Error(`fflate ${name} returned a non-Uint8Array result`);
}

export function deflateSync(data: Uint8Array): Uint8Array<ArrayBuffer> {
	return codec("deflateSync", data);
}

export function inflateSync(data: Uint8Array): Uint8Array<ArrayBuffer> {
	return codec("inflateSync", data);
}
