import * as diff3Runtime from "node-diff3";

const runtimeValue: unknown = diff3Runtime;

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
	return typeof value === "function";
}

export interface DiffIndex {
	buffer1: [number, number];
	buffer2: [number, number];
	buffer1Content: string[];
	buffer2Content: string[];
}

export type Diff3Region =
	| { ok: string[]; conflict?: undefined }
	| { ok?: undefined; conflict: { a: string[]; aIndex: number; o: string[]; oIndex: number; b: string[]; bIndex: number } };

function call(name: "diffIndices" | "diff3Merge", args: unknown[]): unknown {
	if (typeof runtimeValue !== "object" || runtimeValue === null) {
		throw new Error("node-diff3 runtime module is unavailable");
	}
	const candidate: unknown = (runtimeValue as Record<string, unknown>)[name];
	if (!isCallable(candidate)) throw new Error(`node-diff3 ${name} is unavailable`);
	return candidate(...args);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPair(value: unknown): value is [number, number] {
	return Array.isArray(value) && value.length === 2
		&& typeof value[0] === "number" && typeof value[1] === "number";
}

export function diffIndices(a: string[], b: string[]): DiffIndex[] {
	const result = call("diffIndices", [a, b]);
	if (!Array.isArray(result)) throw new Error("node-diff3 diffIndices returned an invalid result");
	return result.map((item) => {
		if (typeof item !== "object" || item === null) throw new Error("node-diff3 returned an invalid diff");
		const record = item as Record<string, unknown>;
		if (!isPair(record.buffer1) || !isPair(record.buffer2)
			|| !isStringArray(record.buffer1Content) || !isStringArray(record.buffer2Content)) {
			throw new Error("node-diff3 returned an invalid diff");
		}
		return {
			buffer1: record.buffer1,
			buffer2: record.buffer2,
			buffer1Content: record.buffer1Content,
			buffer2Content: record.buffer2Content,
		};
	});
}

export function diff3Merge(a: string[], o: string[], b: string[]): Diff3Region[] {
	const result = call("diff3Merge", [a, o, b]);
	if (!Array.isArray(result)) throw new Error("node-diff3 diff3Merge returned an invalid result");
	return result.map((item) => {
		if (typeof item !== "object" || item === null) throw new Error("node-diff3 returned an invalid region");
		const record = item as Record<string, unknown>;
		if (isStringArray(record.ok)) return { ok: record.ok };
		const conflict = record.conflict;
		if (typeof conflict !== "object" || conflict === null) throw new Error("node-diff3 returned an invalid conflict");
		const value = conflict as Record<string, unknown>;
		if (!isStringArray(value.a) || !isStringArray(value.o) || !isStringArray(value.b)
			|| typeof value.aIndex !== "number" || typeof value.oIndex !== "number" || typeof value.bIndex !== "number") {
			throw new Error("node-diff3 returned an invalid conflict");
		}
		return { conflict: { a: value.a, aIndex: value.aIndex, o: value.o, oIndex: value.oIndex, b: value.b, bIndex: value.bIndex } };
	});
}
