import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { UnifiedEventStore } from "../src/observability/event-store.ts";

test("persists, queries, and exports correlated events", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-events-"));
	const path = join(dir, "events.jsonl");
	const store = new UnifiedEventStore(path);
	store.record({ id: "request-1", requestId: "r1", kind: "request", at: 1 });
	store.record({ id: "route-1", requestId: "r1", kind: "route_decision", at: 2, targetId: "p/m" });
	await store.flush();
	assert.equal(store.query({ requestId: "r1" }).length, 2);

	const restored = new UnifiedEventStore(path);
	await restored.load();
	assert.equal(restored.query({ kind: "route_decision" })[0].targetId, "p/m");
	const exportPath = join(dir, "export.json");
	await restored.exportTo(exportPath);
	assert.match(await readFile(exportPath, "utf8"), /route_decision/);
});

test("compacts persisted history and recovers after a transient write failure", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-events-"));
	const path = join(dir, "events.jsonl");
	await writeFile(path, Array.from({ length: 5 }, (_, at) => JSON.stringify({ id: `e${at}`, kind: "request", at })).join("\n") + "\n");
	const compacted = new UnifiedEventStore(path, 2);
	await compacted.load();
	assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 2);
	for (let at = 5; at < 10; at++) compacted.record({ id: `e${at}`, kind: "request", at });
	await compacted.flush();
	assert.ok((await readFile(path, "utf8")).trim().split("\n").length <= 4);

	const blocker = join(dir, "blocker");
	await writeFile(blocker, "not a directory");
	const recovering = new UnifiedEventStore(join(blocker, "events.jsonl"));
	recovering.record({ id: "failed", kind: "request", at: 1 });
	await assert.rejects(recovering.flush());
	await unlink(blocker);
	await mkdir(blocker);
	recovering.record({ id: "recovered", kind: "request", at: 2 });
	await recovering.flush();
	assert.match(await readFile(join(blocker, "events.jsonl"), "utf8"), /recovered/);
});

test("batches queued events and still loads history when the lock stays busy", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-events-busy-"));
	const path = join(dir, "events.jsonl");
	const store = new UnifiedEventStore(path);
	for (let at = 0; at < 50; at++) store.record({ id: `e${at}`, kind: "request", at });
	await store.flush();
	assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 50);
	await writeFile(`${path}.lock`, "held by another process");
	const restored = new UnifiedEventStore(path);
	await restored.load();
	assert.equal(restored.query({ limit: 100 }).length, 50);
});

test("rollover preserves the newest events from another writer", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-events-shared-"));
	const path = join(dir, "events.jsonl");
	const first = new UnifiedEventStore(path, 2);
	await first.load();
	for (let at = 0; at < 4; at++) first.record({ id: `a${at}`, kind: "request", at });
	await first.flush();
	await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
		import { UnifiedEventStore } from ${JSON.stringify(new URL("../src/observability/event-store.ts", import.meta.url).href)};
		const store = new UnifiedEventStore(process.argv[1], 2);
		await store.load();
		store.record({ id: "b4", kind: "request", at: 4 });
		await store.flush();
	`, path]);
	first.record({ id: "a5", kind: "request", at: 5 });
	await first.flush();
	const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line).id);
	assert.deepEqual(lines, ["b4", "a5"]);
});
