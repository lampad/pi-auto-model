import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export interface TaskEvaluationRun {
	taskId: string;
	revision: string;
	variant: "router" | "baseline";
	configId: string;
	models: string[];
	outcome: "success" | "failure" | "cancelled" | "unknown";
	/** Acceptance-test command/result or review evidence, not a successful API response. */
	evidence?: string;
	/** Total reported cost, including failures, classification and compaction. Omit if incomplete. */
	costUsd?: number;
	durationMs: number;
}

export function parseTaskRuns(text: string): TaskEvaluationRun[] {
	return text.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
		const value = JSON.parse(line) as TaskEvaluationRun;
		const nonempty = (text: unknown): text is string => typeof text === "string" && text.trim().length > 0;
		const amount = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && value >= 0;
		if (!value || !nonempty(value.taskId) || !nonempty(value.revision) || !nonempty(value.configId) ||
			!["router", "baseline"].includes(value.variant) || !Array.isArray(value.models) || value.models.length === 0 || !value.models.every(nonempty) ||
			!["success", "failure", "cancelled", "unknown"].includes(value.outcome) || !amount(value.durationMs) ||
			(value.costUsd !== undefined && !amount(value.costUsd)) ||
			(["success", "failure"].includes(value.outcome) && !nonempty(value.evidence))) {
			throw new Error(`Invalid task evaluation record at line ${index + 1}`);
		}
		return value;
	});
}

export function evaluateTaskRuns(runs: readonly TaskEvaluationRun[]) {
	if (runs.length === 0) throw new Error("No task evaluation records");
	const pairs = new Map<string, Set<string>>();
	for (const run of runs) {
		const key = JSON.stringify([run.taskId, run.revision]);
		const variants = pairs.get(key) ?? new Set<string>();
		if (variants.has(run.variant)) throw new Error(`Duplicate ${run.variant} run for ${run.taskId} at revision ${run.revision}; use a distinct task ID or revision for each repeated trial`);
		variants.add(run.variant);
		pairs.set(key, variants);
	}
	if ([...pairs.values()].some((variants) => variants.size !== 2)) throw new Error("Every task/revision needs one router and one baseline run");
	const summarize = (variant: TaskEvaluationRun["variant"]) => {
		const selected = runs.filter((run) => run.variant === variant);
		const successes = selected.filter((run) => run.outcome === "success").length;
		const unknownOutcomes = selected.filter((run) => run.outcome === "unknown").length;
		const unknownCosts = selected.filter((run) => run.costUsd === undefined).length;
		const cost = selected.reduce((total, run) => total + (run.costUsd ?? 0), 0);
		const times = selected.map((run) => run.durationMs).sort((a, b) => a - b);
		return { tasks: selected.length, successes, failures: selected.filter((run) => run.outcome === "failure").length,
			cancelled: selected.filter((run) => run.outcome === "cancelled").length, unknownOutcomes, unknownCosts,
			successRate: unknownOutcomes ? null : successes / selected.length,
			totalCostUsd: unknownCosts ? null : cost,
			costPerSuccessUsd: unknownCosts || unknownOutcomes || !successes ? null : cost / successes,
			latencyP50Ms: times[Math.ceil(times.length * 0.5) - 1], latencyP95Ms: times[Math.ceil(times.length * 0.95) - 1] };
	};
	const router = summarize("router");
	const baseline = summarize("baseline");
	return { pairedTasks: pairs.size, router, baseline,
		successRateDelta: router.successRate === null || baseline.successRate === null ? null : router.successRate - baseline.successRate,
		costPerSuccessSavings: router.costPerSuccessUsd === null || baseline.costPerSuccessUsd === null || baseline.costPerSuccessUsd === 0
			? null : 1 - router.costPerSuccessUsd / baseline.costPerSuccessUsd,
		note: "Descriptive paired results only; unknown costs/outcomes suppress comparisons. No statistical quality guarantee." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		if (process.argv.length !== 3) throw new Error("Usage: npm run eval:tasks -- <runs.jsonl>");
		console.log(JSON.stringify(evaluateTaskRuns(parseTaskRuns(await readFile(process.argv[2], "utf8"))), null, 2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
