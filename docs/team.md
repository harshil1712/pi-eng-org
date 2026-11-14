# The engineering team

pi-eng-org builds on pi-on-cf to add the manager-and-builders workflow from Ryan Carson's talk [How One Founder Manages 20 AI Coding Agents at Once](https://www.youtube.com/watch?v=BTtyguoPvBU). You talk to one **engineering manager** session. It writes no code: it turns your requests into tickets, starts a **builder** session for each ticket, and answers the builders' questions. Builders go through a **reviewer** and a **QA** agent. When a ticket is ready, you watch the QA recording and click **Ship**, and a deterministic **merge queue** merges the pull request.

```
person ─┬─ talks to ──▶ manager ── board tools ──▶ Board (registry SQLite)
        │                  ▲  ▲                       │
        │   team updates ──┘  └── patrol (every 15 min, code)
        │                                             ▼
        │                                     builder (one per ticket)
        │                                      │  │
        │                     request_review ──┘  └── request_qa
        │                         ▼                       ▼
        │                     reviewer (≤3 rounds)    QA (recorded browser)
        │
        └─ review inbox: watch recording ─▶ Ship ─▶ merge queue (code) ─▶ GitHub
```

## Roles

All roles run on `PiSession`. The role is stored in the session's storage (`pi-eng-org:role`) and in its catalog metadata, and `PiSession.setRole` installs the role's extension (`pi-eng-org:team`).

| Role | Workspace | Tools added for the role |
|---|---|---|
| Manager | None (the solo `pi-on-cf` extension is removed) | `board_list`, `create_ticket`, `update_ticket`, `assign_ticket`, `message_builder`, `read_builder`, `request_human_review`, web tools |
| Builder | Yes, the solo tools | `ask_manager`, `request_review`, `request_qa`, `reserve_number` |
| Reviewer | None | `submit_review` |
| QA | Yes, the solo tools and a recorded browser | `submit_qa` |

Every team RPC takes the caller's catalog ID, which the session passes and the model never sees. The registry checks the caller's role and, for builders, reviewers and QA, which ticket the caller works on. A builder must also be its ticket's current builder: one taken off its ticket can no longer act on it.

## Ticket lifecycle

| Step | Driven by | What happens |
|---|---|---|
| Create | Manager (`create_ticket`) or person (**New ticket**) | A `T-n` ticket. Dependencies must already exist, so the graph cannot have a cycle. |
| Assign | Manager (`assign_ticket`) | Code checks that the ticket is `todo`, its dependencies are `done`, and fewer than `MAX_BUILDERS` (5) builders are working. It then claims the ticket and starts a builder with the ticket as its first prompt. |
| Pull request | Builder (`create_pull_request`) | The ticket becomes `in_review`, and the manager is told. |
| Review | Builder (`request_review`) | The builder's committed diff against its base (up to 80,000 characters) goes to the ticket's reviewer session; the same session is reused each round, so it remembers its earlier comments. `submit_review` sends the verdict to the builder. Code caps the rounds at `MAX_REVIEW_ROUNDS` (3): a fourth request is refused and the manager is told. |
| QA | Builder (`request_qa`) | Allowed only after the branch is pushed. A QA session clones `@repo#<builder branch>`, runs the app, and exercises it through `preview.internal` in a recorded Browser Run session. `submit_qa` closes the browser, which finalizes the recording, and reports pass or fail to the builder and manager. |
| Person's review | Manager (`request_human_review`) | Code refuses until review has approved the ticket (or used all 3 rounds) and any QA run that was asked for has passed. Then the ticket appears in **Ready for your review** on `/team`, with the manager's summary, the review verdict, the QA result, and **Watch recording**. |
| Ship / Send back | Person | **Ship** adds the ticket to the merge queue. **Send back** submits the person's note to the builder and moves the ticket to `in_progress`. |
| Merge | Merge queue (code) | See below. On merge, the ticket becomes `done`, the builder is told, and the manager hears which dependent tickets are now ready. |

Moving a ticket back to `todo` releases its builder. Deleting a builder session puts its ticket back to `todo`.

**Taking over a ticket.** A new builder on a ticket that already has a pull request cannot reach the old branch: it belongs to another session, and workspace git has no credentials for it. So its first prompt names the old pull request, for the builder to read with `read_github_issue` and redo on its own branch. When it opens its pull request, the registry closes the old one as superseded (`closeOnGitHub`), so each ticket has one open pull request. Review rounds already used still count. The manager's prompt says to prefer `message_builder` while the builder is still there.

**Prompt limits.** People's prompts are capped at 20,000 characters. Prompts the team writes (tickets, reviewer diffs, `[Manager]` messages, updates and patrols) go through `PiSession.submitFromTeam`, which is not callable from a browser, and are capped at `TEAM_PROMPT_LIMIT` (200,000). Diffs are cut at 80,000 characters, builder summaries and QA instructions at 10,000, and an update batch that would not fit ends with a count of what was left out.

## The merge queue

`processMergeQueue` in `pi-registry.ts` is deterministic code; no model is involved. Each repository's shipped tickets merge one at a time, in the order they were shipped. The head of a repository's queue holds back the tickets behind it. Each attempt (`mergePullRequest` in `github.ts`) does the following:

1. Marks a draft pull request ready for review, through GraphQL, because GitHub cannot merge drafts.
2. If the branch is behind its base, asks GitHub to update it, then waits for checks.
3. Waits while GitHub is still computing mergeability or branch protection blocks the merge. It retries every `MERGE_RETRY_SECONDS` (60) and gives up after `MERGE_MAX_ATTEMPTS` (30).
4. On a conflict, marks the ticket `blocked`. Builders cannot resolve conflicts, because workspace git (isomorphic-git) has no conflict resolution, so the manager is asked to send the ticket back to `todo` for a fresh builder on the latest base, or to ask the person.
5. Otherwise squash-merges at the head commit it read.

Branch protection still applies. A pull request that needs a human approving review will wait and then fail, and the person is told.

**Sequence numbers.** `reserve_number` gives each ticket a number in a per-repository sequence, such as migrations: at least the builder's `at_least`, and above every number another live ticket holds, so builders working in parallel never pick the same one. Reservations are per ticket (`team_reservations`): asking again, or a new builder on the same ticket asking, returns the same number. Cancelled tickets' numbers do not count as taken; a cancelled ticket that is reopened keeps its number unless another ticket took it meanwhile.

## Messages

- **Manager → builder:** `message_builder` submits `[Manager] …`.
- **Reviewer, QA, person and merge queue → builder:** `[Reviewer, round n of 3] …`, `[QA] …`, `[Person] Sent back …`, `[Merge queue] …`.
- **Team → manager:** updates (questions, finished or failed runs, pull requests, review and QA results, merges) are batched into one `[Team update]` message after `NOTIFY_DELAY_SECONDS` (15). Finished runs quote the builder's last report.
- **Patrol:** every `PATROL_SECONDS` (15 minutes), code collects each active builder's run status and last report, plus the ready tickets, and sends the manager one `[Patrol]` message. It is skipped while the manager is running and when there is nothing to check.

Every message is logged in `team_messages`, keeping the last 200, and appears under **Activity** on `/team`. Text from builders, reviewers and QA is labelled untrusted wherever it is quoted.

## QA recordings

Every session's browser is created with Browser Run [session recording](https://developers.cloudflare.com/browser-run/features/session-recording/) on. A recording is finalized when the browser closes, which `submit_qa` does, and Browser Run keeps it for 30 days. The Browser binding cannot read recordings, so `GET /team/recordings/<ticket>` reads them from the REST API. It needs:

- `CLOUDFLARE_ACCOUNT_ID`, a var, and
- `BROWSER_RECORDING_TOKEN`, a secret: an API token with Browser Rendering read access.

Without them, the endpoint answers `501` and the page says so. The page replays the rrweb events with `rrweb-player`. Recordings show whatever the QA browser saw, so keep this route behind Cloudflare Access with the rest of the app.

## Testing

`test/worker/team.test.ts`, `team-process.test.ts` and `github-merge.test.ts` drive real `PiSession`s and the registry with faux models. They cover:

- the board, roles and messages;
- review rounds and the cap;
- QA;
- the person's inbox, Ship and Send back;
- the merge queue: ordering, retries, conflicts and giving up;
- sequence numbers, per ticket;
- a builder taking over a ticket;
- review prompts longer than a person's limit;
- one ticket from request to merge;
- the GitHub merge steps, against mocked responses.

`test/worker/team-rules.test.ts` covers the gate before the person and the cap on update batches. `test/unit/components/team-page.test.tsx` covers the team page. A live run additionally needs the GitHub App and a repository to work on. In local dev, remote bindings run through `pi-eng-org.<subdomain>.workers.dev`: on an account whose Zero Trust policy denies by default, that hostname needs its own Access application, or every model call fails with `error code: 1050`. Locally, QA's browser cannot reach `preview.internal`, so QA falls back to tests and HTTP checks and leaves no recording.

## Limits

- Each builder and QA agent has its own Computer container, so cost grows with `MAX_BUILDERS`.
- Coordinating a team needs a stronger model than building one ticket does. Choose the manager's model with `startManager({ model })`.
- There is one team per deployment.
- Conflicts are resolved by redoing the ticket, not by merging.
- Voice is out of scope.
