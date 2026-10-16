# Real-task evaluation

The report command compares recorded results. It does not run Pi, send model requests, or execute commands from the input file. The bundled example is synthetic; no real-model savings or quality claim follows from it.

## Collect comparable runs

1. Choose versioned repository snapshots and tasks with an executable acceptance test. Start with bug fixes, small feature changes, refactors, test additions, long-context investigations, and recovery after a tool failure. Keep calibration tasks separate from held-out evaluation tasks.
2. Run each task in separate clean checkouts/sessions: once through `pi-auto-model/auto`, once with a fixed concrete model. Keep prompt, tools, initial repository revision, acceptance tests, provider access and termination/spending limits the same. Record model IDs and a reproducible configuration identifier, including Pi/plugin versions. Alternate run order to reduce timing bias.
3. Evaluate the final artifact, not the model's claim. Record the exact test command and its result, or a documented human review rubric. A model response or a successful individual tool call is not proof of task completion. Mark unfinished or unassessed runs `unknown`, and user-aborted runs `cancelled`.
4. Record elapsed time and complete reported cost, including classifier, compaction, failed attempts and retries. `/auto-model task` and event exports help with routed runs. For fixed-model baselines collect equivalent provider usage across the whole run. If any cost is unknown, omit `costUsd`; do not substitute the router's estimate or treat it as free. Include auxiliary work outside the active run if it was needed for the experiment.
5. Write one JSON object per line and run `npm run eval:tasks -- runs.jsonl`. Review both success-rate change and cost per success. A lower cost with materially worse completion is not an improvement.

## Input

Each pair needs the same `taskId` and `revision`, with exactly one `router` and one `baseline` record. Use distinct task IDs for repeated trials, shared by both variants. `configId` identifies the exact settings for that run; `models` lists all attempted real models. `evidence` is required for `success` and `failure`.

```json
{"taskId":"bugfix-17-trial-1","revision":"repository-commit-sha","variant":"router","configId":"saved-router-config-and-versions","models":["provider/model"],"outcome":"unknown","durationMs":120000}
{"taskId":"bugfix-17-trial-1","revision":"repository-commit-sha","variant":"baseline","configId":"saved-baseline-config-and-versions","models":["provider/fixed-model"],"outcome":"unknown","durationMs":120000}
```

These are schema examples, not measured data. For a fully synthetic demonstration:

```text
npm run eval:tasks -- test/fixtures/task-eval.example.jsonl
```

The report includes paired sample count; success, failure, cancellation and unknown counts; total reported cost; total cost divided by successful tasks (including failed-run costs); and duration p50/p95. Unknown outcomes suppress success-rate comparison; unknown costs or outcomes suppress cost-per-success comparison. A zero-success baseline has no defined cost per success. Results are descriptive, not a statistical guarantee. Publish sample size, unknown coverage, task provenance and acceptance evidence with any reported gain.
