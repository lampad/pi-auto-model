import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { requestContextTokens } from "../src/pi/request-context.ts";

const usage = { input: 400_000, output: 1_000, cacheRead: 46_041, cacheWrite: 0, totalTokens: 447_041 };

test("uses reported usage plus new messages, not serialized historical JSON", () => {
	const context = { messages: [
		{ role: "user", content: "x".repeat(2_555_289) },
		{ role: "assistant", content: [], stopReason: "stop", usage },
		{ role: "user", content: "next" },
	] } as Context;
	assert.equal(requestContextTokens(context), 447_043);
});

test("counts input without usage and includes legacy system and tools", () => {
	assert.ok(requestContextTokens({ messages: [], systemPrompt: "x".repeat(900_000) }) >= 300_000);
	assert.ok(requestContextTokens({ messages: [{ role: "user", content: "x".repeat(720_000), timestamp: 0 }] }) >= 180_000);
});

test("ignores error usage and gives images a nonzero estimate", () => {
	const context = { messages: [
		{ role: "assistant", content: [], stopReason: "error", usage },
		{ role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }] },
	] } as Context;
	assert.equal(requestContextTokens(context), 1201);
});

test("counts transcript-style system and tool declarations on newer hosts", () => {
	const context = { messages: [{ role: "system", content: "x".repeat(900_000) }] } as unknown as Context;
	assert.ok(requestContextTokens(context) >= 225_000);
});
