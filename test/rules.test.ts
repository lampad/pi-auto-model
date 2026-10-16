import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	describeRule,
	effectiveRules,
	filterTargetsByRule,
	hasRuleFilters,
	LONG_CONTEXT_TOKENS,
	matchRule,
	parseRules,
	parseScenarios,
	preferredTargetIds,
	scenarioRules,
	traceRules,
	type RuleFacts,
} from "../src/routing/rules.ts";
import { CACHE_IDLE_MS, coldCacheReason } from "../src/routing/cache-state.ts";
import { planRoute } from "../src/routing/route-planner.ts";
import { analyzeTask } from "../src/task/local-analyzer.ts";
import type { RouteTarget } from "../src/types.ts";

function target(provider: string, id: string, cost = 1): RouteTarget {
	return {
		id: `${provider}/${id}`,
		model: {
			provider,
			id,
			name: id,
			reasoning: true,
			input: ["text"],
			contextWindow: 200_000,
			maxTokens: 32_000,
			cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0 },
		} as Model<any>,
	};
}

const facts: RuleFacts = {
	kinds: ["debug"],
	complexity: 0.6,
	contextTokens: 10_000,
	hasImages: false,
	trigger: "user",
	prompt: "Fix the login bug",
};

test("parseRules keeps valid rules and reports each invalid one", () => {
	const { rules, errors } = parseRules([
		{ name: "ok", when: { kinds: ["debug"] }, then: { policy: "price" } },
		{ name: "bad-kind", when: { kinds: ["dance"] }, then: { policy: "best" } },
		{ name: "bad-key", when: { mood: "happy" }, then: { policy: "best" } },
		{ name: "no-action", then: {} },
		{ name: "bad-regex", when: { promptMatches: "(" }, then: { policy: "best" } },
		{ when: {}, then: { policy: "best" } },
		"nope",
		{ name: "always", then: { prefer: ["anthropic/*"] } },
	], "cfg.json");
	assert.deepEqual(rules.map((rule) => rule.name), ["ok", "always"]);
	assert.equal(rules[0].then.policy, "cost", "legacy policy names are normalized");
	assert.equal(errors.length, 6);
	assert.match(errors[0], /^cfg\.json: rule "bad-kind" ignored: "kinds"/);
	assert.match(errors[1], /unknown condition "mood"/);
	assert.match(errors[2], /at least one action/);
	assert.match(errors[3], /not a valid regular expression/);
	assert.match(errors[4], /rule #6 ignored: "name"/);
	assert.match(errors[5], /rule #7 ignored: must be an object/);
});

test("parseRules rejects a non-array rules value", () => {
	const { rules, errors } = parseRules({ name: "x" }, "cfg.json");
	assert.deepEqual(rules, []);
	assert.match(errors[0], /must be a list/);
	assert.deepEqual(parseRules(undefined, "cfg.json"), { rules: [], errors: [] });
});

test("matchRule picks the first rule whose conditions all hold", () => {
	const { rules } = parseRules([
		{ name: "images", when: { hasImages: true }, then: { policy: "best" } },
		{ name: "hard-debug", when: { kinds: ["debug"], minComplexity: 0.5 }, then: { policy: "best" } },
		{ name: "any-debug", when: { kinds: ["debug"] }, then: { policy: "cost" } },
	], "cfg");
	assert.equal(matchRule(rules, facts)?.name, "hard-debug");
	assert.equal(matchRule(rules, { ...facts, complexity: 0.2 })?.name, "any-debug");
	assert.equal(matchRule(rules, { ...facts, hasImages: true })?.name, "images");
	assert.equal(matchRule(rules, { ...facts, kinds: ["explain"] }), undefined);
	assert.equal(matchRule(undefined, facts), undefined);
});

test("rule conditions cover context size, trigger, and prompt text", () => {
	const { rules } = parseRules([
		{ name: "long", when: { minContextTokens: 50_000 }, then: { policy: "best" } },
		{ name: "background", when: { trigger: "extension" }, then: { policy: "cost" } },
		{ name: "docs", when: { promptMatches: "\\bREADME\\b", maxContextTokens: 20_000 }, then: { policy: "cost" } },
	], "cfg");
	assert.equal(matchRule(rules, { ...facts, contextTokens: 60_000 })?.name, "long");
	assert.equal(matchRule(rules, { ...facts, trigger: "extension" })?.name, "background");
	assert.equal(matchRule(rules, { ...facts, prompt: "update the readme" })?.name, "docs", "promptMatches is case-insensitive");
	assert.equal(matchRule(rules, facts), undefined);
});

test("single strings are accepted wherever a list is expected", () => {
	const { rules, errors } = parseRules([{ name: "r", when: { kinds: "review" }, then: { only: "anthropic/*", exclude: "*mini*" } }], "cfg");
	assert.deepEqual(errors, []);
	assert.deepEqual(rules[0], { name: "r", when: { kinds: ["review"] }, then: { only: ["anthropic/*"], exclude: ["*mini*"] } });
});

test("scenarios accept a policy, a model pattern, or an action object", () => {
	const { scenarios, errors } = parseScenarios({
		review: "best",
		debug: "anthropic/claude-sonnet",
		plan: ["openai/*", "anthropic/*"],
		background: { policy: "price", thinking: "low" },
		vision: { colour: "red" },
		reveiw: "cost",
	}, "cfg");
	assert.deepEqual(scenarios, {
		review: { policy: "best" },
		debug: { only: ["anthropic/claude-sonnet"] },
		plan: { only: ["openai/*", "anthropic/*"] },
		background: { policy: "cost", thinking: "low" },
	});
	assert.equal(errors.length, 2);
	assert.match(errors[0], /scenario "vision" ignored: unknown action "colour"/);
	assert.match(errors[1], /unknown scenario "reveiw" ignored \(did you mean "review"\?\)/);
});

test("scenarios expand into rules after explicit rules, situations before task kinds", () => {
	const rules = effectiveRules({
		rules: parseRules([{ name: "mine", when: { promptMatches: "urgent" }, then: { policy: "fast" } }], "cfg").rules,
		scenarios: { review: { policy: "best" }, background: { policy: "cost" }, vision: { policy: "best" } },
	});
	assert.deepEqual(rules.map((rule) => rule.name), ["mine", "scenario:vision", "scenario:background", "scenario:review"]);
	assert.equal(matchRule(rules, { ...facts, kinds: ["review"], trigger: "extension" })?.name, "scenario:background");
	assert.equal(matchRule(rules, { ...facts, kinds: ["review"] })?.name, "scenario:review");
	assert.equal(matchRule(scenarioRules({ longContext: { policy: "best" } }), { ...facts, contextTokens: LONG_CONTEXT_TOKENS })?.name, "scenario:longContext");
});

test("traceRules explains each skipped rule up to the first match", () => {
	const rules = effectiveRules({ scenarios: { vision: { policy: "best" }, review: { policy: "best" }, debug: { policy: "cost" }, plan: { policy: "best" } } });
	assert.deepEqual(traceRules(rules, facts), [
		"✗ scenario:vision: task has no images",
		"✗ scenario:review: task is debug, not review",
		"✓ scenario:debug",
	]);
});

test("the prompt cache is cold after compaction or a long idle gap", () => {
	const now = 1_000_000_000;
	assert.equal(coldCacheReason({}, now), undefined);
	assert.equal(coldCacheReason({ lastTaskEndedAt: now - 60_000 }, now), undefined);
	assert.equal(coldCacheReason({ lastTaskEndedAt: now - CACHE_IDLE_MS - 120_000 }, now), "idle 7m");
	assert.equal(coldCacheReason({ cacheBoundary: { at: now, reason: "compaction" }, lastTaskEndedAt: now }, now), "compaction");
});

test("rule filters restrict candidates by pattern and tier", () => {
	const targets = [target("openai", "gpt-5"), target("anthropic", "claude-sonnet-4"), target("openai", "gpt-5-mini")];
	const { rules: [only, exclude, prefer] } = parseRules([
		{ name: "only", then: { only: ["openai/*"] } },
		{ name: "exclude", then: { exclude: ["gpt-5-mini"] } },
		{ name: "prefer", then: { prefer: ["anthropic/*"] } },
	], "cfg");
	assert.deepEqual(filterTargetsByRule(targets, only).map((t) => t.id), ["openai/gpt-5", "openai/gpt-5-mini"]);
	assert.deepEqual(filterTargetsByRule(targets, exclude).map((t) => t.id), ["openai/gpt-5", "anthropic/claude-sonnet-4"], "bare model ids match");
	assert.equal(hasRuleFilters(only), true);
	assert.equal(hasRuleFilters(prefer), false);
	assert.deepEqual([...preferredTargetIds(targets, prefer)], ["anthropic/claude-sonnet-4"]);
	assert.equal(preferredTargetIds(targets, undefined).size, 0);
	assert.match(describeRule(only), /^only: when always → only=openai\/\*$/);
});

test("preferred targets receive a utility bonus in route planning", () => {
	const cheap = target("openai", "gpt-5", 1);
	const pricier = target("openai", "gpt-5-pro", 1.2);
	const profile = analyzeTask({ prompt: "hello" });
	assert.equal(planRoute({ targets: [cheap, pricier], profile })?.target.id, cheap.id);
	const plan = planRoute({ targets: [cheap, pricier], profile, preferredTargetIds: new Set([pricier.id]) });
	assert.equal(plan?.target.id, pricier.id);
});
