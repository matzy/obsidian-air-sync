import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidianRuntime from "obsidian";
import { requestUrl } from "./obsidian";

vi.mock("obsidian");

type RuntimeRequestUrl = (params: unknown) => Promise<unknown>;

function mockRuntimeResponse(response: Record<string, unknown>): void {
	vi.spyOn(
		obsidianRuntime as unknown as { requestUrl: RuntimeRequestUrl },
		"requestUrl",
	).mockResolvedValue(response);
}

function responseWithBodyViews(bodyViews: {
	arrayBuffer: () => unknown;
	json: () => unknown;
	text: () => unknown;
}): Record<string, unknown> {
	return Object.defineProperties(
		{ status: 200, headers: { "content-type": "text/markdown" } },
		{
			arrayBuffer: { enumerable: true, get: bodyViews.arrayBuffer },
			json: { enumerable: true, get: bodyViews.json },
			text: { enumerable: true, get: bodyViews.text },
		},
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("requestUrl body view selection", () => {
	it("does not evaluate JSON or text when the caller selects arrayBuffer", async () => {
		const bytes = new Uint8Array([35, 32, 78, 111, 116, 101]).buffer;
		const jsonGetter = vi.fn((): unknown => {
			void JSON.parse("# Note");
			return undefined;
		});
		const textGetter = vi.fn(() => "# Note");
		const arrayBufferGetter = vi.fn(() => bytes);
		mockRuntimeResponse(
			responseWithBodyViews({
				arrayBuffer: arrayBufferGetter,
				json: jsonGetter,
				text: textGetter,
			}),
		);

		const response = await requestUrl({ url: "https://example.test/media" });

		expect(arrayBufferGetter).not.toHaveBeenCalled();
		expect(jsonGetter).not.toHaveBeenCalled();
		expect(textGetter).not.toHaveBeenCalled();
		expect(response.arrayBuffer).toBe(bytes);
		expect(arrayBufferGetter).toHaveBeenCalledOnce();
		expect(jsonGetter).not.toHaveBeenCalled();
		expect(textGetter).not.toHaveBeenCalled();
	});

	it("does not evaluate any body view when the caller only uses status and headers", async () => {
		const unselectedGetter = vi.fn(() => {
			throw new Error("unselected body view was evaluated");
		});
		mockRuntimeResponse(
			responseWithBodyViews({
				arrayBuffer: unselectedGetter,
				json: unselectedGetter,
				text: unselectedGetter,
			}),
		);

		const response = await requestUrl({ url: "https://example.test/delete" });

		expect(response.status).toBe(200);
		expect(response.headers).toEqual({ "content-type": "text/markdown" });
		expect(unselectedGetter).not.toHaveBeenCalled();
	});

	it("preserves the runtime JSON parse error until JSON is selected", async () => {
		const parseError = new SyntaxError("Unexpected token '#'");
		const jsonGetter = vi.fn(() => {
			throw parseError;
		});
		const arrayBufferGetter = vi.fn(() => new ArrayBuffer(0));
		const textGetter = vi.fn(() => "# Note");
		mockRuntimeResponse(
			responseWithBodyViews({
				arrayBuffer: arrayBufferGetter,
				json: jsonGetter,
				text: textGetter,
			}),
		);

		const response = await requestUrl({ url: "https://example.test/json" });
		let thrown: unknown;
		try {
			void response.json;
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBe(parseError);
		expect(jsonGetter).toHaveBeenCalledOnce();
		expect(arrayBufferGetter).not.toHaveBeenCalled();
		expect(textGetter).not.toHaveBeenCalled();
	});

	it("validates arrayBuffer and text only when each view is selected", async () => {
		mockRuntimeResponse(
			responseWithBodyViews({
				arrayBuffer: () => "not an ArrayBuffer",
				json: () => ({ ok: true }),
				text: () => 42,
			}),
		);

		const response = await requestUrl({ url: "https://example.test/invalid" });

		expect(() => response.arrayBuffer).toThrow(
			"Obsidian requestUrl returned an invalid response shape",
		);
		expect(response.json).toEqual({ ok: true });
		expect(() => response.text).toThrow(
			"Obsidian requestUrl returned an invalid response shape",
		);
	});
});
