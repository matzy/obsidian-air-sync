import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const WHY_FIX = "Google Picker T3 isolation violation. WHY: the interactive real-browser flow must never enter default/aggregate/CI gates and retired PickerBuilder/API-key flows must stay deleted. FIX: invoke only e2e/vitest.google-picker-interactive.config.ts from test:e2e:google-picker and start only through GoogleAuth.getFolderPickerAuthorizationUrl.";

export function inspectPickerHarnessFixture(fixture) {
	const failures = [];
	const dedicatedConfig = "e2e/vitest.google-picker-interactive.config.ts";
	if (fixture.scripts.test?.includes("google-picker") || fixture.scripts["test:e2e"]?.includes("google-picker") || fixture.scripts["test:e2e:google"]?.includes("google-picker")) failures.push("default-or-aggregate-script");
	if (fixture.ci.includes("test:e2e:google-picker") || fixture.ci.includes(dedicatedConfig)) failures.push("ci-invocation");
	if (!fixture.dedicatedConfig.includes('include: ["e2e/google-picker/google-picker.interactive.ts"]')) failures.push("dedicated-include");
	if (fixture.aggregateConfig.includes("google-picker.interactive")) failures.push("aggregate-include");
	const forbidden = ["Picker" + "Builder", "googleapis.com/" + "picker", "PICKER_" + "API_KEY", "GOOGLE_" + "PICKER_API_KEY", "picker_" + "token"];
	if (forbidden.some((term) => fixture.executableSources.includes(term))) failures.push("retired-picker-surface");
	if (!fixture.entrySource.includes("getFolderPickerAuthorizationUrl()")) failures.push("production-url-bypass");
	return failures;
}

async function workflowText(repo) {
	const directory = resolve(repo, ".github/workflows");
	const files = await readdir(directory);
	return (await Promise.all(files.map((file) => readFile(resolve(directory, file), "utf8")))).join("\n");
}

async function realFixture() {
	const repo = process.cwd();
	const packageJson = JSON.parse(await readFile(resolve(repo, "package.json"), "utf8"));
	const executablePaths = ["e2e/google-picker/google-picker.interactive.ts", "e2e/google-picker/chrome.ts", "e2e/google-picker/preflight.ts", "e2e/vitest.google-picker-interactive.config.ts"];
	return {
		scripts: packageJson.scripts,
		ci: await workflowText(repo),
		dedicatedConfig: await readFile(resolve(repo, "e2e/vitest.google-picker-interactive.config.ts"), "utf8"),
		aggregateConfig: await readFile(resolve(repo, "e2e/vitest.e2e.config.ts"), "utf8"),
		executableSources: (await Promise.all(executablePaths.map((path) => readFile(resolve(repo, path), "utf8")))).join("\n"),
		entrySource: await readFile(resolve(repo, "e2e/google-picker/google-picker.interactive.ts"), "utf8"),
	};
}

test("interactive Google Picker remains isolated and uses only the production URL builder", async () => {
	const failures = inspectPickerHarnessFixture(await realFixture());
	assert.deepEqual(failures, [], `${WHY_FIX} Found: ${failures.join(", ")}`);
});

test("guard rejects aggregate, CI, retired Picker, API-key, token, and URL-builder bypass fixtures", () => {
	const good = {
		scripts: { test: "vitest run", "test:e2e": "vitest aggregate", "test:e2e:google": "vitest google" },
		ci: "npm test",
		dedicatedConfig: 'include: ["e2e/google-picker/google-picker.interactive.ts"]',
		aggregateConfig: 'include: ["e2e/**/*.e2e.ts"]',
		executableSources: "safe",
		entrySource: "auth.getFolderPickerAuthorizationUrl()",
	};
	assert.deepEqual(inspectPickerHarnessFixture(good), []);
	const cases = [
		{ scripts: { ...good.scripts, "test:e2e": "vitest google-picker" } },
		{ ci: "npm run test:e2e:google-picker" },
		{ aggregateConfig: "google-picker.interactive" },
		{ executableSources: "new PickerBuilder()" },
		{ executableSources: "PICKER_API_KEY" },
		{ executableSources: "picker_token" },
		{ entrySource: "direct URL" },
	];
	for (const changed of cases) assert.notDeepEqual(inspectPickerHarnessFixture({ ...good, ...changed }), [], WHY_FIX);
});
