import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["e2e/google-picker/google-picker.interactive.ts"],
		globalSetup: ["./e2e/electron-net-setup.ts"],
		testTimeout: 610_000,
		hookTimeout: 30_000,
		fileParallelism: false,
	},
	resolve: {
		alias: {
			obsidian: resolve(__dirname, "obsidian.shim.ts"),
		},
	},
});
