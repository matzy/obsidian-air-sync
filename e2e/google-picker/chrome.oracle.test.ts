import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { cleanupOwnedProcess } from "./chrome";

describe("owned Chrome process cleanup", () => {
	it("terminates the whole owned process group on a failure path", async () => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
			detached: true,
			stdio: "ignore",
		});
		expect(child.pid).toBeTypeOf("number");
		await cleanupOwnedProcess(child);
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		expect(() => process.kill(child.pid!, 0)).toThrow();
	});
});
