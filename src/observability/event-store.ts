import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileLock } from "../storage/file-lock.ts";

export type UnifiedEventKind =
	| "request"
	| "route_decision"
	| "provider_response"
	| "usage_actual"
	| "quota_observation"
	| "budget_usage"
	| "failover"
	| "user_feedback"
	| "task_summary"
	| "task_outcome"
	| "tool_failure";

export interface UnifiedEvent {
	id: string;
	requestId?: string;
	sessionId?: string;
	kind: UnifiedEventKind;
	at: number;
	targetId?: string;
	provider?: string;
	modelId?: string;
	taskKinds?: string[];
	status?: number;
	latencyMs?: number;
	costUsd?: number;
	success?: boolean;
	source?: string;
	metadata?: Record<string, string | number | boolean | undefined>;
}

export interface EventQuery {
	requestId?: string;
	kind?: UnifiedEventKind;
	since?: number;
	until?: number;
	limit?: number;
}

export class UnifiedEventStore {
	private readonly events: UnifiedEvent[] = [];
	private loaded = false;
	private writeChain: Promise<void> = Promise.resolve();
	private unwritten: UnifiedEvent[] = [];
	private persistedCount = 0;
	private readonly filePath: string;
	private readonly maxEvents: number;

	constructor(filePath: string, maxEvents = 10_000) {
		this.filePath = filePath;
		this.maxEvents = maxEvents;
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		let read = false;
		const readHistory = async (): Promise<void> => {
			const contents = await readFile(this.filePath, "utf8");
			read = true;
			for (const line of contents.split(/\r?\n/)) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line) as UnifiedEvent;
					if (typeof event.id === "string" && typeof event.kind === "string" && typeof event.at === "number") {
						this.events.push(event);
						this.persistedCount++;
					}
				} catch {
					// Ignore malformed local history records.
				}
			}
			this.trim();
		};
		try {
			await mkdir(dirname(this.filePath), { recursive: true });
			await withFileLock(`${this.filePath}.lock`, async () => {
				await readHistory();
				if (this.persistedCount > this.maxEvents) await this.compact();
			});
		} catch (error) {
			// Missing history is a normal first run. A busy lock only skips compaction:
			// reading without the lock is still safe, so history stays available.
			if (read || (error as NodeJS.ErrnoException).code === "ENOENT") return;
			await readHistory().catch(() => {});
		}
	}

	record(event: UnifiedEvent): void {
		this.events.push({ ...event });
		this.trim();
		this.unwritten.push({ ...event });
		// One queued drain writes every event recorded before it runs, under a single lock.
		if (this.unwritten.length > 1) return;
		this.writeChain = this.writeChain.catch(() => {}).then(() => this.drain());
		void this.writeChain.catch(() => {});
	}

	private async drain(): Promise<void> {
		const batch = this.unwritten;
		this.unwritten = [];
		if (batch.length === 0) return;
		await mkdir(dirname(this.filePath), { recursive: true });
		await withFileLock(`${this.filePath}.lock`, async () => {
			await appendFile(this.filePath, batch.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
			this.persistedCount += batch.length;
			if (this.persistedCount > this.maxEvents * 2) await this.compact();
		});
	}

	query(query: EventQuery = {}): UnifiedEvent[] {
		const values = this.events.filter((event) =>
			(query.requestId === undefined || event.requestId === query.requestId) &&
			(query.kind === undefined || event.kind === query.kind) &&
			(query.since === undefined || event.at >= query.since) &&
			(query.until === undefined || event.at <= query.until),
		);
		const limit = Math.max(1, query.limit ?? 100);
		return values.slice(-limit).map((event) => ({ ...event }));
	}

	async exportTo(filePath: string, format: "json" | "jsonl" = "json"): Promise<void> {
		await mkdir(dirname(filePath), { recursive: true });
		const contents = format === "json"
			? `${JSON.stringify(this.events, null, 2)}\n`
			: this.events.map((event) => JSON.stringify(event)).join("\n") + "\n";
		await writeFile(filePath, contents, "utf8");
	}

	async flush(): Promise<void> {
		return this.writeChain;
	}

	/** Caller holds the file lock; compact disk history, never a process-local snapshot. */
	private async compact(): Promise<void> {
		const lines = (await readFile(this.filePath, "utf8")).split(/\r?\n/).filter((line) => line.trim()).slice(-this.maxEvents);
		const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
		await writeFile(temporaryPath, lines.join("\n") + "\n", "utf8");
		await rename(temporaryPath, this.filePath);
		this.persistedCount = lines.length;
	}

	private trim(): void {
		if (this.events.length > this.maxEvents) {
			this.events.splice(0, this.events.length - this.maxEvents);
		}
	}
}
