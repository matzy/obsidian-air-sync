import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["e2e/google-picker/**/*.oracle.test.ts"],
		fileParallelism: false,
	},
});
