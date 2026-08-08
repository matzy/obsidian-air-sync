export const UNSAFE_RULE_IDS = [
	"@typescript-eslint/no-unsafe-assignment",
	"@typescript-eslint/no-unsafe-call",
	"@typescript-eslint/no-unsafe-member-access",
	"@typescript-eslint/no-unsafe-argument",
	"@typescript-eslint/no-unsafe-return",
];

export const REQUIRED_FILE_RULE_PAIRS = [
	["src/fs/dropbox/auth.ts", "@typescript-eslint/no-unsafe-assignment"],
	["src/fs/dropbox/client.ts", "@typescript-eslint/no-unsafe-argument"],
	["src/fs/googledrive/client.ts", "@typescript-eslint/no-unsafe-return"],
	["src/fs/local/index.ts", "@typescript-eslint/no-unsafe-member-access"],
	["src/ui/settings.ts", "@typescript-eslint/no-unsafe-call"],
];

function failure(code, message) {
	return { ok: false, code, message };
}

function parseResults(side, eslintJson) {
	let parsed;
	try {
		parsed = JSON.parse(eslintJson);
	} catch (error) {
		return {
			failure: failure(
				`${side}-json-malformed`,
				`${side} ESLint output is not valid JSON: ${error.message}`,
			),
		};
	}

	if (!Array.isArray(parsed) || parsed.length === 0) {
		return {
			failure: failure(
				`${side}-json-empty`,
				`${side} ESLint output must contain at least one file result`,
			),
		};
	}

	const findings = [];
	for (const result of parsed) {
		if (
			typeof result !== "object" ||
			result === null ||
			typeof result.filePath !== "string" ||
			!Array.isArray(result.messages)
		) {
			return {
				failure: failure(
					`${side}-json-malformed`,
					`${side} ESLint output contains an invalid file result`,
				),
			};
		}

		for (const message of result.messages) {
			if (typeof message?.ruleId === "string") {
				findings.push({
					filePath: result.filePath.replaceAll("\\", "/"),
					ruleId: message.ruleId,
				});
			}
		}
	}

	return { findings };
}

function hasFileRulePair(findings, expectedFilePath, expectedRuleId) {
	return findings.some(
		({ filePath, ruleId }) =>
			ruleId === expectedRuleId &&
			(filePath === expectedFilePath || filePath.endsWith(`/${expectedFilePath}`)),
	);
}

export function classifyLintBotContrast({ normal, injected }) {
	const normalResults = parseResults("normal", normal.eslintJson);
	if (normalResults.failure) return normalResults.failure;
	const injectedResults = parseResults("injected", injected.eslintJson);
	if (injectedResults.failure) return injectedResults.failure;

	if (normal.exitStatus !== 0) {
		return failure(
			"normal-exit-status",
			`normal ESLint must exit 0, received ${String(normal.exitStatus)}`,
		);
	}

	const normalUnsafe = normalResults.findings.filter(({ ruleId }) =>
		UNSAFE_RULE_IDS.includes(ruleId),
	);
	if (normalUnsafe.length > 0) {
		return failure(
			"normal-unsafe-findings",
			`normal declarations produced ${normalUnsafe.length} unsafe diagnostic(s)`,
		);
	}

	if (injected.exitStatus !== 1) {
		return failure(
			"injected-exit-status",
			`injected ESLint must exit exactly 1 for lint findings; received ${String(injected.exitStatus)}`,
		);
	}

	for (const ruleId of UNSAFE_RULE_IDS) {
		if (!injectedResults.findings.some((finding) => finding.ruleId === ruleId)) {
			return failure(
				"injected-rule-family-missing",
				`injected ESLint output is missing unsafe rule family ${ruleId}`,
			);
		}
	}

	for (const [filePath, ruleId] of REQUIRED_FILE_RULE_PAIRS) {
		if (!hasFileRulePair(injectedResults.findings, filePath, ruleId)) {
			return failure(
				"injected-file-rule-pair-missing",
				`injected ESLint output is missing required pair ${filePath} x ${ruleId}`,
			);
		}
	}

	const unsafeCount = injectedResults.findings.filter(({ ruleId }) =>
		UNSAFE_RULE_IDS.includes(ruleId),
	).length;
	return {
		ok: true,
		code: "contrast-confirmed",
		message: `contrast confirmed: ${unsafeCount} injected unsafe diagnostics`,
	};
}
