import * as ignoreRuntime from "ignore";

const runtimeValue: unknown = ignoreRuntime;

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
	return typeof value === "function";
}

interface IgnoreMatcher {
	add(patterns: string[]): IgnoreMatcher;
	ignores(path: string): boolean;
}

function isMatcher(value: unknown): value is IgnoreMatcher {
	return typeof value === "object" && value !== null
		&& "add" in value && typeof value.add === "function"
		&& "ignores" in value && typeof value.ignores === "function";
}

export function isIgnoredByPatterns(path: string, patterns: string[]): boolean {
	if (typeof runtimeValue !== "object" || runtimeValue === null) {
		throw new Error("ignore runtime module is unavailable");
	}
	const record = runtimeValue as Record<string, unknown>;
	const candidate = record.default ?? record;
	if (!isCallable(candidate)) throw new Error("ignore factory is unavailable");
	const matcher = candidate();
	if (!isMatcher(matcher)) throw new Error("ignore factory returned an invalid matcher");
	return matcher.add(patterns).ignores(path);
}
