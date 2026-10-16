import { deriveCapabilityPrior, tierRank, type CapabilityOptions } from "../models/capability.ts";
import {
	normalizeRoutingPolicy,
	type CapabilityTier,
	type RouteTarget,
	type RoutingPolicy,
	type TaskKind,
	type ThinkingLevel,
} from "../types.ts";
import { matchesPattern } from "./candidate-resolver.ts";

export interface RoutingRuleWhen {
	kinds?: TaskKind[];
	minComplexity?: number;
	maxComplexity?: number;
	minContextTokens?: number;
	maxContextTokens?: number;
	hasImages?: boolean;
	trigger?: "user" | "extension";
	/** Case-insensitive regular expression tested against the prompt. */
	promptMatches?: string;
}

export interface RoutingRuleThen {
	only?: string[];
	exclude?: string[];
	prefer?: string[];
	minimumTier?: Exclude<CapabilityTier, "unknown">;
	policy?: RoutingPolicy;
	thinking?: ThinkingLevel;
}

export interface RoutingRule {
	name: string;
	when: RoutingRuleWhen;
	then: RoutingRuleThen;
}

export type Scenarios = Record<string, RoutingRuleThen>;

export interface RuleFacts {
	kinds: readonly TaskKind[];
	complexity: number;
	contextTokens: number;
	hasImages: boolean;
	trigger: "user" | "extension";
	prompt: string;
}

/** Utility bonus for targets matching a rule's `prefer` patterns. */
export const RULE_PREFER_BONUS = 0.15;
/** Context size at which the `longContext` scenario applies. */
export const LONG_CONTEXT_TOKENS = 100_000;

const TASK_KINDS: readonly TaskKind[] = [
	"explain", "code-edit", "generate", "debug", "refactor", "review", "test", "plan", "architecture", "ops", "research", "mixed",
];
const TIERS: ReadonlySet<string> = new Set(["frontier", "strong", "mid", "light"]);
const THINKING_LEVELS: ReadonlySet<string> = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const WHEN_KEYS = new Set(["kinds", "minComplexity", "maxComplexity", "minContextTokens", "maxContextTokens", "hasImages", "trigger", "promptMatches"]);
const THEN_KEYS = new Set(["only", "exclude", "prefer", "minimumTier", "policy", "thinking"]);

/** Situational scenarios are checked before task-kind scenarios, in this order. */
const SITUATIONS: Record<string, RoutingRuleWhen> = {
	vision: { hasImages: true },
	longContext: { minContextTokens: LONG_CONTEXT_TOKENS },
	background: { trigger: "extension" },
};
export const SCENARIO_NAMES: readonly string[] = [...Object.keys(SITUATIONS), ...TASK_KINDS.filter((kind) => kind !== "mixed")];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts a single string or a non-empty list of strings. */
function toList(value: unknown): string[] | undefined {
	const list = typeof value === "string" ? [value] : value;
	return Array.isArray(list) && list.length > 0 && list.every((entry) => typeof entry === "string" && entry.length > 0)
		? [...list]
		: undefined;
}

function isNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseWhen(when: Record<string, unknown>): RoutingRuleWhen | string {
	const unknown = Object.keys(when).find((key) => !WHEN_KEYS.has(key));
	if (unknown) return `unknown condition "${unknown}"`;
	const result: RoutingRuleWhen = {};
	if (when.kinds !== undefined) {
		const kinds = toList(when.kinds);
		if (!kinds || !kinds.every((kind) => (TASK_KINDS as readonly string[]).includes(kind))) {
			return `"kinds" must be one or more of: ${TASK_KINDS.join(", ")}`;
		}
		result.kinds = kinds as TaskKind[];
	}
	for (const key of ["minComplexity", "maxComplexity"] as const) {
		if (when[key] === undefined) continue;
		if (!(isNonNegative(when[key]) && when[key] <= 1)) return `"${key}" must be between 0 and 1`;
		result[key] = when[key];
	}
	for (const key of ["minContextTokens", "maxContextTokens"] as const) {
		if (when[key] === undefined) continue;
		if (!isNonNegative(when[key])) return `"${key}" must be a non-negative number`;
		result[key] = when[key];
	}
	if (when.hasImages !== undefined) {
		if (typeof when.hasImages !== "boolean") return `"hasImages" must be true or false`;
		result.hasImages = when.hasImages;
	}
	if (when.trigger !== undefined) {
		if (when.trigger !== "user" && when.trigger !== "extension") return `"trigger" must be "user" or "extension"`;
		result.trigger = when.trigger;
	}
	if (when.promptMatches !== undefined) {
		if (typeof when.promptMatches !== "string") return `"promptMatches" must be a string`;
		try {
			new RegExp(when.promptMatches, "i");
		} catch {
			return `"promptMatches" is not a valid regular expression`;
		}
		result.promptMatches = when.promptMatches;
	}
	return result;
}

function parseThen(then: Record<string, unknown>): RoutingRuleThen | string {
	const unknown = Object.keys(then).find((key) => !THEN_KEYS.has(key));
	if (unknown) return `unknown action "${unknown}"`;
	if (Object.keys(then).length === 0) return "needs at least one action";
	const result: RoutingRuleThen = {};
	for (const key of ["only", "exclude", "prefer"] as const) {
		if (then[key] === undefined) continue;
		const patterns = toList(then[key]);
		if (!patterns) return `"${key}" must be a model pattern or a list of model patterns`;
		result[key] = patterns;
	}
	if (then.minimumTier !== undefined) {
		if (!TIERS.has(then.minimumTier as string)) return `"minimumTier" must be one of: ${[...TIERS].join(", ")}`;
		result.minimumTier = then.minimumTier as RoutingRuleThen["minimumTier"];
	}
	if (then.policy !== undefined) {
		const policy = normalizeRoutingPolicy(then.policy);
		if (!policy) return `"policy" must be balanced, best, cost, or fast`;
		result.policy = policy;
	}
	if (then.thinking !== undefined) {
		if (!THINKING_LEVELS.has(then.thinking as string)) return `"thinking" must be one of: ${[...THINKING_LEVELS].join(", ")}`;
		result.thinking = then.thinking as ThinkingLevel;
	}
	return result;
}

/** Keeps valid rules and reports each invalid one instead of rejecting the whole configuration. */
export function parseRules(value: unknown, source: string): { rules: RoutingRule[]; errors: string[] } {
	if (value === undefined) return { rules: [], errors: [] };
	if (!Array.isArray(value)) return { rules: [], errors: [`${source}: "rules" must be a list; all rules ignored`] };
	const rules: RoutingRule[] = [];
	const errors: string[] = [];
	value.forEach((entry, index) => {
		const label = isRecord(entry) && typeof entry.name === "string" && entry.name ? `"${entry.name}"` : `#${index + 1}`;
		const fail = (problem: string) => errors.push(`${source}: rule ${label} ignored: ${problem}`);
		if (!isRecord(entry)) return fail("must be an object");
		if (typeof entry.name !== "string" || !entry.name) return fail(`"name" must be a non-empty string`);
		if (entry.when !== undefined && !isRecord(entry.when)) return fail(`"when" must be an object`);
		if (!isRecord(entry.then)) return fail(`"then" must be an object`);
		const when = parseWhen(entry.when ?? {});
		if (typeof when === "string") return fail(when);
		const then = parseThen(entry.then);
		if (typeof then === "string") return fail(then);
		rules.push({ name: entry.name, when, then });
	});
	return { rules, errors };
}

function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		previous = current;
	}
	return previous[b.length];
}

function closest(name: string, options: readonly string[]): string | undefined {
	const normalize = (value: string) => value.toLowerCase().replace(/[-_\s]/g, "");
	let best: { option: string; distance: number } | undefined;
	for (const option of options) {
		const distance = editDistance(normalize(name), normalize(option));
		if (distance <= 2 && (!best || distance < best.distance)) best = { option, distance };
	}
	return best?.option;
}

/**
 * Parses the `scenarios` shorthand. A value is a policy name (`"cost"`), a model
 * pattern or list of patterns (`"anthropic/*"`), or an action object.
 */
export function parseScenarios(value: unknown, source: string): { scenarios: Scenarios; errors: string[] } {
	if (value === undefined) return { scenarios: {}, errors: [] };
	if (!isRecord(value)) return { scenarios: {}, errors: [`${source}: "scenarios" must be an object; all scenarios ignored`] };
	const scenarios: Scenarios = {};
	const errors: string[] = [];
	for (const [name, entry] of Object.entries(value)) {
		if (!SCENARIO_NAMES.includes(name)) {
			const hint = closest(name, SCENARIO_NAMES);
			errors.push(`${source}: unknown scenario "${name}" ignored${hint ? ` (did you mean "${hint}"?)` : ""}; use one of: ${SCENARIO_NAMES.join(", ")}`);
			continue;
		}
		const policy = normalizeRoutingPolicy(entry);
		const patterns = policy ? undefined : toList(entry);
		const then = policy ? { policy } : patterns ? { only: patterns } : isRecord(entry) ? parseThen(entry) : "must be a policy name, a model pattern, or an action object";
		if (typeof then === "string") {
			errors.push(`${source}: scenario "${name}" ignored: ${then}`);
			continue;
		}
		scenarios[name] = then;
	}
	return { scenarios, errors };
}

/** Expands scenarios into ordinary rules: situations first, then task kinds. */
export function scenarioRules(scenarios: Scenarios | undefined): RoutingRule[] {
	if (!scenarios) return [];
	const names = [
		...Object.keys(SITUATIONS).filter((name) => scenarios[name]),
		...Object.keys(scenarios).filter((name) => !(name in SITUATIONS)),
	];
	return names.map((name) => ({
		name: `scenario:${name}`,
		when: SITUATIONS[name] ?? { kinds: [name as TaskKind] },
		then: scenarios[name],
	}));
}

/** Explicit rules first, then the expanded scenarios. */
export function effectiveRules(config: { rules?: readonly RoutingRule[]; scenarios?: Scenarios }): RoutingRule[] {
	return [...(config.rules ?? []), ...scenarioRules(config.scenarios)];
}

/** Returns why a rule does not match, or undefined when it matches. */
export function ruleMismatch(rule: RoutingRule, facts: RuleFacts): string | undefined {
	const when = rule.when;
	if (when.kinds && !when.kinds.some((kind) => facts.kinds.includes(kind))) return `task is ${facts.kinds.join("+")}, not ${when.kinds.join("|")}`;
	if (when.minComplexity !== undefined && facts.complexity < when.minComplexity) return `complexity ${facts.complexity.toFixed(2)} < ${when.minComplexity}`;
	if (when.maxComplexity !== undefined && facts.complexity > when.maxComplexity) return `complexity ${facts.complexity.toFixed(2)} > ${when.maxComplexity}`;
	if (when.minContextTokens !== undefined && facts.contextTokens < when.minContextTokens) return `context ${facts.contextTokens} < ${when.minContextTokens} tokens`;
	if (when.maxContextTokens !== undefined && facts.contextTokens > when.maxContextTokens) return `context ${facts.contextTokens} > ${when.maxContextTokens} tokens`;
	if (when.hasImages !== undefined && facts.hasImages !== when.hasImages) return facts.hasImages ? "task has images" : "task has no images";
	if (when.trigger !== undefined && facts.trigger !== when.trigger) return `triggered by ${facts.trigger}`;
	if (when.promptMatches !== undefined && !new RegExp(when.promptMatches, "i").test(facts.prompt)) return "prompt does not match";
	return undefined;
}

export function ruleMatches(rule: RoutingRule, facts: RuleFacts): boolean {
	return ruleMismatch(rule, facts) === undefined;
}

/** First matching rule wins. */
export function matchRule(rules: readonly RoutingRule[] | undefined, facts: RuleFacts): RoutingRule | undefined {
	return rules?.find((rule) => ruleMatches(rule, facts));
}

/** One line per rule up to and including the first match. */
export function traceRules(rules: readonly RoutingRule[], facts: RuleFacts): string[] {
	const lines: string[] = [];
	for (const rule of rules) {
		const mismatch = ruleMismatch(rule, facts);
		lines.push(mismatch ? `✗ ${rule.name}: ${mismatch}` : `✓ ${rule.name}`);
		if (!mismatch) break;
	}
	return lines;
}

function matchesTarget(target: RouteTarget, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => matchesPattern(target.id, pattern) || matchesPattern(target.model.id, pattern));
}

export function hasRuleFilters(rule: RoutingRule): boolean {
	return Boolean(rule.then.only || rule.then.exclude || rule.then.minimumTier);
}

/** Applies the hard filters (`only`, `exclude`, `minimumTier`) of a rule. */
export function filterTargetsByRule(
	targets: readonly RouteTarget[],
	rule: RoutingRule,
	capabilityOptions?: CapabilityOptions,
): RouteTarget[] {
	const { only, exclude, minimumTier } = rule.then;
	return targets.filter((target) =>
		(!only || matchesTarget(target, only)) &&
		(!exclude || !matchesTarget(target, exclude)) &&
		(!minimumTier || tierRank(deriveCapabilityPrior(target.model, capabilityOptions).overall) >= tierRank(minimumTier)),
	);
}

export function preferredTargetIds(targets: readonly RouteTarget[], rule: RoutingRule | undefined): Set<string> {
	const prefer = rule?.then.prefer;
	return new Set(prefer ? targets.filter((target) => matchesTarget(target, prefer)).map((target) => target.id) : []);
}

export function describeRule(rule: RoutingRule): string {
	const format = (entries: [string, unknown][]) => entries.map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("|") : String(value)}`);
	return `${rule.name}: when ${format(Object.entries(rule.when)).join(", ") || "always"} → ${format(Object.entries(rule.then)).join(", ")}`;
}
