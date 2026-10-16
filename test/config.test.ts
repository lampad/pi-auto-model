import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, mergeConfig } from "../src/config/loader.ts";
import { appendDecision } from "../src/storage/jsonl.ts";

test("loads configuration with safe defaults", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-"));
	const file = join(dir, "auto-model.json");
	await writeFile(file, JSON.stringify({ policy: "best", aliases: { "a/b": "x:y" } }));
	const config = await loadConfig(file);
	assert.equal(config.policy, "best");
	assert.equal(config.aliases["a/b"], "x:y");
	assert.equal(config.enabled, true);
	assert.equal(config.quota.enabled, true);
	assert.equal(config.quota.windowMs, 86_400_000);
	assert.deepEqual(config.pools, {});
});

test("allows a project or global config to disable automatic activation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-"));
	const file = join(dir, "auto-model.json");
	await writeFile(file, JSON.stringify({ enabled: false }));
	const config = await loadConfig(file);
	assert.equal(config.enabled, false);
});

test("loads weighted pools and the default pool name", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-"));
	const file = join(dir, "auto-model.json");
	await writeFile(file, JSON.stringify({
		pool: "general",
		pools: {
			general: {
				windowHours: 12,
				targets: [{ id: "openai/gpt-5", weight: 2 }],
			},
		},
	}));
	const config = await loadConfig(file);
	assert.equal(config.pool, "general");
	assert.deepEqual(config.pools.general.targets, [{ id: "openai/gpt-5", weight: 2 }]);
	assert.equal(config.pools.general.windowHours, 12);
});

test("falls back to the default policy for an unsupported policy name", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-"));
	const file = join(dir, "auto-model.json");
	await writeFile(file, JSON.stringify({ policy: "economy" }));
	const config = await loadConfig(file);
	assert.equal(config.policy, "balanced");
});

test("loads the legacy price policy as cost", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-"));
	const file = join(dir, "auto-model.json");
	await writeFile(file, JSON.stringify({ policy: "price" }));
	assert.equal((await loadConfig(file)).policy, "cost");
});

test("rejects structurally invalid configuration", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-"));
	const file = join(dir, "auto-model.json");
	await writeFile(file, JSON.stringify({ pools: { bad: { targets: "not-an-array" } } }));
	const config = await loadConfig(file);
	assert.deepEqual(config.pools, {});
});

test("rejects invalid numeric configuration", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-"));
	const file = join(dir, "auto-model.json");
	await writeFile(file, JSON.stringify({ failover: { maxAttempts: 0 }, benchmarkOverrides: { "p/m": { ramp: 2 } } }));
	const config = await loadConfig(file);
	assert.equal(config.failover.maxAttempts, 3);
	assert.equal(config.benchmarkOverrides, undefined);
});

test("loads shadow mode", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-"));
	const file = join(dir, "auto-model.json");
	await writeFile(file, JSON.stringify({ shadow: { enabled: true } }));
	assert.equal((await loadConfig(file)).shadow?.enabled, true);
});

test("loads the cost policy quality floor", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-"));
	const file = join(dir, "auto-model.json");
	await writeFile(file, JSON.stringify({ costPolicy: { qualityFloor: 0.6 } }));
	assert.equal((await loadConfig(file)).costPolicy?.qualityFloor, 0.6);
	await writeFile(file, JSON.stringify({ costPolicy: { stickinessTolerance: 0.2 } }));
	assert.equal((await loadConfig(file)).costPolicy?.stickinessTolerance, 0.2);
});

test("rejects an out-of-range cost policy quality floor", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-"));
	const file = join(dir, "auto-model.json");
	await writeFile(file, JSON.stringify({ costPolicy: { qualityFloor: 2 } }));
	assert.equal((await loadConfig(file)).costPolicy, undefined);
});

test("drops invalid rules individually and records diagnostics", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-"));
	const file = join(dir, "auto-model.json");
	await writeFile(file, JSON.stringify({
		policy: "best",
		rules: [
			{ name: "good", when: { kinds: ["review"] }, then: { policy: "cost" } },
			{ name: "bad", when: { kinds: ["review"] }, then: { minimumTier: "huge" } },
		],
	}));
	const config = await loadConfig(file);
	assert.equal(config.policy, "best", "a bad rule does not invalidate the rest of the file");
	assert.deepEqual(config.rules?.map((rule) => rule.name), ["good"]);
	assert.equal(config.diagnostics?.length, 1);
	assert.match(config.diagnostics![0], /rule "bad" ignored: "minimumTier"/);
});

test("reports invalid JSON and invalid configuration instead of failing silently", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-"));
	const broken = join(dir, "broken.json");
	await writeFile(broken, "{ not json");
	assert.match((await loadConfig(broken)).diagnostics![0], /invalid JSON; using defaults/);
	const invalid = join(dir, "invalid.json");
	await writeFile(invalid, JSON.stringify({ policy: "best", shadow: { enabled: "yes" } }));
	const config = await loadConfig(invalid);
	assert.match(config.diagnostics![0], /invalid configuration; using defaults/);
	assert.equal(config.policy, "balanced");
	assert.deepEqual((await loadConfig(join(dir, "missing.json"))).diagnostics, [], "a missing file is not an issue");
});

test("project rules run before global rules and diagnostics are combined", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-"));
	const globalFile = join(dir, "global.json");
	const projectFile = join(dir, "project.json");
	await writeFile(globalFile, JSON.stringify({
		scenarios: { review: "best", debug: "cost" },
		rules: [{ name: "global", then: { policy: "cost" } }, { name: "global-bad", then: {} }],
	}));
	await writeFile(projectFile, JSON.stringify({
		scenarios: { review: "anthropic/*" },
		rules: [{ name: "project", then: { policy: "best" } }],
	}));
	const global = await loadConfig(globalFile);
	const merged = mergeConfig(global, await loadConfig(projectFile, global));
	assert.deepEqual(merged.rules?.map((rule) => rule.name), ["project", "global"]);
	assert.deepEqual(merged.scenarios, { review: { only: ["anthropic/*"] }, debug: { policy: "cost" } }, "project scenarios replace global ones by name");
	assert.equal(merged.diagnostics?.length, 1);
});

test("reports unknown scenario names with a suggestion", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-"));
	const file = join(dir, "auto-model.json");
	await writeFile(file, JSON.stringify({ scenarios: { reviews: "best", vision: "openai/gpt-5" } }));
	const config = await loadConfig(file);
	assert.deepEqual(config.scenarios, { vision: { only: ["openai/gpt-5"] } });
	assert.match(config.diagnostics![0], /unknown scenario "reviews" ignored \(did you mean "review"\?\)/);
});

test("appends decisions as JSONL", async () => {
	const file = join(await mkdtemp(join(tmpdir(), "auto-model-")), "decisions.jsonl");
	await appendDecision(file, { id: "r1", targetId: "p/m", thinking: "low", policy: "balanced", reason: [], score: { targetId: "p/m", quality: 0, cost: 0, stickiness: 0, utility: 0 }, taskKinds: ["mixed"], createdAt: 1 });
	assert.match(await readFile(file, "utf8"), /"id":"r1"/);
});
