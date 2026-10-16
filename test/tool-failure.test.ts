import assert from "node:assert/strict";
import test from "node:test";
import { classifyToolFailure } from "../src/task/tool-failure.ts";

test("separates repairable tool mistakes from test failures and environment problems", () => {
	const result = (text: string) => ({ content: [{ type: "text", text }] });
	assert.equal(classifyToolFailure("edit", result("Could not find the exact old text")), "execution");
	assert.equal(classifyToolFailure("bash", result("2 tests failed: AssertionError")), "validation");
	assert.equal(classifyToolFailure("bash", result("npm: command not found")), "environment");
	assert.equal(classifyToolFailure("read", result("ENOENT: no such file")), "environment");
	assert.equal(classifyToolFailure("custom", result("unspecified failure")), "unknown");
	assert.equal(classifyToolFailure("custom", undefined), "unknown");
});
