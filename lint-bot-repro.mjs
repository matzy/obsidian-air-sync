const { spawnSync } = process.getBuiltinModule("node:child_process");
const { createHash } = process.getBuiltinModule("node:crypto");
const {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} = process.getBuiltinModule("node:fs");
const { createRequire } = process.getBuiltinModule("node:module");
const { tmpdir } = process.getBuiltinModule("node:os");
const { dirname, join, relative, resolve } = process.getBuiltinModule("node:path");
const { fileURLToPath } = process.getBuiltinModule("node:url");

import {
	UNSAFE_RULE_IDS,
	classifyLintBotContrast,
} from "./lint-bot-repro-classifier.mjs";

export const REPRO_TARGETS = [
	"src",
];

const DIRECT_RUNTIME_PACKAGES = ["obsidian", "fflate", "ignore", "js-md5", "node-diff3"];
const COMMON_PROJECT_FILES = [
	"package.json",
	"eslint.config.mts",
	"tsconfig.json",
	"manifest.json",
];
const EFFECTIVE_CONFIG_SENTINEL = "src/fs/dropbox/auth.ts";
const UNTYPED_FIXTURE = "test-fixtures/lint-bot-repro/untyped-dependencies.d.ts";

function hashFile(filePath) {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function hashTree(root) {
	const hash = createHash("sha256");
	function visit(directory) {
		const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
			left.name.localeCompare(right.name),
		);
		for (const entry of entries) {
			const absolutePath = join(directory, entry.name);
			const relativePath = relative(root, absolutePath).replaceAll("\\", "/");
			if (entry.isSymbolicLink()) {
				throw new Error(`repro source copy must not contain symlinks: ${relativePath}`);
			}
			hash.update(relativePath);
			if (entry.isDirectory()) visit(absolutePath);
			else if (entry.isFile()) hash.update(readFileSync(absolutePath));
			else throw new Error(`unsupported source entry in repro copy: ${relativePath}`);
		}
	}
	visit(root);
	return hash.digest("hex");
}

function copyCommonProject(projectRoot, workspace) {
	for (const file of COMMON_PROJECT_FILES) {
		cpSync(join(projectRoot, file), join(workspace, file));
	}
	cpSync(join(projectRoot, "src"), join(workspace, "src"), { recursive: true });
	if (lstatSync(join(workspace, "src")).isSymbolicLink()) {
		throw new Error("repro source must be copied, not symlinked");
	}
	symlinkSync(join(projectRoot, "node_modules"), join(workspace, "node_modules"), "dir");
}

function injectUntypedBoundary(projectRoot, workspace) {
	const fixtureDestination = join(workspace, UNTYPED_FIXTURE);
	mkdirSync(dirname(fixtureDestination), { recursive: true });
	cpSync(join(projectRoot, UNTYPED_FIXTURE), fixtureDestination);

	const tsconfigPath = join(workspace, "tsconfig.json");
	const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
	tsconfig.compilerOptions.paths = {};
	for (const packageName of DIRECT_RUNTIME_PACKAGES) {
		tsconfig.compilerOptions.paths[packageName] = [
			"./test-fixtures/lint-bot-repro/untyped-dependencies.d.ts",
		];
	}
	writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, "\t")}\n`);
}

function workspaceDescriptor(workspace) {
	return {
		sourceHash: hashTree(join(workspace, "src")),
		configHash: hashFile(join(workspace, "eslint.config.mts")),
		manifestHash: hashFile(join(workspace, "manifest.json")),
		packageHash: hashFile(join(workspace, "package.json")),
		tsconfig: JSON.parse(readFileSync(join(workspace, "tsconfig.json"), "utf8")),
		targets: [...REPRO_TARGETS],
	};
}

function assertWorkspaceContract(normalWorkspace, injectedWorkspace) {
	const normal = workspaceDescriptor(normalWorkspace);
	const injected = workspaceDescriptor(injectedWorkspace);
	for (const key of ["sourceHash", "configHash", "manifestHash", "packageHash"]) {
		if (normal[key] !== injected[key]) {
			throw new Error(`normal/injected workspace mismatch outside type boundary: ${key}`);
		}
	}
	if (JSON.stringify(normal.targets) !== JSON.stringify(injected.targets)) {
		throw new Error("normal/injected workspace target lists differ");
	}

	const expectedInjectedTsconfig = structuredClone(normal.tsconfig);
	expectedInjectedTsconfig.compilerOptions.paths = {};
	for (const packageName of DIRECT_RUNTIME_PACKAGES) {
		expectedInjectedTsconfig.compilerOptions.paths[packageName] = [
			"./test-fixtures/lint-bot-repro/untyped-dependencies.d.ts",
		];
	}
	if (JSON.stringify(injected.tsconfig) !== JSON.stringify(expectedInjectedTsconfig)) {
		throw new Error(
			"injected workspace may differ only by the five untyped dependency paths",
		);
	}
	if (!existsSync(join(injectedWorkspace, UNTYPED_FIXTURE))) {
		throw new Error(`injected workspace is missing ${UNTYPED_FIXTURE}`);
	}

	return {
		sourceHash: normal.sourceHash,
		configHash: normal.configHash,
		targetCount: normal.targets.length,
	};
}

function resolveLocalEslintBinary(projectRoot) {
	const binaryPath = join(projectRoot, "node_modules", ".bin", "eslint");
	if (!existsSync(binaryPath)) {
		throw new Error(
			`project-local ESLint is missing at ${binaryPath}; run npm ci outside this offline gate, then retry (no download fallback is permitted)`,
		);
	}
	return binaryPath;
}

function severityOf(ruleSetting) {
	const severity = Array.isArray(ruleSetting) ? ruleSetting[0] : ruleSetting;
	if (severity === 2 || severity === "error") return "error";
	if (severity === 1 || severity === "warn") return "warn";
	return "off";
}

function loadLocalEslintApi(projectRoot) {
	try {
		const requireFromProject = createRequire(join(projectRoot, "package.json"));
		const eslintModule = requireFromProject("eslint");
		if (typeof eslintModule.ESLint !== "function") {
			throw new TypeError("the local eslint package does not export ESLint");
		}
		return eslintModule.ESLint;
	} catch (error) {
		throw new Error(
			`project-local ESLint API could not be loaded from ${join(projectRoot, "node_modules")}: ${error.message}`,
			{ cause: error },
		);
	}
}

function loadProjectPackage(projectRoot, packageName) {
	try {
		const requireFromProject = createRequire(join(projectRoot, "package.json"));
		return requireFromProject(packageName);
	} catch (error) {
		throw new Error(
			`project-local ${packageName} API could not be loaded from ${join(projectRoot, "node_modules")}: ${error.message}`,
			{ cause: error },
		);
	}
}

function assertTypeResolution(projectRoot, workspace, injected) {
	const ts = loadProjectPackage(projectRoot, "typescript");
	const configPath = join(workspace, "tsconfig.json");
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
	if (configFile.error) {
		throw new Error(`TypeScript could not read ${configPath}`);
	}
	const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, workspace);
	if (parsed.errors.length > 0) {
		throw new Error(`TypeScript could not parse ${configPath}`);
	}
	const resolutions = {};
	for (const packageName of DIRECT_RUNTIME_PACKAGES) {
		const resolvedModule = ts.resolveModuleName(
			packageName,
			join(workspace, "src", "main.ts"),
			parsed.options,
			ts.sys,
		).resolvedModule;
		if (!resolvedModule) {
			throw new Error(`TypeScript did not resolve ${packageName} in the repro workspace`);
		}
		const actualPath = resolve(resolvedModule.resolvedFileName);
		if (injected) {
			const expectedPath = resolve(join(workspace, UNTYPED_FIXTURE));
			if (actualPath !== expectedPath) {
				throw new Error(
					`TypeScript resolved ${packageName} to ${actualPath}; expected pre-fix fixture ${expectedPath}`,
				);
			}
		} else if (!actualPath.includes(`/node_modules/${packageName}/`)) {
			throw new Error(
				`TypeScript resolved ${packageName} to ${actualPath}; expected installed dependency declarations`,
			);
		}
		resolutions[packageName] = relative(workspace, actualPath).replaceAll("\\", "/");
	}
	return resolutions;
}

async function assertRuntimeBundleResolution(projectRoot) {
	const esbuild = loadProjectPackage(projectRoot, "esbuild");
	const result = await esbuild.build({
		stdin: {
			contents: [
				'import * as fflate from "fflate";',
				'import ignore from "ignore";',
				'import md5 from "js-md5";',
				'import * as diff3 from "node-diff3";',
				"globalThis.__airSyncRuntimeResolution = [fflate, ignore, md5, diff3];",
			].join("\n"),
			loader: "ts",
			resolveDir: projectRoot,
			sourcefile: "runtime-resolution.ts",
		},
		bundle: true,
		format: "esm",
		metafile: true,
		platform: "browser",
		tsconfig: join(projectRoot, "tsconfig.json"),
		write: false,
	});
	const inputs = Object.keys(result.metafile.inputs).map((input) => input.replaceAll("\\", "/"));
	for (const packageName of ["fflate", "ignore", "js-md5", "node-diff3"]) {
		if (!inputs.some((input) => input.includes(`node_modules/${packageName}/`))) {
			throw new Error(`esbuild bundle does not contain the runtime implementation for ${packageName}`);
		}
	}
	return inputs.filter((input) => input.includes("node_modules/"));
}

async function assertEffectiveConfig(projectRoot, normalWorkspace, injectedWorkspace) {
	const ESLint = loadLocalEslintApi(projectRoot);
	const configurations = [];
	for (const workspace of [normalWorkspace, injectedWorkspace]) {
		const eslint = new ESLint({
			cwd: workspace,
			overrideConfigFile: join(workspace, "eslint.config.mts"),
		});
		const config = await eslint.calculateConfigForFile(join(workspace, EFFECTIVE_CONFIG_SENTINEL));
		if (!config) {
			throw new Error(`ESLint returned no effective config for ${EFFECTIVE_CONFIG_SENTINEL}`);
		}
		const ruleSettings = Object.fromEntries(
			UNSAFE_RULE_IDS.map((ruleId) => [ruleId, config.rules?.[ruleId]]),
		);
		for (const [ruleId, setting] of Object.entries(ruleSettings)) {
			if (severityOf(setting) !== "error") {
				throw new Error(
					`effective config must keep ${ruleId} at error for ${EFFECTIVE_CONFIG_SENTINEL}`,
				);
			}
		}
		configurations.push(ruleSettings);
	}
	if (JSON.stringify(configurations[0]) !== JSON.stringify(configurations[1])) {
		throw new Error("normal/injected effective configs differ for the five unsafe rules");
	}
}

function runEslint(binaryPath, workspace, spawn) {
	const result = spawn(binaryPath, ["--format", "json", ...REPRO_TARGETS], {
		cwd: workspace,
		encoding: "utf8",
		env: { ...process.env, ESLINT_USE_FLAT_CONFIG: "true" },
	});
	if (result.error) {
		throw new Error(`failed to start project-local ESLint at ${binaryPath}: ${result.error.message}`);
	}
	if (typeof result.stdout !== "string") {
		throw new Error(`project-local ESLint at ${binaryPath} returned no JSON stdout`);
	}
	if (result.status !== 0 && result.status !== 1 && result.stderr) {
		throw new Error(
			`project-local ESLint failed as a tool (exit ${String(result.status)}): ${result.stderr.trim()}`,
		);
	}
	return { exitStatus: result.status, eslintJson: result.stdout };
}

export async function runLintBotReproduction({
	projectRoot = process.cwd(),
	spawn = spawnSync,
	verifyEffectiveConfig = assertEffectiveConfig,
	verifyResolution = assertTypeResolution,
	verifyRuntimeBundle = assertRuntimeBundleResolution,
	onWorkspaceCreated = () => {},
	onLintResults = () => {},
} = {}) {
	const tempRoot = mkdtempSync(join(tmpdir(), "airsync-bot-lint-"));
	onWorkspaceCreated(tempRoot);
	try {
		const binaryPath = resolveLocalEslintBinary(projectRoot);
		const runtimeBundleInputs = await verifyRuntimeBundle(projectRoot);
		const normalWorkspace = join(tempRoot, "normal");
		const injectedWorkspace = join(tempRoot, "injected");
		mkdirSync(normalWorkspace);
		mkdirSync(injectedWorkspace);
		copyCommonProject(projectRoot, normalWorkspace);
		copyCommonProject(projectRoot, injectedWorkspace);
		injectUntypedBoundary(projectRoot, injectedWorkspace);
		const descriptor = assertWorkspaceContract(normalWorkspace, injectedWorkspace);
		const normalResolutions = verifyResolution(projectRoot, normalWorkspace, false);
		const injectedResolutions = verifyResolution(projectRoot, injectedWorkspace, true);
		await verifyEffectiveConfig(projectRoot, normalWorkspace, injectedWorkspace);

		const normal = runEslint(binaryPath, normalWorkspace, spawn);
		const injected = runEslint(binaryPath, injectedWorkspace, spawn);
		onLintResults({ normal, injected });
		const classification = classifyLintBotContrast({ normal, injected });
		if (!classification.ok) {
			throw new Error(`${classification.code}: ${classification.message}`);
		}
		return {
			classification,
			descriptor,
			normalResolutions,
			injectedResolutions,
			runtimeBundleInputs,
		};
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const result = await runLintBotReproduction();
		process.stdout.write(
			`${result.classification.message}; TypeScript resolved 5/5 dependencies from the clean install; esbuild bundled 4/4 runtime implementations; source/config hashes matched\n`,
		);
	} catch (error) {
		process.stderr.write(`lint-bot repro failed: ${error.message}\n`);
		process.exitCode = 1;
	}
}
