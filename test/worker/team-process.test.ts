import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary, Ticket } from '~/contract'
import { errorMessage } from '~/lib/error-message'
import type { JsonObject } from '~/lib/json'
import { handleRecording } from '~/server/recordings'
import { registry, session } from './stubs'

/** Wait until a session is done with everything it was given, and idle in the catalog. */
async function settled(id: string): Promise<void> {
  await expect.poll(async () => (await session(id)).settledForTest(), { timeout: 45_000 }).toBe(true)
  await expect.poll(async () => (await registry().getSession(id))?.status, { timeout: 10_000 }).toBe('idle')
}

/** Ask a session's faux model to call a tool, and return what it said about the result. */
async function callTool(id: string, name: string, args: JsonObject): Promise<string> {
  const { text } = await (await session(id)).promptForTest(`tool ${name} ${JSON.stringify(args)}`)

  return text ?? ''
}

async function ticket(id: string): Promise<Ticket> {
  const found = (await registry().getTeam()).tickets.find((entry) => entry.id === id)

  if (!found) throw new Error(`No ticket ${id}`)

  return found
}

async function sessionWith(role: SessionSummary['role'], ticketId: string): Promise<SessionSummary> {
  const found = (await registry().listSessions()).find((entry) => entry.role === role && entry.ticket === ticketId)

  if (!found) throw new Error(`No ${role} for ${ticketId}`)

  return found
}

/** A ticket with a builder that has cloned octo/demo, as `clone_repository` would leave it. */
async function assigned(manager: SessionSummary, title = 'Add a route', dependsOn?: string[]): Promise<{ id: string; builder: SessionSummary }> {
  const { id } = await registry().createTicket({ title, spec: `${title}: GET /ping answers pong.`, repo: 'octo/demo', ...(dependsOn ? { dependsOn } : {}) })
  await settled(manager.id)
  expect(await callTool(manager.id, 'assign_ticket', { id })).toContain(`Assigned ${id}`)
  const builder = await sessionWith('builder', id)
  await settled(builder.id)
  await (await session(builder.id)).setTaskForTest({ 'src/index.ts': 'export const ping = () => "ping"\n' })

  return { id, builder }
}

/** What a builder's `create_pull_request` reports to the registry. */
async function openPullRequest(builder: SessionSummary, number: number): Promise<void> {
  await registry().setTask(builder.id, { repo: 'octo/demo', branch: 'pi/test', pullRequest: { number, url: `https://github.com/octo/demo/pull/${number}` } })
}

/** Review round 1, approved: what a builder and its reviewer do before the manager may ask the person. */
async function approve(id: string, builder: SessionSummary): Promise<void> {
  await (await session(builder.id)).changeForTest({ 'src/index.ts': 'export const ping = () => "pong"\n' })
  expect(await callTool(builder.id, 'request_review', { summary: 'Answer pong' })).toContain('Review round 1 of 3 requested')
  const reviewer = await sessionWith('reviewer', id)
  await settled(reviewer.id)
  expect(await callTool(reviewer.id, 'submit_review', { verdict: 'approved', comments: 'Fine.' })).toContain('Review sent')
  await settled(builder.id)
}

// Each test runs several agent sessions, which is slow beside the rest of the suite.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

beforeEach(async () => {
  await registry().clearBoardForTest()
})

describe('review rounds', () => {
  it('sends committed changes to a reviewer, and its verdict back to the builder', async () => {
    const manager = await registry().startManager()
    const { id, builder } = await assigned(manager)

    await (await session(builder.id)).changeForTest({ 'src/index.ts': 'export const ping = () => "pong!"\n' }, false)
    expect(await callTool(builder.id, 'request_review', { summary: 'Answer pong' })).toContain('tool failed: Commit or discard these changes first')
    await settled(builder.id)
    await (await session(builder.id)).changeForTest({ 'src/index.ts': 'export const ping = () => "pong!"\n' })
    expect(await callTool(builder.id, 'request_review', { summary: 'Answer pong' })).toContain('Review round 1 of 3 requested')

    // The reviewer has no workspace, and its first prompt is the ticket, the summary and the diff.
    const reviewer = await sessionWith('reviewer', id)
    await settled(reviewer.id)
    const prompt = await (await session(reviewer.id)).latestReport()
    expect(prompt).toContain(`echo: Review round 1 of 3 for ticket ${id}`)
    expect(prompt).toContain('Answer pong')
    expect(prompt).toContain('+export const ping = () => "pong!"')
    expect(await callTool(reviewer.id, 'exec', { backend: 'shell', command: 'ls' })).toContain('tool failed')

    expect(await callTool(reviewer.id, 'submit_review', { verdict: 'changes_requested', comments: '1. Add a test.' })).toContain('Review sent to the builder.')
    await expect.poll(async () => (await session(builder.id)).latestReport(), { timeout: 10_000 }).toContain('[Reviewer, round 1 of 3] Changes requested:\n1. Add a test.')
    expect((await ticket(id)).review).toMatchObject({ verdict: 'changes_requested', round: 1, comments: '1. Add a test.' })
    await expect.poll(async () => (await session(manager.id)).latestReport(), { timeout: 10_000 }).toContain('Review round 1 of 3: changes requested')
    await settled(builder.id)
    await settled(reviewer.id)
    await settled(manager.id)
  })

  it('sends a diff longer than a person may type, which the team\'s prompts allow', async () => {
    const manager = await registry().startManager()
    const { id, builder } = await assigned(manager)
    const big = Array.from({ length: 600 }, (_, line) => `export const route${line} = () => "${'x'.repeat(40)}"`).join('\n')
    await (await session(builder.id)).changeForTest({ 'src/index.ts': `${big}\n` })
    expect(await callTool(builder.id, 'request_review', { summary: 'Many routes' })).toContain('Review round 1 of 3 requested')
    const reviewer = await sessionWith('reviewer', id)
    await settled(reviewer.id)
    // Before, a prompt this long was refused, and the builder could not ask for review.
    expect(big.length).toBeGreaterThan(20_000)
    expect(await (await session(reviewer.id)).latestReport()).toContain(`echo: Review round 1 of 3 for ticket ${id}`)
    // People still have the composer's limit.
    expect(await (await session(reviewer.id)).submit('x'.repeat(20_001)).then(() => 'sent', (cause: unknown) => errorMessage(cause))).toContain('Prompt exceeds 20,000 characters')

    for (const entry of [builder.id, reviewer.id, manager.id]) await settled(entry)
  })

  it('stops at three rounds and tells the manager', async () => {
    const manager = await registry().startManager()
    const { id, builder } = await assigned(manager)
    await (await session(builder.id)).changeForTest({ 'src/index.ts': 'export const ping = () => "pong!"\n' })

    for (const round of [1, 2, 3]) {
      expect(await callTool(builder.id, 'request_review', { summary: `Round ${round}` })).toContain(`Review round ${round} of 3 requested`)
      await settled(builder.id)
    }

    // One reviewer session, which remembers the earlier rounds.
    const reviewers = (await registry().listSessions()).filter((entry) => entry.role === 'reviewer' && entry.ticket === id)
    expect(reviewers).toHaveLength(1)
    await settled(reviewers[0]!.id)
    expect(await callTool(reviewers[0]!.id, 'submit_review', { verdict: 'changes_requested', comments: 'Still no test.' })).toContain('Review sent')
    await expect.poll(async () => (await session(builder.id)).latestReport(), { timeout: 10_000 }).toContain('That was the last review round')
    await settled(builder.id)

    expect(await callTool(builder.id, 'request_review', { summary: 'Round 4' })).toContain('tool failed: All 3 review rounds are used')
    expect((await ticket(id)).reviewRounds).toBe(3)
    await expect.poll(async () => (await session(manager.id)).latestReport(), { timeout: 10_000 }).toContain('used all 3 review rounds')
    await settled(builder.id)
    await settled(reviewers[0]!.id)
    await settled(manager.id)
  })
})

describe('QA', () => {
  it('checks out the pushed branch, and reports its result to the builder', async () => {
    const manager = await registry().startManager()
    const { id, builder } = await assigned(manager)

    expect(await callTool(builder.id, 'request_qa', { instructions: 'npm run dev on 5173' })).toContain('tool failed: Push your branch')
    await settled(builder.id)
    await openPullRequest(builder, 4)
    expect(await callTool(builder.id, 'request_qa', { instructions: 'npm run dev on 5173' })).toContain('QA requested')

    const qa = await sessionWith('qa', id)
    await settled(qa.id)
    const prompt = await (await session(qa.id)).latestReport()
    expect(prompt).toContain(`echo: QA for ticket ${id}`)
    expect(prompt).toContain('Repository: @octo/demo#pi/test')
    expect(prompt).toContain('npm run dev on 5173')
    // QA works in its own workspace, with the solo tools.
    expect(await callTool(qa.id, 'exec', { backend: 'shell', command: 'echo ok' })).toContain('tool said')

    // No browser in tests, so no recording.
    expect(await callTool(qa.id, 'submit_qa', { result: 'pass', summary: 'Ping answers pong.' })).toContain('QA passed and reported.')
    expect((await ticket(id)).qa).toMatchObject({ result: 'pass', summary: 'Ping answers pong.' })
    expect((await ticket(id)).qa).not.toHaveProperty('recording')
    await expect.poll(async () => (await session(builder.id)).latestReport(), { timeout: 10_000 }).toContain('[QA] Passed:\nPing answers pong.')
    await settled(builder.id)
    await settled(qa.id)
    await settled(manager.id)
  })

  it('serves no recording without Browser Run credentials or a QA run', async () => {
    const { id } = await registry().createTicket({ title: 'No QA', spec: 'x', repo: 'octo/demo' })
    const unconfigured = await handleRecording(new Request('http://localhost/'), env, id)
    expect(unconfigured.status).toBe(501)
    const configured = await handleRecording(new Request('http://localhost/'), { ...env, CLOUDFLARE_ACCOUNT_ID: 'a', BROWSER_RECORDING_TOKEN: 't' }, id)
    expect(configured.status).toBe(404)
  })
})

describe('the person\'s review and the merge queue', () => {
  it('ships a ticket the manager put in the inbox, merges it, and readies what waited on it', async () => {
    const manager = await registry().startManager()
    const { id, builder } = await assigned(manager)
    const { id: next } = await registry().createTicket({ title: 'Document it', spec: 'README', repo: 'octo/demo', dependsOn: [id] })

    expect(await callTool(manager.id, 'request_human_review', { id, summary: 'Ping answers pong.' })).toContain(`tool failed: ${id} has no pull request`)
    await openPullRequest(builder, 9)
    // The gate is code: no inbox before review approves.
    expect(await callTool(manager.id, 'request_human_review', { id, summary: 'Ping answers pong.' })).toContain(`tool failed: ${id} is not ready for the person: it has not been reviewed`)
    await approve(id, builder)
    expect(await callTool(manager.id, 'request_human_review', { id, summary: 'Ping answers pong.' })).toContain('Waiting for the person\'s review')
    expect((await ticket(id)).humanReview?.summary).toBe('Ping answers pong.')

    await registry().setMergeOutcomesForTest([{ kind: 'merged', sha: 'abc123' }])
    expect((await registry().shipTicket(id)).merge?.state).toBe('queued')
    await expect.poll(async () => (await ticket(id)).status, { timeout: 10_000 }).toBe('done')
    expect(await ticket(id)).toMatchObject({ merge: { state: 'merged', sha: 'abc123', attempts: 1 } })
    expect(await ticket(id)).not.toHaveProperty('humanReview')
    expect(await registry().mergeCallsForTest()).toEqual(['octo/demo#9'])

    await expect.poll(async () => (await session(builder.id)).latestReport(), { timeout: 10_000 }).toContain('[Merge queue] Pull request #9 is merged.')
    await expect.poll(async () => (await session(manager.id)).latestReport(), { timeout: 10_000 }).toContain(`Now ready: ${next} Document it`)
    await settled(builder.id)
    await settled(manager.id)
  })

  it('merges one pull request per repository at a time, in the order they shipped', async () => {
    const manager = await registry().startManager()
    const first = await assigned(manager, 'First')
    const second = await assigned(manager, 'Second')
    await openPullRequest(first.builder, 1)
    await openPullRequest(second.builder, 2)

    // The first waits on its checks once; the second waits behind it.
    await registry().setMergeOutcomesForTest([{ kind: 'waiting', detail: 'Checks are running.' }, { kind: 'merged' }, { kind: 'merged' }])
    await registry().shipTicket(first.id)
    await registry().shipTicket(second.id)
    await expect.poll(async () => (await ticket(second.id)).status, { timeout: 10_000 }).toBe('done')
    expect((await ticket(first.id)).status).toBe('done')
    expect(await registry().mergeCallsForTest()).toEqual(['octo/demo#1', 'octo/demo#1', 'octo/demo#2'])
    await settled(first.builder.id)
    await settled(second.builder.id)
    await settled(manager.id)
  })

  it('blocks a ticket whose pull request conflicts, and gives up on one that never becomes mergeable', async () => {
    const manager = await registry().startManager()
    const conflicted = await assigned(manager, 'Conflicted')
    await openPullRequest(conflicted.builder, 5)
    await registry().setMergeOutcomesForTest([{ kind: 'conflict' }])
    await registry().shipTicket(conflicted.id)
    await expect.poll(async () => (await ticket(conflicted.id)).merge?.state, { timeout: 10_000 }).toBe('conflict')
    expect((await ticket(conflicted.id)).status).toBe('blocked')
    await expect.poll(async () => (await session(manager.id)).latestReport(), { timeout: 10_000 }).toContain('conflicts with its base')
    await settled(manager.id)

    const stuck = await assigned(manager, 'Stuck')
    await openPullRequest(stuck.builder, 6)
    await registry().setMergeOutcomesForTest([])
    await registry().shipTicket(stuck.id)
    await expect.poll(async () => (await ticket(stuck.id)).merge?.state, { timeout: 10_000 }).toBe('failed')
    expect((await ticket(stuck.id)).merge?.detail).toContain('Gave up after 3 attempts')
    expect(await registry().mergeCallsForTest()).toEqual(['octo/demo#6', 'octo/demo#6', 'octo/demo#6'])
    await settled(conflicted.builder.id)
    await settled(stuck.builder.id)
    await settled(manager.id)
  })

  it('sends a ticket back to its builder with the person\'s reason', async () => {
    const manager = await registry().startManager()
    const { id, builder } = await assigned(manager)
    await openPullRequest(builder, 3)
    await approve(id, builder)
    expect(await callTool(manager.id, 'request_human_review', { id, summary: 'Ready.' })).toContain('Waiting for the person\'s review')

    const sent = await registry().sendBackTicket(id, 'The button is misaligned.')
    expect(sent).toMatchObject({ status: 'in_progress', note: 'Sent back: The button is misaligned.' })
    expect(sent).not.toHaveProperty('humanReview')
    await expect.poll(async () => (await session(builder.id)).latestReport(), { timeout: 10_000 }).toContain('[Person] Sent back from review:\nThe button is misaligned.')
    expect(await registry().sendBackTicket(id, ' ').then(() => 'no error', (cause: unknown) => errorMessage(cause))).toContain('Say what needs to change')

    // Taken out of review any other way, it leaves the inbox too.
    await registry().updateTicket(id, { status: 'in_review' })
    expect(await callTool(manager.id, 'request_human_review', { id, summary: 'Ready again.' })).toContain('Waiting for the person\'s review')
    expect(await registry().updateTicket(id, { status: 'blocked', note: 'Waiting on design.' })).not.toHaveProperty('humanReview')
    await settled(builder.id)
    await settled(manager.id)
  })
})

describe('sequence numbers', () => {
  it('gives parallel builders in one repository different numbers', async () => {
    const manager = await registry().startManager()
    const first = await assigned(manager, 'Migration one')
    const second = await assigned(manager, 'Migration two')

    expect(await callTool(first.builder.id, 'reserve_number', { sequence: 'migrations', at_least: 5 })).toContain('Reserved migrations number 5')
    expect(await callTool(second.builder.id, 'reserve_number', { sequence: 'Migrations', at_least: 5 })).toContain('Reserved Migrations number 6')
    // A ticket asking again keeps its number.
    expect(await callTool(first.builder.id, 'reserve_number', { sequence: 'migrations', at_least: 5 })).toContain('number 5')

    // A cancelled ticket's number is free for the next.
    await registry().updateTicket(second.id, { status: 'cancelled' })
    const third = await assigned(manager, 'Migration three')
    expect(await callTool(third.builder.id, 'reserve_number', { sequence: 'migrations', at_least: 5 })).toContain('number 6')

    // Reopened with a new builder, the cancelled ticket cannot have 6 back: the third holds it now.
    // Its old builder, taken off it, can do nothing for it.
    await registry().updateTicket(second.id, { status: 'todo' })
    expect(await callTool(second.builder.id, 'reserve_number', { sequence: 'migrations', at_least: 5 })).toContain(`tool failed: You are no longer ${second.id}'s builder`)
    expect(await callTool(manager.id, 'assign_ticket', { id: second.id })).toContain(`Assigned ${second.id}`)
    const again = (await registry().listSessions()).find((entry) => entry.role === 'builder' && entry.ticket === second.id && entry.id !== second.builder.id)!
    await settled(again.id)
    expect(await callTool(again.id, 'reserve_number', { sequence: 'migrations', at_least: 5 })).toContain('number 7')

    for (const id of [first.builder.id, second.builder.id, third.builder.id, again.id, manager.id]) await settled(id)
  })
})

describe('a builder taking over a ticket', () => {
  it('is told about the earlier pull request, keeps the ticket\'s number and rounds, and supersedes it', async () => {
    const manager = await registry().startManager()
    const { id, builder } = await assigned(manager, 'Users table')
    expect(await callTool(builder.id, 'reserve_number', { sequence: 'migrations', at_least: 3 })).toContain('number 3')
    await openPullRequest(builder, 4)
    await approve(id, builder)

    // The manager puts the ticket back and assigns it again.
    expect(await callTool(manager.id, 'update_ticket', { id, status: 'todo' })).toContain('[todo]')
    expect(await callTool(manager.id, 'assign_ticket', { id })).toContain(`Assigned ${id}`)
    const next = (await registry().listSessions()).find((entry) => entry.role === 'builder' && entry.ticket === id && entry.id !== builder.id)!
    await settled(next.id)
    const prompt = await (await session(next.id)).latestReport()
    expect(prompt).toContain('An earlier builder opened pull request #4 (https://github.com/octo/demo/pull/4)')
    expect(prompt).toContain('read_github_issue')
    expect(await callTool(next.id, 'reserve_number', { sequence: 'migrations', at_least: 3 })).toContain('number 3')

    // Its pull request replaces the old one, which the registry closes.
    await openPullRequest(next, 6)
    expect((await ticket(id)).pullRequest?.number).toBe(6)
    expect((await ticket(id)).reviewRounds).toBe(1)
    expect(await registry().closeCallsForTest()).toEqual([`octo/demo#4: Superseded by #6, which a new builder opened for ${id}.`])
    await expect.poll(async () => (await session(manager.id)).latestReport(), { timeout: 10_000 }).toContain('It replaces #4, which is now closed.')

    for (const entry of [builder.id, next.id, manager.id]) await settled(entry)
  })
})

describe('a ticket from request to merge', () => {
  it('goes through the manager, a builder, review, QA, the person and the merge queue', async () => {
    const manager = await registry().startManager()
    await settled(manager.id)

    // The manager turns a request into a ticket and assigns it.
    const created = await callTool(manager.id, 'create_ticket', { title: 'Health check', spec: 'GET /health answers 200 with "ok".', repo: 'octo/demo' })
    const id = /T-\d+/.exec(created)![0]
    expect(await callTool(manager.id, 'assign_ticket', { id })).toContain(`Assigned ${id} [in_progress]`)
    const builder = await sessionWith('builder', id)
    await settled(builder.id)
    expect(await (await session(builder.id)).latestReport()).toContain(`echo: Ticket ${id}: Health check`)

    // The builder clones, changes, commits and opens a pull request.
    const workspace = await session(builder.id)
    await workspace.setTaskForTest({ 'src/index.ts': 'export default {}\n' })
    await workspace.changeForTest({ 'src/index.ts': 'export default { fetch: () => new Response("ok") }\n' })
    await openPullRequest(builder, 21)
    expect((await ticket(id)).status).toBe('in_review')

    // Round 1: changes requested. Round 2: approved.
    expect(await callTool(builder.id, 'request_review', { summary: 'Adds /health' })).toContain('Review round 1 of 3')
    const reviewer = await sessionWith('reviewer', id)
    await settled(reviewer.id)
    await callTool(reviewer.id, 'submit_review', { verdict: 'changes_requested', comments: '1. Check the path.' })
    await settled(builder.id)
    await workspace.changeForTest({ 'src/index.ts': 'export default { fetch: (r: Request) => new URL(r.url).pathname === "/health" ? new Response("ok") : new Response(null, { status: 404 }) }\n' })
    expect(await callTool(builder.id, 'request_review', { summary: 'Checks the path now' })).toContain('Review round 2 of 3')
    await settled(reviewer.id)
    expect((await (await session(reviewer.id)).latestReport())).toContain('+export default { fetch: (r: Request)')
    await callTool(reviewer.id, 'submit_review', { verdict: 'approved', comments: 'Looks right.' })
    await settled(builder.id)

    // QA passes.
    expect(await callTool(builder.id, 'request_qa', { instructions: 'npm run dev, then open /health' })).toContain('QA requested')
    const qa = await sessionWith('qa', id)
    await settled(qa.id)
    await callTool(qa.id, 'submit_qa', { result: 'pass', summary: '/health answers ok; /other answers 404.' })
    await settled(builder.id)

    // The manager puts it in the person's inbox; the person ships it; the queue merges it.
    await settled(manager.id)
    expect(await callTool(manager.id, 'request_human_review', { id, summary: 'Adds GET /health. Reviewed in 2 rounds; QA passed.' })).toContain('Waiting for the person\'s review')
    expect(await ticket(id)).toMatchObject({ reviewRounds: 2, review: { verdict: 'approved', round: 2 }, qa: { result: 'pass' }, humanReview: { summary: 'Adds GET /health. Reviewed in 2 rounds; QA passed.' } })
    await registry().setMergeOutcomesForTest([{ kind: 'updated' }, { kind: 'merged', sha: 'f00d' }])
    await registry().shipTicket(id)
    await expect.poll(async () => (await ticket(id)).status, { timeout: 15_000 }).toBe('done')
    expect((await ticket(id)).merge).toMatchObject({ state: 'merged', sha: 'f00d', attempts: 2 })

    // Every hand-off is in the activity log, in order.
    const log = (await registry().getTeam()).messages.map((message) => `${message.from}→${message.to}`)
    const expected = ['manager→board', 'manager→' + id, id + '→reviewer', 'reviewer→' + id, id + '→reviewer', 'reviewer→' + id, id + '→qa', 'qa→' + id, 'manager→human', 'human→' + id, 'merge-queue→' + id]
    let at = 0

    for (const step of log) if (step === expected[at]) at++
    expect(at).toBe(expected.length)

    await settled(builder.id)
    await settled(reviewer.id)
    await settled(qa.id)
    await settled(manager.id)
  })
})
