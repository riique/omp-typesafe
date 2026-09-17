# omp-typesafe

An adversarial reviewer for the [omp](https://omp.sh/docs) coding agent, powered by
[TypeSafe AI](https://typesafe.ai)'s System One model (Jev). It follows omp's advisor pattern — a second set
of eyes that watches the session as it unfolds — but argues the other side: that the last action or claim is
wrong, unverified, or incomplete. Notes are advisory; nothing is ever blocked.

It also registers a `typesafe_ask` tool exposing all three TypeSafe primitives (noul, choice, score) for direct use.

## What it watches

| Trigger | What Jev judges |
|---|---|
| `tool_result` (edit, write, apply_patch, ast_edit, bash, eval, notebook, debug, task) | `breaks_contract`, `unfounded_assumption`, `incomplete_cutover`, `not_what_was_asked`, `unverified_claim`, `hidden_destruction` |
| `message_end` (assistant messages ≥ 200 chars) | `unsupported_claim`, `requirement_missed`, `risky_api`, `weak_verification`, `unnecessary_complexity` |
| `turn_end` (transcript delta since last review) | `requirement_missed`, `weak_verification`, `unnecessary_complexity`, `silent_scope_reduction`, `risky_api` |

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

## Install

Requires omp and a `TYPESAFE_API_KEY` ([typesafe.ai](https://typesafe.ai)). Without the key the extension loads,
logs a warning, and stays inactive — it never wedges the agent.

```sh
omp plugin install github:siddicky/omp-typesafe
export TYPESAFE_API_KEY=...
```

Or from a clone:

```sh
git clone https://github.com/siddicky/omp-typesafe && cd omp-typesafe
bun install
omp plugin link "$PWD"
```

Newly added extension modules need a full omp restart (`/reload-plugins` is not enough).

## Commands and tool

- `/adversary` — toggle for this session; `/adversary on|off|status|last|dump`
- `/typesafe test` — one fixed probe: noul value, resolved model, latency, token usage
- `typesafe_ask` — tool with `state` (text, or JSON with `stateFormat: "json"`) and `questions[]` of
  `{ id, type: "noul"|"choice"|"score", instructions, options?, levels?, whenTrue?, whenFalse? }`

## Configuration

`~/.omp/agent/typesafe.json` (absent = defaults):

```json
{
  "model": "jev-latest",
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
  "stopGate": { "enabled": false, "unfinished_threshold": 0.70, "verified_floor": 0.25 }
}
```

If review feels chatty, set `reviewMessages: false` first, then narrow `adversary.tools` to the editing tools.
`stopGate` (off by default) asks two questions when the agent wants to stop and requests an advisory continuation
when work looks unfinished or unverified.

### Review priorities

Put an `ADVERSARY.md` at `~/.omp/agent/ADVERSARY.md`, in the repo root, or in `.omp/ADVERSARY.md` anywhere
between the git root and the working directory. Its text (capped at 2000 chars) is sent with every review as
`review_priorities`.

## Cost and latency

Jev is priced on input tokens only ($0.042 / Mtok at time of writing) and answers in ~150–400 ms. Reviews use
`timeoutMs` with no retries, so a slow or unreachable API costs at most that much per review and never a failure.
`/adversary status` shows session token usage and estimated cost.

## Layout

```
src/index.ts      factory: triggers, typesafe_ask, /adversary, /typesafe
src/reviewer.ts   batteries, severity derivation, emission guard, delivery routing
src/evidence.ts   git probes via pi.exec, missed-callsite grep
src/branch.ts     session-branch scanner (camelCase roles)
src/client.ts     @typesafe-ai/sdk wrapper, usage tracking
src/config.ts     defaults + ~/.omp/agent/typesafe.json
src/priorities.ts ADVERSARY.md discovery
```
