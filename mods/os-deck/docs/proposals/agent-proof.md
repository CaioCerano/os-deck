# Agent Proof: technical proposal

Status: **built in 0.5.0. Approved on 2026-11-22, with one change: automatic by default.** Revision 2, after an independent architecture review.
Based on os-deck 0.4.3 (`5008096`), Claude Code 2.1.330, Windows 11.

Evidence labels: **[measured]** run for this proposal; **[read]** from code or the engine's type contract; **[assumed]** not yet tested.

> An agent's claim of completion is not proof of completion. A passing check is not proof of correctness either: it proves that one command, approved by a person, gave one result on one exact state of the files.

## 0. Assumptions challenged

| # | The brief assumes | Found | Proposed |
|---|---|---|---|
| A1 | Verify at completion | 47% of 407 real completions were followed by another completion in the same turn, at least 17% by a file edit (shell edits not counted) [measured] | Queue at completion, run once when the turn ends with an answer |
| A2 | The opened folder is the project | 38% of 361 project file edits were outside the folder the session opened [measured] | The person approves repository roots explicitly |
| A3 | Checks verify tasks | Checks see a whole tree. Tying them to a task alone gives false greens: reverted work, another task's work | **The verdict belongs to (root, revision).** A task borrows it only under section 4's conditions |
| A4 | Exit 0 is a pass | `node --test` with zero tests exits 0; `script \|\| true` exits 0 with failures [measured] | Exit 0, zero failed, at least the accepted number passed, no more than the accepted number skipped |
| A5 | A trusted command is safe | The agent can edit what it runs, and it runs outside permission prompts and the sandbox [read] | Nothing runs before a press each session. That press allows automatic runs (the approved default); "manual only" is beside it |
| A6 | Saved approval can be trusted | The plugin store is a user-writable JSON file [read, permission bit checked] | Saved definitions are suggestions. Permission lives in session state and is bound to the session id |
| A7 | History is an audit trail | Same file, same writer | History, not tamper-evident. It never makes anything green |
| A8 | "Verified" stands alone | It reads as "correct" | Two axes: `checks verified`, and `review needed / reviewed` |

### Threat model

Defends against: overclaiming or mistaken agents, failing or missing tests, a falling test count, stale results, and a repository getting execution before approval.

Does not defend against: a malicious agent with the user's shell (it can edit this mod), other installed mods, weakened assertions, a test that exits early with a plausible count, or changes to ignored inputs.

## 1. Existing architecture

| Concern | Today [read] | Reuse |
|---|---|---|
| Tasks | `tool.call` sees task tools from every loop; `notePlan` returns an atomic before/after | Claims and baselines |
| Replay | `rebuildPlan`, with no times | Never triggers anything |
| Agents | spawn and completion events, linked to tasks | Who claimed; who is still working |
| Turn end | `turn.complete` refreshes git, GitHub and history | Run point |
| Git | `safe-git.ts` never lets a repository run code | Same runner and flags |
| Persistence | session `$.state`; `$.store` (4 MiB in all, 256-character keys) with per-session keys | Same patterns |
| Redaction | `redact.ts` | Output and agent text. Not the argv being approved |
| GitHub | Branch PR checks, not tied to content | Later source, not evidence today |
| Quality phase | A name in the group path | Not evidence |
| UI | Plan rows; agent cards expand in place | Same pattern |

State atoms stay in `register.tsx`. Runners and sections can be imported modules [measured]. `register.tsx` gets wiring only, `core.ts` nothing. No new dependencies.

## 2. Architecture

```
register.tsx          wiring only
  proof/revision.ts   content revision of a root
  proof/runner.ts     one queue: spawn, tail, timeout, cancel
  proof/checks.ts     result rules, two count parsers
  proof/verdict.ts    pure: the only producer of Verified
  proof/history.ts    bounded store records
  proof/view.tsx      { rows, node }
```

### Revision

The root must equal `git rev-parse --show-toplevel`. The revision is a SHA-256 over:

- the path, raw-byte hash (`hash-object --no-filters --stdin-paths`) and executable bit (as git's index records it, not the disk) of each tracked or untracked non-ignored file that exists, and of every `.gitignore` in their folders, which can ignore itself;
- the contents of `.git/info/exclude`.

It is unavailable, never partial, for: conflicts, links, submodules, untracked nested repositories, names git would read differently, failed or truncated reads. Setup reports these before approval.

[measured] on the whole algorithm:

- five live attack repositories, Git LFS included: no code ran, zero child processes;
- 63 to 97 ms on four real repositories;
- staging, staged deletion, commit and touch keep it; subfolder and exclude-file edits change it.

Blind spot, always shown: ignored inputs such as `.env`, dependencies and build caches.

### Execution

- An argv, never a shell string. The executable is a bare name or a local absolute path. An invalid one is refused, never replaced by a fallback. No UNC paths, no cmd metacharacters.
- The cwd is the root or a declared folder inside it, never `session.cwd`.
- `$.process.spawn` with a timer, because `run` stops at 10 minutes and drops the end of long output. Cancelling a silent child settled and killed its grandchild [measured in the real engine; the test kit does not settle it, so cancellation also gets a live test].
- One check at a time.
- Children inherit the environment. Known credential variables are blanked; the approval screen says the rest are not.

## 3. Data model

```ts
type Kind = 'test' | 'typecheck' | 'lint' | 'build'
type CheckDef = {
  id: string; kind: Kind; description: string
  argv: string[]; dir: string; timeoutS: number; required: boolean
  count?: { parser: 'bun' | 'pass-fail-lines'; minPassed: number | null; maxSkipped: number }
}

// $.state
type Grant = { session: string; root: string; checks: CheckDef[]; digest: string; auto: boolean; at: number }
type Claim = {
  id: string                     // session + task + completion number
  subject: string; description: string   // the agent's words
  agentId: string | null; at: number
  roots: {
    root: string
    paths: { path: string; hash: string | null }[]
    overlap: string[]            // claims whose interval overlapped
  }[]
  outside: string[]              // edit paths outside approved roots
}

type CheckResult = {
  id: string; kind: Kind; description: string
  execution: 'queued' | 'running' | 'exited' | 'timed-out' | 'cancelled' | 'interrupted' | 'unavailable'
  result: 'pass' | 'fail' | 'inconclusive'
  source: 'os-deck-run'
  startedAt: number; endedAt: number | null
  revision: string
  exitCode: number | null
  count: { passed: number; failed: number; skipped: number } | null
  summary: string                // the log reference; the tail lives in session state
  reason: string | null
}
type Attempt = {
  id: string; session: string; root: string; digest: string; trigger: 'auto' | 'manual'
  before: string; after: string | null; head: string | null
  startedAt: number; checks: CheckResult[]
}
type Review = { claim: string; revision: string; at: number }   // the revision that was drawn
```

Displayed state is derived, never stored. The store keeps claim text, attempts and reviews: 50 of each per root, under hashed keys. Grants and `auto` are never saved.

## 4. Lifecycle and verdict

```
in_progress  -> baseline, awaited (about 80 ms, 1 s cap)
completed    -> claim and changed paths; Pending
turn ends with an answer
  auto       -> one attempt per changed root, once no agent is listed running
  manual     -> "press to verify"
afterwards   -> revision re-read after edit and shell calls, at turn end, and on a
                timer while a green is shown ("checked 14:05")
```

**Root state.** First match wins. `current` is the revision now.

| # | Condition | State |
|---|---|---|
| 1 | Attempt running | Verifying |
| 2 | No attempt by this session under this grant | Pending, saying what it waits for |
| 3 | Revision unavailable | Inconclusive |
| 4 | A required check failed, and current is the attempt's before or after | Failed |
| 5 | Attempt interrupted or without an after | Inconclusive |
| 6 | before differs from after, and current is after | Inconclusive: changed during the run |
| 7 | current differs from before or after | Stale, with the old result in words, never green |
| 8 | No required check, or one missing, timed out, unavailable, uncounted or outside its accepted counts | Inconclusive |
| 9 | Every required check passed and current = before = after | Verified |
| 10 | Otherwise | Inconclusive |

**Task state.** A completed task shows Verified only if all hold:

- it changed at least one approved root, and no observed edit was outside them;
- its interval overlapped no other claim's (otherwise "attribution unknown");
- every root it changed is Verified (several roots: the worst wins);
- every path it changed still has the hash it had at completion (otherwise Stale: "changed since this claim").

A task with no observed change is Inconclusive, beside its root's state. Reopening withdraws the claim; completing again is a new claim with a new baseline.

Shell writes outside approved roots cannot be observed. The UI says so.

## 5. Event integration

| Event | Action |
|---|---|
| `tool.call` TaskUpdate in_progress | baseline after `next`, awaited under a 1 s cap, inside `quietly` |
| `tool.call` TaskUpdate completed | claim, not awaited |
| `tool.call` edit, shell | note edit paths; debounced re-read |
| `turn.complete` main, `reason === 'answer'` | queue automatic runs; aborted and error never run anything |
| `turn.complete` agent | release waiting runs after `$.agent.list()` |
| `session.start` | load history; orphaned attempts read interrupted |
| `session.end`, clear included | cancel; drop grants. A changed session id also voids them |
| `command.run` `/os-deck proof` | shows and drafts only, never grants |
| Button | grant, run, cancel, accept baseline, reviewed. Bound to the digest drawn. Plugins have no call that presses one [read] |

TodoWrite items have no stable id, so no proof in the MVP. Before setup the feature draws nothing.

## 6. UI and UX

No new pane and no modal: one line per root, a word on each task, detail in place.

```
● PLAN                                                  done
▰▰▰▰▱▱  67%  4/6 done
proof  shop  ✗ failed: test · checked 14:05     2 to review
  Checkout
    ✓ Add coupon field              ◌ stale
    ✓ Validate expiry               ✗ failed
    ✓ Fix rounding                  ✓ checks · review
```

Pressed:

```
    ✓ Validate expiry               ✗ failed
      CLAIMED by agent "worker", 14:02
        "Validate coupon expiry, with tests"
      VERIFIED BY OS-DECK · shop @ 8f31c2a · 14:05
        ✗ test       146 passed, 2 failed · exit 1 · 41s
        ✓ typecheck  exit 0 · 6s
        ? lint       no result: timed out after 120s
        earlier      13:40 failed · 13:12 verified
      FOR YOU
        acceptance criteria are not checked
        changed tests, scripts or test config: tests/coupon.test.ts
        not covered: ignored files
      [verify again]  [log]  [mark reviewed]
```

- Attention order: Failed, Inconclusive, Stale, Pending, review.
- States have words, not color alone.
- Plan view only. The classic and mini layouts are unchanged.

Setup:

1. `/os-deck proof setup` reads known manifests and lists candidates, running nothing. `/os-deck proof check <kind> -- <argv>` drafts any other.
2. The screen shows the root, each exact argv (escaped, untruncated), and the body of any package script with its pre and post hooks. An argv that redaction would alter is refused.
3. `allow` grants for this session with automatic runs, and says so beside the button; `manual only` grants without them.
4. The first test run shows its counts and stays Inconclusive until `accept as baseline` is pressed.
5. The next session shows the saved definition and asks for one press.

## 7. MVP and later

| MVP | Later, and its seam | Not planned |
|---|---|---|
| Claims, baselines, changed paths | CI: another `source`, accepted only for identical content | A model's opinion as verification |
| Test, typecheck, lint, build | Screenshots and browser tests: artifact references | Commands from task text |
| Two count parsers | Person-written acceptance criteria on the review axis | Blocking completion |
| Root line, task detail, short timeline | Custom check kinds, more parsers | Tamper-evident audit |
| Automatic by default once allowed, and manual | Isolated worktree runs, "was already failing" baseline | |
| Persistent history | Agent's own test runs, shown as non-evidence | |

## 8. Security and reliability

| Risk | Control | Residual |
|---|---|---|
| Execution before approval | No hash and no process without a grant | |
| Forged store | Never grants, never greens | Forged history, a misleading suggestion at setup |
| Approved differs from run | Exact argv, script bodies, digest-bound press | Code those scripts call |
| Script changed later | Flag it; automatic off until pressed | Test code is arbitrary code |
| Weaker tests | Failed, passed and skipped rules; changed-test flag | Weaker assertions |
| Filters through git | `--no-filters`, trace regression tests | Future git changes |
| Secrets in output | Redaction; tail in session only | Pattern-based |
| Checks change files | before = after | Ignored outputs |
| Two sessions, one tree | before = after; "another run" shown when visible in the store | Shared ignored outputs, A-B-A edits |
| Slow hooks | Only the capped baseline is awaited | Up to 1 s at task start |

## 9. Milestones

All on `feat/agent-proof`. Nothing is pushed before the final review.

| M | Delivers | Exit criterion |
|---|---|---|
| M0 | Types, `verdict.ts` | Exhaustive table; every false-green sequence from the architecture review is a test |
| M1 | Revision | Attack traces, semantics, every unavailable case |
| M2 | Runner, parsers, grants | Failed-with-exit-0, zero tests, timeout, live silent cancel, forged store, /clear, resume |
| M3 | Lifecycle, history | Overlap, revert, reopen, several roots, reload, two sessions, abort |
| M4 | UI | Size matrix, every state, existing 152 tests pass |
| M5 | Dogfood and adversarial test | os-deck verifies its own change live; a fresh reviewer cannot get a false Verified |
| Release | `/os-review` by the user, fixes, push | Fresh install from GitHub verified |

### Definition of done

| Requirement | Met by |
|---|---|
| Completion triggers verification | Section 4, M3 |
| Independent execution | Runner, M2 |
| Traceable evidence | CheckResult, M2 |
| Missing or failed never verifies | Verdict, M0 |
| Correct revision | Sections 2 and 4, M1 |
| Changes invalidate | Root rule 7 and task rules, M3 |
| History persists | Section 3, M3 |
| Verified apart from review | Section 6, M4 |
| Lifecycle tested | All exit criteria |
| Workflows unchanged | Nothing before setup, M4 |

## Decisions (taken)

1. Automatic runs: **on when a root is allowed**; "manual only" is the other choice. A changed check script still pauses them until pressed.
2. Approval: one press per session.
3. Label: "checks verified" plus review.

As built, where it differs from the text above:

- Resume shows setup again and takes a new allow, so changed code is never accepted unseen.
- A task's start and completion wait up to 1.5 s for the content read (two reads, to catch a change during one), not 1 s.
- An automatic run is owed at most once per claim, so a clock step cannot make runs loop.
- No command runs checks, `proof run` included: the engine stamps a clicked link as it stamps a typed command.
- Commands are understood by a small positive grammar, held against real npm, cmd and sh, not by modelling shells: automatic inside it, manual only for an unknown program, refused otherwise.
- Detection leaves out, and names, a check that could not be allowed or could not verify.
- A new allowance starts with no evidence. Which attempt counts is the order recorded, never the clock.
- The executable bit is the index's; a change only on disk is not seen.

Consequence of 1: after that press, code the agent writes into tests runs at the end of a turn without a permission prompt. The setup screen says this.
