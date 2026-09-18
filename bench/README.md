# omp-typesafe bench

Benchmarks the omp-typesafe extension's advisory vs adversarial role, on
execution tasks vs plan-mode tasks, against a role-disabled baseline. See
`/Users/siddicky/.claude/plans/shimmying-soaring-karp.md` for the full
design rationale; this file covers day-to-day usage.

## Prerequisites

- `bun` on PATH (fixtures and the harness itself are bun/TypeScript).
- `omp` on PATH (v18.2.4 confirmed compatible).
- `claude` CLI on PATH and logged in — used as the blind plan judge.
- `TYPESAFE_API_KEY` set in `~/.config/agent-secrets.env` (the `export
  TYPESAFE_API_KEY=...` line uncommented). `run.ts` sources it itself; it is
  never printed to logs.

## Layout

```
bench/
  lib/            shared helpers: global-config reader, overlay writer,
                   fixture prep, omp process runner, session/usage parsing,
                   the common deterministic grader
  tasks/<id>/
    fixture/       seed repo (bun test suite included)
    task.json       { id, execPrompt, planPrompt, rubric, checklist,
                       forbiddenFiles?, requiredGrep?, forbiddenGrep? }
    grade.ts        exports grade(cwd) -> { score, success, checks }
  run.ts          matrix runner (see below)
  grade-plan.ts   plan-side grading: checklist regex + LLM judge, cached
  report.ts       aggregate runs.jsonl -> report.md
  results/        gitignored; one dir per run, created at run time
```

## Running

Smoke a single task across all 6 cells (3 roles x 2 types):

```sh
bun run bench/run.ts --dry-run --reps 1 --tasks rename-callsite
```

Real single-task smoke run:

```sh
bun run bench/run.ts --reps 1 --tasks rename-callsite
```

Full smoke (all 6 tasks, 1 rep = 36 runs):

```sh
bun run bench/run.ts --reps 1
```

Full measurement (3 reps = 108 runs, per the parent plan's budget):

```sh
bun run bench/run.ts --reps 3
```

Flags: `--tasks a,b` (default all), `--roles off,advisory,adversarial`
(default all), `--types exec,plan` (default both), `--model <id>` (default:
`modelRoles.default` from `~/.omp/agent/config.yml`), `--concurrency N`
(default 2), `--max-time 10m` (per-run omp timeout), `--dry-run` (print
commands, run nothing).

Each run writes `bench/results/<runId>/runs.jsonl` (one row per cell) plus a
per-cell directory under `bench/results/<runId>/runs/<task>-<role>-<type>-<rep>/`
containing the copied+committed fixture (`repo/`), the config overlay, omp's
session JSONL, stdout/stderr, `meta.json`, and (for non-`off` roles) the
extension's `typesafe.json` telemetry dump.

## Grading

- **Execution** (`grade.ts` per task): runs `bun test` in the run's repo
  copy, diffs `forbiddenFiles` against the seed commit, and checks
  `requiredGrep`/`forbiddenGrep` via `git grep`. `run.ts` calls this
  automatically after every cell and records `score`/`success`/`checks` in
  `runs.jsonl`.
- **Plan** (plan-type cells only): re-grade any run directory on demand with
  `bun run bench/grade-plan.ts <runDir> <taskDir>`. It finds the newest
  `.md` under `<runDir>/plans/` (falling back to `<runDir>/repo/PLAN.md` if
  the `--plan-yolo` fallback documented in the parent plan's Phase 0 is in
  effect), scores the task's `checklist` regexes against the plan text, and
  sends the plan text plus the task's `rubric` (nothing else — no role, no
  notes) to `claude -p --model claude-opus-5 --output-format json` for a
  blind yes/no judgement per rubric item. Judge calls are cached by
  `sha256(planText + rubric)` under `bench/results/judge-cache/`.

## Reporting

```sh
bun run bench/report.ts bench/results/<runId>
```

Produces `bench/results/<runId>/report.md`: per-(role,type) mean
success/score with 95% bootstrap CIs, median wall time, mean tokens (parsed
from `--mode json` stdout when a usage event is present, else `n/a` — see
the "known limits" note below), mean reviewer notes/run, would-ask rate and
mean ambiguity at propose (plan cells only), the advisory-vs-adversarial and
vs-`off` contrasts within each task type, an "Ambiguity gate" table listing
per-task ambiguity at propose and the weakest dimension, and a per-task
success-rate breakdown.

### Ambiguity gate columns

- **would-ask rate**: fraction of runs in that (role, type) cell where the
  extension's ambiguity telemetry recorded at least one `steer`, `block`, or
  `would_block` decision (see `wouldAsk` in `lib/telemetry.ts`).
- **mean ambiguity at propose**: mean of each run's last `propose`-trigger
  ambiguity score (`ambiguityAtPropose` in `lib/telemetry.ts`); shown only
  for plan-type cells, `n/a` if no run in the cell carries the field.
- **Ambiguity gate table**: per (task, role, rep) row with the ambiguity
  score at propose, the weakest dimension (`goal`/`constraints`/`criteria`/
  `context`), and the gate decision, for plan-type non-`off` runs.

All of the above are null-safe: the `ambiguity` field on `typesafe.json` is
optional (absent on runs recorded before the extension added the gate), and
rows without it are simply excluded from means and omitted from the gate
table rather than causing an error.

## Env-var contract with the extension

- `TYPESAFE_ROLE=advisory|adversarial` — selects the role for non-`off` cells.
- `TYPESAFE_REVIEW_ENABLED=0` — the `off` baseline.
- `TYPESAFE_BENCH_LOG=<run dir>/typesafe.json` — the extension writes
  `{ role, stats, usage, costUsd, history, ambiguity? }` here on
  `session_shutdown`. `ambiguity` is optional (absent on older extension
  builds); when present it is
  `{ scores: [{ ts, trigger, ambiguity, dims, weakest, gap, userCanAnswer,
  decision }], asksObserved }`, one `scores` entry per gate checkpoint
  (`trigger` is `plan_start`, `turn_end`, or `propose`; `decision` is
  `steer`, `block`, `would_block`, or `none`).
- `TYPESAFE_AMBIGUITY_GATE` — set by the extension's own env-var contract to
  enable/disable the ambiguity gate (e.g. `TYPESAFE_AMBIGUITY_GATE=0` to
  disable it); the bench harness does not set this itself but passes through
  whatever the invoking environment provides.
- `TYPESAFE_AMBIGUITY_THRESHOLD` — the extension's ambiguity score threshold
  above which it steers/blocks; also passed through unset by the harness.

This contract is defined in the parent plan's Phase 1.4 and is being
implemented in the extension (`src/index.ts`) in parallel with this harness.

## Known limits / unverified items

- **Usage/token extraction is best-effort.** The exact `--mode json` usage
  event shape was unverified at harness-build time (parent plan Phase 0 step
  4 was not yet run against this harness). `lib/session.ts`'s
  `extractUsageFromStdout` scans for common field names and returns `null`
  rather than guessing when nothing matches; `report.ts` shows `n/a` in that
  case. Revisit once Phase 0 is confirmed.
- **`lib/config.ts` is a targeted line scanner, not a full YAML parser.** It
  only extracts `disabledExtensions` (a flat top-level list) and
  `modelRoles.default` from `~/.omp/agent/config.yml`. If that file's shape
  changes materially (e.g. `disabledExtensions` becomes nested), update the
  scanner.
- **The `--plan-yolo` path is exercised by `run.ts` but not yet confirmed
  against a real omp session** in this pass — that depends on Phase 0
  verification and the Phase 1 extension work landing. If `--plan-yolo`
  turns out not to autosave to `<cwd>/.omp/plans/` as documented, switch the
  `type: plan` branch in `run.ts`'s `argvForCell` to the fallback described
  in the parent plan (normal mode + `--tools read,grep,glob,write` + a
  prompt demanding `PLAN.md`); `grade-plan.ts` already has that fallback
  built in via its `PLAN.md` check.
- Grading assumes `bun test`'s exit code is 0 only on a clean pass, which
  was confirmed by hand for all 6 fixtures.
