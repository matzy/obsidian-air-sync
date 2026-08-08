import * as md5Runtime from "js-md5";

const runtimeValue: unknown = md5Runtime;

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
	return typeof value === "function";
}

export function md5(data: ArrayBuffer): string {
	if (typeof runtimeValue !== "object" || runtimeValue === null) {
		throw new Error("js-md5 runtime module is unavailable");
	}
	const candidate: unknown = (runtimeValue as Record<string, unknown>).md5;
	if (!isCallable(candidate)) throw new Error("js-md5 export is unavailable");
	const result = candidate(data);
	if (typeof result === "string") return result;
	throw new Error("js-md5 returned a non-string result");
}
