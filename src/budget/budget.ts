import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RouteTarget, TaskProfile } from "../types.ts";
import { withFileLock } from "../storage/file-lock.ts";

export type BudgetAction = "allow" | "warn" | "avoid" | "downgrade" | "block";

export interface ProviderBudgetLimit {
	dailyUsd?: number;
	monthlyUsd?: number;
	onExceed?: Exclude<BudgetAction, "allow">;
}

export interface BudgetConfig {
	maxUsdPerTask?: number;
	sessionUsd?: number;
	dailyUsd?: number;
	monthlyUsd?: number;
	onExceed?: Exclude<BudgetAction, "allow">;
	providers?: Record<string, ProviderBudgetLimit>;
}

export interface BudgetUsageSnapshot {
	dayKey: string;
	monthKey: string;
	sessionKey?: string;
	sessionUsd?: number;
	sessions?: Record<string, number>;
	dailyUsd: number;
	monthlyUsd: number;
	providers: Record<string, {
		dailyUsd: number;
		monthlyUsd: number;
	}>;
	history?: BudgetUsageBucket[];
}

export interface BudgetUsageBucket {
	startAt: number;
	usd: number;
	providers: Record<string, number>;
}

export interface BudgetDecision {
	action: BudgetAction;
	exceeded: string[];
}

export interface BudgetReservation {
	provider: string;
	estimate: number;
	at: number;
	sessionId: string;
}

export function estimateCost(
	target: RouteTarget,
	inputTokens: number,
	profile: TaskProfile,
	/** Resolved price rates (USD per 1M); defaults to the registry `model.cost`. */
	price?: { input: number; output: number },
): number {
	const rates = price ?? target.model.cost;
	return (
		inputTokens * rates.input +
		profile.constraints.requiredOutputTokens * rates.output
	) / 1_000_000;
}

export function evaluateBudget(estimate: number, config: BudgetConfig = {}): BudgetAction {
	if (config.maxUsdPerTask === undefined || estimate <= config.maxUsdPerTask) return "allow";
	return config.onExceed ?? "downgrade";
}

const ACTION_RANK: Record<BudgetAction, number> = {
	allow: 0,
	warn: 1,
	avoid: 2,
	downgrade: 3,
	block: 4,
};

export function strongerBudgetAction(left: BudgetAction, right: BudgetAction): BudgetAction {
	return ACTION_RANK[left] >= ACTION_RANK[right] ? left : right;
}

export function evaluateGlobalBudget(
	estimate: number,
	provider: string,
	config: BudgetConfig,
	usage: BudgetUsageSnapshot,
): BudgetDecision {
	const exceeded: string[] = [];
	const providerLimit = config.providers?.[provider];
	const providerUsage = usage.providers[provider];
	let action: BudgetAction = evaluateBudget(estimate, config);
	if (config.maxUsdPerTask !== undefined && estimate > config.maxUsdPerTask) {
		exceeded.push("task");
	}

	if (config.sessionUsd !== undefined && (usage.sessionUsd ?? 0) + estimate > config.sessionUsd) {
		exceeded.push("session");
		action = strongerBudgetAction(action, config.onExceed ?? "downgrade");
	}
	if (config.dailyUsd !== undefined && usage.dailyUsd + estimate > config.dailyUsd) {
		exceeded.push("daily");
		action = strongerBudgetAction(action, config.onExceed ?? "downgrade");
	}
	if (config.monthlyUsd !== undefined && usage.monthlyUsd + estimate > config.monthlyUsd) {
		exceeded.push("monthly");
		action = strongerBudgetAction(action, config.onExceed ?? "downgrade");
	}
	if (providerLimit?.dailyUsd !== undefined && (providerUsage?.dailyUsd ?? 0) + estimate > providerLimit.dailyUsd) {
		exceeded.push(`${provider} daily`);
		action = strongerBudgetAction(action, providerLimit.onExceed ?? config.onExceed ?? "downgrade");
	}
	if (providerLimit?.monthlyUsd !== undefined && (providerUsage?.monthlyUsd ?? 0) + estimate > providerLimit.monthlyUsd) {
		exceeded.push(`${provider} monthly`);
		action = strongerBudgetAction(action, providerLimit.onExceed ?? config.onExceed ?? "downgrade");
	}

	return { action, exceeded };
}

interface BudgetFile {
	version: 1;
	updatedAt: number;
	usage: BudgetUsageSnapshot;
}

export class BudgetLedger {
	private usage: BudgetUsageSnapshot = createUsage();
	private filePath?: string;
	private loaded = false;
	private writeChain: Promise<void> = Promise.resolve();
	private pendingWarning?: string;
	private readonly reportedWarnings = new Set<string>();

	async load(filePath: string, now = Date.now()): Promise<void> {
		this.filePath = filePath;
		if (this.loaded) return;
		await this.reloadUsage(filePath, now);
		this.loaded = true;
	}

	/** Returns a ledger problem not yet shown to the user; each distinct problem is reported once. */
	takeWarning(): string | undefined {
		const warning = this.pendingWarning;
		this.pendingWarning = undefined;
		return warning;
	}

	private warn(message: string): void {
		if (this.reportedWarnings.has(message)) return;
		this.reportedWarnings.add(message);
		this.pendingWarning = message;
	}

	private reserveInMemory(provider: string, estimate: number, config: BudgetConfig, now: number, sessionId?: string): BudgetDecision {
		if (sessionId) this.startSession(sessionId, now);
		const decision = this.evaluate(estimate, provider, config, now);
		if (decision.action !== "block" && decision.action !== "avoid") this.record(provider, estimate, now);
		return decision;
	}

	/** Budget tracking must never stop routing: shared-file failures fall back to in-memory usage. */
	private async withSharedLedger(filePath: string, action: () => Promise<void>, fallback: () => void): Promise<void> {
		let entered = false;
		try {
			await mkdir(dirname(filePath), { recursive: true });
			await withFileLock(`${filePath}.lock`, async () => {
				entered = true;
				await action();
			});
		} catch (error) {
			this.warn(`Pi Auto Model: shared budget ledger ${filePath} is unavailable (${errorText(error)}); budget tracking continues in memory.`);
			if (!entered) fallback();
		}
	}

	private async persistSafely(now: number): Promise<void> {
		try {
			await this.persist(now);
		} catch (error) {
			this.warn(`Pi Auto Model: cannot save budget ledger ${this.filePath} (${errorText(error)}); budget tracking continues in memory.`);
		}
	}

	async reserve(
		provider: string,
		estimate: number,
		config: BudgetConfig,
		now = Date.now(),
		sessionId = this.usage.sessionKey,
	): Promise<BudgetDecision> {
		if (!this.filePath) return this.reserveInMemory(provider, estimate, config, now, sessionId);
		await this.writeChain.catch(() => {});
		const filePath = this.filePath;
		let decision!: BudgetDecision;
		await this.withSharedLedger(filePath, async () => {
			await this.reloadUsage(filePath, now);
			if (sessionId) {
				this.usage.sessionKey = sessionId;
				this.usage.sessionUsd = this.usage.sessions?.[sessionId] ?? 0;
			}
			decision = this.evaluate(estimate, provider, config, now);
			if (decision.action !== "block" && decision.action !== "avoid") {
				this.record(provider, estimate, now);
				await this.persistSafely(now);
			}
		}, () => { decision = this.reserveInMemory(provider, estimate, config, now, sessionId); });
		return decision;
	}

	/** Replace one reservation with observed cost, in its original accounting windows. */
	async reconcile(reservation: BudgetReservation, actualCost: number, now = Date.now()): Promise<void> {
		if (!Number.isFinite(actualCost) || actualCost < 0) throw new Error("Invalid actual cost");
		const apply = (): void => {
			this.rotate(now);
			const delta = actualCost - reservation.estimate;
			const period = localPeriodKeys(reservation.at);
			const provider = this.usage.providers[reservation.provider] ?? { dailyUsd: 0, monthlyUsd: 0 };
			if (this.usage.dayKey === period.dayKey) {
				this.usage.dailyUsd = Math.max(0, this.usage.dailyUsd + delta);
				provider.dailyUsd = Math.max(0, provider.dailyUsd + delta);
			}
			if (this.usage.monthKey === period.monthKey) {
				this.usage.monthlyUsd = Math.max(0, this.usage.monthlyUsd + delta);
				provider.monthlyUsd = Math.max(0, provider.monthlyUsd + delta);
			}
			this.usage.providers[reservation.provider] = provider;
			const sessions = this.usage.sessions ??= {};
			sessions[reservation.sessionId] = Math.max(0, (sessions[reservation.sessionId] ?? 0) + delta);
			if (this.usage.sessionKey === reservation.sessionId) this.usage.sessionUsd = sessions[reservation.sessionId];
			const bucket = this.usage.history?.find((entry) => entry.startAt === Math.floor(reservation.at / 3_600_000) * 3_600_000);
			if (bucket) {
				bucket.usd = Math.max(0, bucket.usd + delta);
				bucket.providers[reservation.provider] = Math.max(0, (bucket.providers[reservation.provider] ?? 0) + delta);
			}
		};
		if (!this.filePath) return apply();
		const filePath = this.filePath;
		await this.writeChain.catch(() => {});
		await this.withSharedLedger(filePath, async () => {
			await this.reloadUsage(filePath, now);
			apply();
			await this.persistSafely(now);
		}, apply);
	}

	async recordShared(provider: string, estimate: number, now = Date.now()): Promise<void> {
		if (!this.filePath) return this.record(provider, estimate, now);
		await this.writeChain.catch(() => {});
		const filePath = this.filePath;
		await this.withSharedLedger(filePath, async () => {
			const sessionKey = this.usage.sessionKey;
			await this.reloadUsage(filePath, now);
			if (sessionKey) {
				this.usage.sessionKey = sessionKey;
				this.usage.sessionUsd = this.usage.sessions?.[sessionKey] ?? 0;
			}
			this.record(provider, estimate, now);
			await this.persistSafely(now);
		}, () => this.record(provider, estimate, now));
	}

	startSession(sessionKey: string, now = Date.now()): void {
		this.rotate(now);
		this.usage.sessionKey = sessionKey;
		this.usage.sessionUsd = this.usage.sessions?.[sessionKey] ?? 0;
	}

	record(provider: string, estimate: number, now = Date.now()): void {
		this.rotate(now);
		const value = Math.max(0, estimate);
		this.usage.sessionUsd = (this.usage.sessionUsd ?? 0) + value;
		if (this.usage.sessionKey) {
			this.usage.sessions = {
				...(this.usage.sessions ?? {}),
				[this.usage.sessionKey]: this.usage.sessionUsd,
			};
		}
		this.usage.dailyUsd += value;
		this.usage.monthlyUsd += value;
		const providerUsage = this.usage.providers[provider] ?? { dailyUsd: 0, monthlyUsd: 0 };
		providerUsage.dailyUsd += value;
		providerUsage.monthlyUsd += value;
		this.usage.providers[provider] = providerUsage;
		const bucketStart = Math.floor(now / 3_600_000) * 3_600_000;
		const history = this.usage.history ?? [];
		const bucket = history.find((entry) => entry.startAt === bucketStart) ?? {
			startAt: bucketStart,
			usd: 0,
			providers: {},
		};
		bucket.usd += value;
		bucket.providers[provider] = (bucket.providers[provider] ?? 0) + value;
		this.usage.history = [
			...history.filter((entry) => entry.startAt !== bucketStart),
			bucket,
		].sort((left, right) => left.startAt - right.startAt).slice(-24 * 90);
	}

	evaluate(
		estimate: number,
		provider: string,
		config: BudgetConfig,
		now = Date.now(),
		sessionId = this.usage.sessionKey,
	): BudgetDecision {
		this.rotate(now);
		return evaluateGlobalBudget(estimate, provider, config, {
			...this.usage, sessionUsd: sessionId ? this.usage.sessions?.[sessionId] ?? 0 : this.usage.sessionUsd,
		});
	}

	snapshot(now = Date.now()): BudgetUsageSnapshot {
		this.rotate(now);
		return {
			...this.usage,
			providers: Object.fromEntries(
				Object.entries(this.usage.providers).map(([provider, value]) => [provider, { ...value }]),
			),
			history: (this.usage.history ?? []).map((entry) => ({
				...entry,
				providers: { ...entry.providers },
			})),
		};
	}

	async flush(now = Date.now()): Promise<void> {
		if (!this.filePath) return;
		this.writeChain = this.writeChain.catch(() => {}).then(async () => {
			await this.persist(now);
		});
		return this.writeChain;
	}

	private async persist(now: number): Promise<void> {
		if (!this.filePath) return;
		const payload: BudgetFile = { version: 1, updatedAt: Date.now(), usage: this.snapshot(now) };
		const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		await rename(temporaryPath, this.filePath);
	}

	/** Never throws: unreadable or damaged ledgers keep the in-memory usage instead of resetting it. */
	private async reloadUsage(filePath: string, now: number): Promise<void> {
		let text: string;
		try {
			text = await readFile(filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.usage = createUsage(now);
				return;
			}
			this.warn(`Pi Auto Model: cannot read budget ledger ${filePath} (${errorText(error)}); budget tracking continues in memory.`);
			return;
		}
		const usage = parseLedger(text, now);
		if (usage) {
			this.usage = usage;
			return;
		}
		const backupPath = `${filePath}.corrupt-${now}`;
		const moved = await rename(filePath, backupPath).then(() => true, () => false);
		// Rewrite at once: a missing ledger would otherwise read as "no spend" on the next reload.
		if (moved) await this.persistSafely(now);
		this.warn(`Pi Auto Model: budget ledger ${filePath} was damaged${moved ? ` and was saved as ${backupPath}` : ""}; budget tracking continues from in-memory usage.`);
	}

	private rotate(now: number): void {
		const current = createUsage(now);
		if (this.usage.dayKey !== current.dayKey) {
			this.usage.dayKey = current.dayKey;
			this.usage.dailyUsd = 0;
			for (const value of Object.values(this.usage.providers)) value.dailyUsd = 0;
		}
		if (this.usage.monthKey !== current.monthKey) {
			this.usage.monthKey = current.monthKey;
			this.usage.monthlyUsd = 0;
			for (const value of Object.values(this.usage.providers)) value.monthlyUsd = 0;
		}
	}
}

function createUsage(now = Date.now()): BudgetUsageSnapshot {
	const period = localPeriodKeys(now);
	return {
		...period,
		sessionUsd: 0,
		sessions: {},
		dailyUsd: 0,
		monthlyUsd: 0,
		providers: {},
		history: [],
	};
}

function localPeriodKeys(now: number): Pick<BudgetUsageSnapshot, "dayKey" | "monthKey"> {
	const date = new Date(now);
	const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
	return { monthKey, dayKey: `${monthKey}-${String(date.getDate()).padStart(2, "0")}` };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAmount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseLedger(text: string, now: number): BudgetUsageSnapshot | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || parsed.version !== 1) return undefined;
	return normalizeUsage(parsed.usage, now);
}

/**
 * Only the period keys and period totals are required; a ledger without them
 * cannot be trusted. Optional or per-entry fields that are invalid are dropped
 * individually so one bad entry does not discard the whole ledger.
 */
function normalizeUsage(value: unknown, now: number): BudgetUsageSnapshot | undefined {
	if (!isRecord(value) || typeof value.dayKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.dayKey) ||
		value.dayKey.slice(0, 7) !== value.monthKey || !isAmount(value.dailyUsd) || !isAmount(value.monthlyUsd)) {
		return undefined;
	}
	const usage: BudgetUsageSnapshot = {
		...createUsage(now),
		dayKey: value.dayKey,
		monthKey: value.dayKey.slice(0, 7),
		sessionKey: typeof value.sessionKey === "string" ? value.sessionKey : undefined,
		sessionUsd: isAmount(value.sessionUsd) ? value.sessionUsd : 0,
		sessions: Object.fromEntries(Object.entries(isRecord(value.sessions) ? value.sessions : {})
			.filter((entry): entry is [string, number] => isAmount(entry[1]))),
		dailyUsd: value.dailyUsd,
		monthlyUsd: value.monthlyUsd,
		providers: {},
		history: Array.isArray(value.history)
			? value.history
				.filter((entry): entry is BudgetUsageBucket =>
					isRecord(entry) && typeof entry.startAt === "number" && Number.isFinite(entry.startAt) && isAmount(entry.usd))
				.map((entry) => ({
					startAt: entry.startAt,
					usd: entry.usd,
					providers: Object.fromEntries(Object.entries(isRecord(entry.providers) ? entry.providers : {})
						.filter((item): item is [string, number] => isAmount(item[1]))),
				}))
				.slice(-24 * 90)
			: [],
	};
	for (const [provider, limits] of Object.entries(isRecord(value.providers) ? value.providers : {})) {
		if (!isRecord(limits)) continue;
		usage.providers[provider] = {
			dailyUsd: isAmount(limits.dailyUsd) ? limits.dailyUsd : 0,
			monthlyUsd: isAmount(limits.monthlyUsd) ? limits.monthlyUsd : 0,
		};
	}
	return usage;
}
