export const UNSAFE_RULE_IDS = [
	"@typescript-eslint/no-unsafe-assignment",
	"@typescript-eslint/no-unsafe-call",
	"@typescript-eslint/no-unsafe-member-access",
	"@typescript-eslint/no-unsafe-argument",
	"@typescript-eslint/no-unsafe-return",
];

function failure(code, message) {
	return { ok: false, code, message };
}

function parseResults(side, eslintJson) {
	let parsed;
	try {
		parsed = JSON.parse(eslintJson);
	} catch (error) {
		return { failure: failure(`${side}-json-malformed`, `${side} ESLint output is not valid JSON: ${error.message}`) };
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		return { failure: failure(`${side}-json-empty`, `${side} ESLint output must contain at least one file result`) };
	}
	const findings = [];
	for (const result of parsed) {
		if (typeof result !== "object" || result === null || typeof result.filePath !== "string" || !Array.isArray(result.messages)) {
			return { failure: failure(`${side}-json-malformed`, `${side} ESLint output contains an invalid file result`) };
		}
		for (const message of result.messages) {
			if (typeof message?.ruleId === "string") findings.push({ filePath: result.filePath, ruleId: message.ruleId });
		}
	}
	return { findings };
}

export function classifyLintBotContrast({ normal, runtimeUntyped, vitestUntyped }) {
	for (const [side, result] of [
		["normal", normal],
		["runtime-untyped", runtimeUntyped],
		["vitest-untyped", vitestUntyped],
	]) {
		const parsed = parseResults(side, result.eslintJson);
		if (parsed.failure) return parsed.failure;
		const unsafe = parsed.findings.filter(({ ruleId }) => UNSAFE_RULE_IDS.includes(ruleId));
		if (unsafe.length > 0) {
			return failure(`${side}-unsafe-findings`, `${side} declarations produced ${unsafe.length} unsafe diagnostic(s)`);
		}
		if (result.exitStatus !== 0) {
			return failure(`${side}-exit-status`, `${side} ESLint must exit 0, received ${String(result.exitStatus)}`);
		}
	}
	return {
		ok: true,
		code: "fix-confirmed",
		message: "fix confirmed: current candidate has 0 unsafe diagnostics with installed, runtime-untyped, and Vitest-untyped declarations",
	};
}
