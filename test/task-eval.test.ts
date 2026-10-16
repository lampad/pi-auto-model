import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTaskRuns, parseTaskRuns, type TaskEvaluationRun } from "../src/evaluation/task-eval.ts";

const run = (taskId: string, variant: "router" | "baseline", outcome: "success" | "failure", costUsd: number): TaskEvaluationRun => ({
	taskId, revision: "fixture-v1", variant, outcome, costUsd, durationMs: 100,
	configId: "fixture-config", models: ["fixture/model"], evidence: "synthetic test result",
});

test("paired evaluation includes failed-run costs and reports quality separately", () => {
	const result = evaluateTaskRuns([run("one", "router", "success", 1), run("one", "baseline", "success", 3),
		run("two", "router", "failure", 1), run("two", "baseline", "success", 3)]);
	assert.equal(result.router.costPerSuccessUsd, 2);
	assert.equal(result.baseline.costPerSuccessUsd, 3);
	assert.equal(result.successRateDelta, -0.5);
});

test("evaluation rejects unmatched, duplicate and unsupported evidence", () => {
	const first = run("one", "router", "success", 1);
	assert.throws(() => evaluateTaskRuns([first]), /needs one/);
	assert.throws(() => evaluateTaskRuns([first, first]), /Duplicate/);
	assert.throws(() => parseTaskRuns(JSON.stringify({ ...first, evidence: undefined })), /Invalid/);
	assert.throws(() => parseTaskRuns(JSON.stringify({ ...first, costUsd: -1 })), /Invalid/);
	assert.equal(parseTaskRuns(JSON.stringify(first)).length, 1);
});

test("unknown outcomes or costs never become free successful runs", () => {
	const result = evaluateTaskRuns([{ ...run("one", "router", "success", 1), outcome: "unknown", costUsd: undefined },
		run("one", "baseline", "success", 2)]);
	assert.equal(result.router.successRate, null);
	assert.equal(result.router.totalCostUsd, null);
	assert.equal(result.costPerSuccessSavings, null);
	assert.equal(result.successRateDelta, null);
});
