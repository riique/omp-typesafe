# omp-typesafe

A reviewer for the [omp](https://omp.sh/docs) coding agent, powered by Jev through omp's native judgment API.
It follows omp's advisor pattern — a second set of eyes that watches the session as it unfolds — in one of two
roles, set by `role` in config (default `adversarial`). The reviewer resolves `@judge` through omp's model-role
configuration, so `modelRoles.judge: openrouter/~typesafe/jev-latest` uses OpenRouter's native decisions endpoint
and the credentials already configured in omp.

- **`adversarial`** (default): argues the other side — that the last action or claim is wrong, unverified, or
  incomplete.
- **`advisory`**: mirrors omp's native advisor's helpful-reviewer framing — worth-checking steps, simpler
  alternatives, missed related updates, ambiguities worth clarifying, and unconsidered requirements.

Delivery (which channel a note goes out on, when it steers, dedupe, budgets) is identical between roles; only
the question battery and note wording differ. Notes from either role are advisory; nothing is ever blocked.

It also registers a `typesafe_ask` tool exposing all three native judgment question types (`noul`, `choice`, and `score`) for direct use.

## What it watches

| Trigger                                                                               | What Jev judges                                                                                                                 |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `tool_result` (edit, write, apply_patch, ast_edit, bash, eval, notebook, debug, task) | `breaks_contract`, `unfounded_assumption`, `incomplete_cutover`, `not_what_was_asked`, `unverified_claim`, `hidden_destruction` |
| `message_end` (assistant messages ≥ 200 chars)                                        | `unsupported_claim`, `requirement_missed`, `risky_api`, `weak_verification`, `unnecessary_complexity`                           |
| `turn_end` (transcript delta since last review)                                       | `requirement_missed`, `weak_verification`, `unnecessary_complexity`, `silent_scope_reduction`, `risky_api`                      |

Every battery ends with a shared severity score (`Nothing to raise` → `Nit` → `Concern` → `Blocker`) and a
`defect_class` choice. Because Jev has no tools, the extension gathers evidence deterministically before asking:
`git status`, `git diff`, and a **missed-callsite probe** — identifiers removed by the diff are `git grep`'d so
surviving references show up in the note.

Notes look like:

```
<adversarial-note severity="concern" defect="contract_break" guidance="weigh, don't blindly obey"
  breaks_contract="0.89" incomplete_cutover="0.85" confidence="0.63"
  evidence="2 uncommitted files; git grep fetchUser → b.ts:1:import {fetchUser} from './a';">
Adversarial review of the last action flags contract_break (breaks_contract, incomplete_cutover). Verify or refute before building on this.
</adversarial-note>
```

Delivery mirrors the native advisor: `nit` → aside (off by default), `concern` → steer while working / next turn
when idle, `blocker` → interrupting steer. Action notes are also attached inline to the tool result. An emission
guard keeps it from becoming noise: severity-aware semantic dedupe (same questions firing again at equal or lower
severity is dropped; escalation passes once), immune turns after a steer, and a per-turn call budget.

With `role: "advisory"`, the same triggers instead judge `worth_checking`, `simpler_alternative`,
`related_update_needed`, `should_clarify`, `missing_consideration`, and a positive-polarity `on_track` noul; a
severity score with the native advisor's own vocabulary (`Nothing to add` → `Nit` → `Concern` → `Blocker`); and a
`theme` choice in place of `defect_class`. A step the reviewer agrees is sound (`on_track >= 0.75`) suppresses
anything below a blocker — advisory notes are emitted only when there is genuinely something to raise. Notes look
like:

```
<advisory advisor="TypeSafe" severity="concern" guidance="weigh, don't blindly obey"
  theme="update_callers" related_update_needed="0.81" evidence="...">
Another file, caller, or test likely needs a matching change for this step to be complete (related_update_needed). Consider this before continuing.
</advisory>
```

`customType` distinguishes the two: `ai.typesafe.adversary` for the adversarial role, `ai.typesafe.advisory` for
the advisory role — so notes are countable per role after a run.

`phases` (`["plan", "execute"]` by default) restricts which omp mode the reviewer is active in — set it to
`["execute"]`, for example, to review only outside plan mode.

## Ambiguity gate (plan mode)

In plan mode the agent tends to settle open product questions on the user's behalf and then submit a plan built
on those silent decisions. The ambiguity gate measures how much is still genuinely undecided and, when it is too
much, pushes the model to call omp's `ask` tool instead of guessing.

One Jev call rates four dimensions on concrete five-level rubrics (0–4), normalized to 0–1 and combined with the
deep-interview brownfield weights:

```
ambiguity = 1 - (goal*0.35 + constraints*0.25 + criteria*0.25 + context*0.15)
```

| Dimension            | What is rated                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `goal_clarity`       | Is the primary objective statable in one sentence with named entities and no qualifier left to interpret? |
| `constraint_clarity` | Are the boundaries, non-goals, and limits clear enough that an out-of-scope change would be recognizable? |
| `criteria_clarity`   | Could a test be written today — trigger, expected result, failure condition?                              |
| `context_clarity`    | Is the existing code read and confirmed, and do the named entities map to real code structures?           |

Each dimension also carries a `gap_<dim>` choice naming the most likely missing piece, and one `user_can_answer`
noul that keeps the gate from asking about things the model should simply look up. The **weakest** dimension is
the one with the largest weighted shortfall `w * (1 - clarity)`; its `(dimension, gap)` pair selects a
deterministic question template, filled with the entity from the task text. The model is expected to rephrase it.

The gate steers early and blocks at submission:

| Trigger                                   | Behavior above threshold                                                                                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before_agent_start` in plan mode         | Scores the raw prompt and delivers an `<ambiguity-gate>` aside naming the weakest dimension and a drafted question.                                                                     |
| `turn_end` in plan mode                   | Rescores with the plan so far and any `ask` answers seen; re-steers only for a new weakest dimension, and never inside a steer's immune window.                                         |
| `tool_call` for `write` to `xd://propose` | With a UI, the plan submission is blocked with the drafted question in the reason. Headless there is no `ask` tool, so the attempt is recorded as `would_block` and the write proceeds. |
| `tool_result` for `ask`                   | Records the question and answer so later scores see them; no Jev call.                                                                                                                  |

Notes look like:

```
<ambiguity-gate score="0.46" threshold="0.20" weakest="constraints" gap="scope_boundary">
Ask the user before deciding: What is explicitly out of scope for rate limiter? Offer 2-4 concrete options. Use the ask tool; do not assume.
</ambiguity-gate>
```

Gate messages carry `customType: "ai.typesafe.ambiguity"`, so they are countable separately from review notes.
The gate is active only while plan mode is on (the `plan-mode-context` marker), a native judgment model resolves
from `@judge`, and fewer than `maxAsksPerPlan` asks have been observed. A Jev failure or timeout is a no-op — it
never blocks. `/adversary status` prints the resolved judge and last score, and the gate config lives under
`ambiguityGate`:

```json
"ambiguityGate": {
  "enabled": true,
  "threshold": 0.20,
  "weights": { "goal": 0.35, "constraints": 0.25, "criteria": 0.25, "context": 0.15 },
  "userCanAnswerFloor": 0.5,
  "maxAsksPerPlan": 3,
  "blockPropose": true,
  "timeoutMs": 2500
}
```

The rubric levels and the 0.20 threshold are starting points; `TYPESAFE_BENCH_LOG` telemetry (`ambiguity.scores`,
`ambiguity.asksObserved`) is the data for tuning them.

## Install

Requires omp with a native judgment model configured for the `judge` role. For OpenRouter Jev:

```yaml
modelRoles:
  judge: openrouter/~typesafe/jev-latest
```

Configure OpenRouter credentials in omp as usual. No `TYPESAFE_API_KEY` is needed; the extension uses the model
and credential resolved by omp for `@judge`. On OMP versions whose extension resolver excludes `kind: judge` from `@judge`, the plugin uses the sole authenticated native judge candidate; if more than one exists, set `typesafe_ask`'s optional `model` override or upgrade the OMP role resolver. It makes native judgment requests to OpenRouter's decisions API.

Install the maintained fork/branch after publishing it:

```sh
omp plugin install github:<your-github-user>/omp-typesafe#openrouter-native-judge --force
```

Restart omp fully after installing or replacing the extension module (`/reload-plugins` is not enough).

### Updating from upstream

The adaptation lives on the `openrouter-native-judge` branch of your fork; do not edit the installed `node_modules`
copy. To bring in upstream changes, fetch `siddicky/omp-typesafe`, merge or rebase its `main` into this branch,
resolve conflicts, run `bun test`, then push the branch to your fork and reinstall it with the command above. This
keeps the adaptation in Git and makes updates deliberate rather than overwriting local changes.

## Commands and tool

- `/adversary` — toggle for this session; `/adversary on|off|status|last|dump|role advisory|adversarial`
  (`role` overrides `role`/`TYPESAFE_ROLE` for the rest of the session; `status` reports the resolved role)
- `/typesafe test` — one fixed probe through `@judge`: noul value, resolved model/API, latency, tokens, and billed cost
- `typesafe_ask` — tool with `state` (text, or JSON with `stateFormat: "json"`) and `questions[]` of
  `{ id, type: "noul"|"choice"|"score", instructions, options?, levels?, whenTrue?, whenFalse? }`; optional `model` overrides `@judge` for that call

## Configuration

`~/.omp/agent/typesafe.json` (absent = defaults). The model is selected by omp's `modelRoles.judge`, not by this file:

```json
{
	"role": "adversarial",
	"phases": ["plan", "execute"],
	"adversary": {
		"enabled": true,
		"reviewActions": true,
		"reviewMessages": true,
		"reviewTurns": true,
		"tools": ["edit", "write", "apply_patch", "ast_edit", "bash", "eval", "notebook", "debug", "task"],
		"inlineActionNotes": true,
		"evidence": true,
		"noul_floor": 0.45,
		"concern_severity": 1.5,
		"blocker_severity": 2.5,
		"emitNits": false,
		"maxNotesPerUpdate": 4,
		"maxCallsPerTurn": 8,
		"immuneTurns": 3,
		"minMessageChars": 200,
		"timeoutMs": 1500
	},
	"stopGate": { "enabled": false, "unfinished_threshold": 0.7, "verified_floor": 0.25 }
}
```

- `role`: `"adversarial"` (default) or `"advisory"` — see [What it watches](#what-it-watches) for the difference.
- `phases`: which omp mode(s) the reviewer is active in — `"plan"`, `"execute"`, or both (default).

If review feels chatty, set `reviewMessages: false` first, then narrow `adversary.tools` to the editing tools.
`stopGate` (off by default) asks two questions when the agent wants to stop and requests an advisory continuation
when work looks unfinished or unverified.

### Environment overrides

These win over both the config file and the values above, applied in this order once the file (or its absence)
is resolved:

| Variable                       | Effect                                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TYPESAFE_CONFIG`              | An alternate config file path, read instead of `~/.omp/agent/typesafe.json`.                                                                                                                                                    |
| `TYPESAFE_ROLE`                | `"advisory"` or `"adversarial"` — overrides `role`.                                                                                                                                                                             |
| `TYPESAFE_REVIEW_ENABLED`      | `"0"`/`"false"` disables `adversary.enabled`; `"1"`/`"true"` enables it.                                                                                                                                                        |
| `TYPESAFE_AMBIGUITY_GATE`      | `"0"`/`"false"` disables `ambiguityGate.enabled`; `"1"`/`"true"` enables it.                                                                                                                                                    |
| `TYPESAFE_AMBIGUITY_THRESHOLD` | A float in `0..1` — overrides `ambiguityGate.threshold`.                                                                                                                                                                        |
| `TYPESAFE_BENCH_LOG`           | A file path. On session shutdown, writes `{ role, phases, stats, usage, costUsd, lastResolvedModel, history, ambiguity }` as JSON to it (reviewer telemetry for a single run). Unset by default; never throws on write failure. |

### Review priorities

Put an `ADVERSARY.md` at `~/.omp/agent/ADVERSARY.md`, in the repo root, or in `.omp/ADVERSARY.md` anywhere
between the git root and the working directory. Its text (capped at 2000 chars) is sent with every review as
`review_priorities`.

The advisory role (`role: "advisory"`) reads a `WATCHDOG.md` file instead, with the same discovery walk
(`~/.omp/agent/WATCHDOG.md`, then `<dir>/WATCHDOG.md` and `<dir>/.omp/WATCHDOG.md` from the git root down to the
working directory). Nothing is installed automatically: starter files for both roles live in `assets/`
(`assets/ADVERSARY.md`, `assets/WATCHDOG.md`); copy the one you want to `~/.omp/agent/` and edit it. The same
`WATCHDOG.md` is also what omp's native advisor reads, so one file can drive both reviewers.

## Cost and latency

Review latency depends on the configured judge provider. `/adversary status` shows session token usage and billed
cost reported by the native judgment API (when available). Each review uses the configured timeout and provider's
native judgment request/retry behavior; a failed or unreachable judge never blocks the primary agent.

## Layout

```
src/index.ts      factory: triggers, typesafe_ask, /adversary, /typesafe, session_shutdown bench log
src/ambiguity.ts  plan-mode ambiguity gate: battery, composite math, question templates, telemetry
src/reviewer.ts   role-aware batteries, severity derivation, emission guard, delivery routing
src/evidence.ts   git probes via pi.exec, missed-callsite grep
src/branch.ts     session-branch scanner (camelCase roles), plan-mode marker detection
src/client.ts     @typesafe-ai/sdk wrapper, usage tracking
src/config.ts     defaults + ~/.omp/agent/typesafe.json, role/phases, env overrides
src/priorities.ts ADVERSARY.md (adversarial) / WATCHDOG.md (advisory) discovery
test/             bun test unit tests (reviewer.ts, config.ts) — no network
```
