const assert = process.getBuiltinModule("node:assert/strict");
const { existsSync, lstatSync, mkdtempSync, rmSync } = process.getBuiltinModule("node:fs");
const test = process.getBuiltinModule("node:test");
const { join } = process.getBuiltinModule("node:path");

import {
	MINIMUM_INJECTED_UNSAFE_FINDINGS,
	REQUIRED_FILE_RULE_PAIRS,
	UNSAFE_RULE_IDS,
	classifyLintBotContrast,
} from "./lint-bot-repro-classifier.mjs";
import {
	REPRO_TARGETS,
	runLintBotReproduction,
	verifyVendorSnapshots,
} from "./lint-bot-repro.mjs";

function eslintJson(messages) {
	const byFile = new Map();
	for (const message of messages) {
		const messagesForFile = byFile.get(message.filePath) ?? [];
		messagesForFile.push({
			ruleId: message.ruleId,
			severity: 2,
			message: "fixture diagnostic",
			line: 1,
			column: 1,
		});
		byFile.set(message.filePath, messagesForFile);
	}

	return JSON.stringify(
		[...byFile].map(([filePath, fileMessages]) => ({
			filePath,
			messages: fileMessages,
			errorCount: fileMessages.length,
			warningCount: 0,
		})),
	);
}

function positiveInjectedMessages() {
	const messages = [
		...REQUIRED_FILE_RULE_PAIRS.map(([filePath, ruleId]) => ({ filePath, ruleId })),
		...UNSAFE_RULE_IDS.map((ruleId, index) => ({
			filePath: `src/extra-${index}.ts`,
			ruleId,
		})),
	];
	while (messages.length < MINIMUM_INJECTED_UNSAFE_FINDINGS) {
		messages.push({
			filePath: "src/padded-cascade.ts",
			ruleId: "@typescript-eslint/no-unsafe-assignment",
		});
	}
	return messages;
}

function validContrast(overrides = {}) {
	return {
		normal: {
			exitStatus: 0,
			eslintJson: JSON.stringify([
				{
					filePath: "src/fs/dropbox/auth.ts",
					messages: [],
					errorCount: 0,
					warningCount: 0,
				},
			]),
		},
		injected: {
			exitStatus: 1,
			eslintJson: eslintJson(positiveInjectedMessages()),
		},
		...overrides,
	};
}

test("accepts the valid normal/injected contrast", () => {
	assert.deepEqual(classifyLintBotContrast(validContrast()), {
		ok: true,
		code: "contrast-confirmed",
		message: `contrast confirmed: ${MINIMUM_INJECTED_UNSAFE_FINDINGS} injected unsafe diagnostics`,
	});
});

const fixedNegativeCases = [
	{
		name: "malformed normal JSON",
		input: validContrast({ normal: { exitStatus: 0, eslintJson: "{" } }),
		code: "normal-json-malformed",
	},
	{
		name: "malformed injected JSON",
		input: validContrast({ injected: { exitStatus: 1, eslintJson: "{" } }),
		code: "injected-json-malformed",
	},
	{
		name: "empty normal result",
		input: validContrast({ normal: { exitStatus: 0, eslintJson: "[]" } }),
		code: "normal-json-empty",
	},
	{
		name: "empty injected result",
		input: validContrast({ injected: { exitStatus: 1, eslintJson: "[]" } }),
		code: "injected-json-empty",
	},
	{
		name: "normal unsafe diagnostic",
		input: validContrast({
			normal: {
				exitStatus: 0,
				eslintJson: eslintJson([
					{
						filePath: "src/fs/dropbox/auth.ts",
						ruleId: UNSAFE_RULE_IDS[0],
					},
				]),
			},
		}),
		code: "normal-unsafe-findings",
	},
	{
		name: "normal non-zero exit",
		input: validContrast({
			normal: { exitStatus: 1, eslintJson: validContrast().normal.eslintJson },
		}),
		code: "normal-exit-status",
	},
	...[
		["zero", 0],
		["tool failure", 2],
		["signal or spawn failure", null],
	].map(([label, exitStatus]) => ({
		name: `injected ${label} exit`,
		input: validContrast({
			injected: {
				exitStatus,
				eslintJson: validContrast().injected.eslintJson,
			},
		}),
		code: "injected-exit-status",
	})),
];

fixedNegativeCases.push({
	name: "small injected cascade that merely contains the sentinels",
	input: validContrast({
		injected: {
			exitStatus: 1,
			eslintJson: eslintJson([
				...REQUIRED_FILE_RULE_PAIRS.map(([filePath, ruleId]) => ({ filePath, ruleId })),
				...UNSAFE_RULE_IDS.map((ruleId, index) => ({
					filePath: `src/small-${index}.ts`,
					ruleId,
				})),
			]),
		},
	}),
	code: "injected-cascade-too-small",
});

for (const { name, input, code } of fixedNegativeCases) {
	test(`rejects ${name}`, () => {
		// Counterexample rejection: an always-success classifier fails every row.
		const result = classifyLintBotContrast(input);
		assert.equal(result.ok, false);
		assert.equal(result.code, code);
	});
}

for (const missingRuleId of UNSAFE_RULE_IDS) {
	test(`rejects a missing family: ${missingRuleId}`, () => {
		const messages = positiveInjectedMessages().filter(
			(message) => message.ruleId !== missingRuleId,
		);
		const result = classifyLintBotContrast(
			validContrast({
				injected: { exitStatus: 1, eslintJson: eslintJson(messages) },
			}),
		);
		assert.equal(result.ok, false);
		assert.equal(result.code, "injected-rule-family-missing");
		assert.match(result.message, new RegExp(missingRuleId.replaceAll("/", "\\/")));
	});
}

for (const [missingFilePath, missingRuleId] of REQUIRED_FILE_RULE_PAIRS) {
	test(`rejects a missing pair: ${missingFilePath} x ${missingRuleId}`, () => {
		const messages = positiveInjectedMessages().filter(
			(message) =>
				message.filePath !== missingFilePath || message.ruleId !== missingRuleId,
		);
		const result = classifyLintBotContrast(
			validContrast({
				injected: { exitStatus: 1, eslintJson: eslintJson(messages) },
			}),
		);
		assert.equal(result.ok, false);
		assert.equal(result.code, "injected-file-rule-pair-missing");
		assert.match(result.message, new RegExp(missingFilePath.replaceAll("/", "\\/")));
	});
}

test("missing local ESLint fails before spawn and cleans its temp workspace", async () => {
	const missingRoot = mkdtempSync(join("/tmp", "airsync-missing-eslint-"));
	const createdWorkspaces = [];
	let spawnCount = 0;
	try {
		await assert.rejects(
			runLintBotReproduction({
				projectRoot: missingRoot,
				spawn: () => {
					spawnCount += 1;
					throw new Error("spawn must not be called");
				},
				onWorkspaceCreated: (workspace) => createdWorkspaces.push(workspace),
			}),
			new RegExp(`${missingRoot}/node_modules/\\.bin/eslint.*no download fallback`, "s"),
		);
		assert.equal(spawnCount, 0);
		assert.equal(createdWorkspaces.length, 1);
		assert.equal(existsSync(createdWorkspaces[0]), false);
	} finally {
		rmSync(missingRoot, { recursive: true, force: true });
	}
});

test("official declaration snapshots match versions, licenses, lock integrity, and bytes", () => {
	assert.deepEqual(verifyVendorSnapshots(process.cwd()), {
		packageCount: 9,
		shimCount: 0,
		message:
			"9 official declaration/license snapshots match installed packages and lockfile metadata byte-for-byte; 0 handwritten shims",
	});
});

test("success uses only the project-local binary, copied source, and cleans up", async () => {
	const projectRoot = process.cwd();
	const expectedBinary = join(projectRoot, "node_modules", ".bin", "eslint");
	const createdWorkspaces = [];
	const spawnCalls = [];
	let effectiveConfigChecks = 0;
	let snapshotChecks = 0;
	let resolutionChecks = 0;
	let runtimeBundleChecks = 0;

	const result = await runLintBotReproduction({
		projectRoot,
		onWorkspaceCreated: (workspace) => createdWorkspaces.push(workspace),
		verifyEffectiveConfig: async (_root, normalWorkspace, injectedWorkspace) => {
			effectiveConfigChecks += 1;
			assert.equal(lstatSync(join(normalWorkspace, "src")).isSymbolicLink(), false);
			assert.equal(lstatSync(join(injectedWorkspace, "src")).isSymbolicLink(), false);
		},
		verifySnapshots: () => {
			snapshotChecks += 1;
			return { message: "snapshot test double" };
		},
		verifyResolution: () => {
			resolutionChecks += 1;
			return {};
		},
		verifyRuntimeBundle: () => {
			runtimeBundleChecks += 1;
			return [];
		},
		spawn: (binary, args, options) => {
			spawnCalls.push({ binary, args, cwd: options.cwd });
			const isInjected = options.cwd.endsWith("/injected");
			const messages = isInjected ? positiveInjectedMessages() : [];
			const output = isInjected
				? eslintJson(messages)
				: JSON.stringify(
						REPRO_TARGETS.map((filePath) => ({
							filePath: join(options.cwd, filePath),
							messages: [],
							errorCount: 0,
							warningCount: 0,
						})),
					);
			return {
				status: isInjected ? 1 : 0,
				stdout: output,
				stderr: "",
			};
		},
	});

	assert.equal(result.classification.ok, true);
	assert.equal(result.descriptor.targetCount, 1);
	assert.equal(effectiveConfigChecks, 1);
	assert.equal(snapshotChecks, 1);
	assert.equal(resolutionChecks, 2);
	assert.equal(runtimeBundleChecks, 1);
	assert.equal(spawnCalls.length, 2);
	for (const call of spawnCalls) {
		assert.equal(call.binary, expectedBinary);
		assert.deepEqual(call.args, ["--format", "json", ...REPRO_TARGETS]);
		assert.doesNotMatch(`${call.binary} ${call.args.join(" ")}`, /npm|npx|install|latest|https?:/i);
	}
	assert.equal(createdWorkspaces.length, 1);
	assert.equal(existsSync(createdWorkspaces[0]), false);
});
