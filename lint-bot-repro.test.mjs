const assert = process.getBuiltinModule("node:assert/strict");
const { existsSync, lstatSync, mkdtempSync, rmSync } = process.getBuiltinModule("node:fs");
const test = process.getBuiltinModule("node:test");
const { join } = process.getBuiltinModule("node:path");

import { UNSAFE_RULE_IDS, classifyLintBotContrast } from "./lint-bot-repro-classifier.mjs";
import { REPRO_ESLINT_ARGS, runLintBotReproduction } from "./lint-bot-repro.mjs";

function cleanJson(filePath = "src/main.ts") {
	return JSON.stringify([{ filePath, messages: [], errorCount: 0, warningCount: 0 }]);
}

function result(exitStatus = 0, eslintJson = cleanJson()) {
	return { exitStatus, eslintJson };
}

function validContrast(overrides = {}) {
	return { normal: result(), injected: result(), ...overrides };
}

test("accepts zero unsafe diagnostics on both dependency boundaries", () => {
	assert.deepEqual(classifyLintBotContrast(validContrast()), {
		ok: true,
		code: "fix-confirmed",
		message: "fix confirmed: current candidate has 0 unsafe diagnostics with installed and unavailable dependency declarations",
	});
});

for (const [name, input, code] of [
	["malformed normal JSON", validContrast({ normal: result(0, "{") }), "normal-json-malformed"],
	["malformed injected JSON", validContrast({ injected: result(0, "{") }), "injected-json-malformed"],
	["empty normal JSON", validContrast({ normal: result(0, "[]") }), "normal-json-empty"],
	["empty injected JSON", validContrast({ injected: result(0, "[]") }), "injected-json-empty"],
	["normal lint failure", validContrast({ normal: result(1) }), "normal-exit-status"],
	["injected lint failure", validContrast({ injected: result(1) }), "injected-exit-status"],
]) {
	test(`rejects ${name}`, () => {
		const classified = classifyLintBotContrast(input);
		assert.equal(classified.ok, false);
		assert.equal(classified.code, code);
	});
}

for (const side of ["normal", "injected"]) {
	for (const ruleId of UNSAFE_RULE_IDS) {
		test(`rejects ${side} ${ruleId}`, () => {
			const eslintJson = JSON.stringify([{
				filePath: "src/main.ts",
				messages: [{ ruleId, severity: 2, message: "unsafe", line: 1, column: 1 }],
				errorCount: 1,
				warningCount: 0,
			}]);
			const classified = classifyLintBotContrast(validContrast({ [side]: result(0, eslintJson) }));
			assert.equal(classified.ok, false);
			assert.equal(classified.code, `${side}-unsafe-findings`);
		});
	}
}

test("missing local ESLint fails before spawn and cleans its temp workspace", async () => {
	const missingRoot = mkdtempSync(join("/tmp", "airsync-missing-eslint-"));
	const createdWorkspaces = [];
	let spawnCount = 0;
	try {
		await assert.rejects(runLintBotReproduction({
			projectRoot: missingRoot,
			spawn: () => { spawnCount += 1; throw new Error("spawn must not be called"); },
			onWorkspaceCreated: (workspace) => createdWorkspaces.push(workspace),
		}), new RegExp(`${missingRoot}/node_modules/\\.bin/eslint.*no download fallback`, "s"));
		assert.equal(spawnCount, 0);
		assert.equal(createdWorkspaces.length, 1);
		assert.equal(existsSync(createdWorkspaces[0]), false);
	} finally {
		rmSync(missingRoot, { recursive: true, force: true });
	}
});

test("success uses only the project-local binary, copied source, and cleans up", async () => {
	const projectRoot = process.cwd();
	const expectedBinary = join(projectRoot, "node_modules", ".bin", "eslint");
	const createdWorkspaces = [];
	const spawnCalls = [];
	let effectiveConfigChecks = 0;
	let resolutionChecks = 0;
	let runtimeBundleChecks = 0;

	const reproduction = await runLintBotReproduction({
		projectRoot,
		onWorkspaceCreated: (workspace) => createdWorkspaces.push(workspace),
		verifyEffectiveConfig: async (_root, normalWorkspace, injectedWorkspace) => {
			effectiveConfigChecks += 1;
			assert.equal(lstatSync(join(normalWorkspace, "src")).isSymbolicLink(), false);
			assert.equal(lstatSync(join(injectedWorkspace, "src")).isSymbolicLink(), false);
		},
		verifyResolution: () => { resolutionChecks += 1; return {}; },
		verifyRuntimeBundle: () => { runtimeBundleChecks += 1; return []; },
		spawn: (binary, args, options) => {
			spawnCalls.push({ binary, args, cwd: options.cwd });
			return { status: 0, stdout: cleanJson(join(options.cwd, "src/main.ts")), stderr: "" };
		},
	});

	assert.equal(reproduction.classification.ok, true);
	assert.equal(reproduction.descriptor.targetCount, 1);
	assert.equal(effectiveConfigChecks, 1);
	assert.equal(resolutionChecks, 2);
	assert.equal(runtimeBundleChecks, 1);
	assert.equal(spawnCalls.length, 2);
	for (const call of spawnCalls) {
		assert.equal(call.binary, expectedBinary);
		assert.deepEqual(call.args, REPRO_ESLINT_ARGS);
		assert.doesNotMatch(`${call.binary} ${call.args.join(" ")}`, /npm|npx|install|latest|https?:/i);
	}
	assert.equal(createdWorkspaces.length, 1);
	assert.equal(existsSync(createdWorkspaces[0]), false);
});
