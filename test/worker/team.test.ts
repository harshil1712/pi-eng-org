import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '~/contract'
import { errorMessage } from '~/lib/error-message'
import type { JsonObject } from '~/lib/json'
import { registry, session } from './stubs'

/**
 * The message a registry call fails with. Settled here, since a Durable
 * Object RPC promise that `expect(...).rejects` awaits is still reported as
 * an unhandled rejection.
 */
async function failure(call: Promise<unknown>): Promise<string> {
  return call.then(() => 'no error', (cause: unknown) => errorMessage(cause))
}

/** The ticket ID a tool's answer names first. */
function ticketId(text: string): string {
  const id = /T-\d+/.exec(text)?.[0]

  if (!id) throw new Error(`No ticket in: ${text}`)

  return id
}

// Tests share the registry, so each starts from an empty board.
// Each test runs several agent sessions, which is slow beside the rest of the suite.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

beforeEach(async () => {
  await registry().clearBoardForTest()
})

/** Wait until a session is done with everything it was given, and idle in the catalog. */
async function settled(id: string): Promise<void> {
  await expect.poll(async () => (await session(id)).settledForTest(), { timeout: 45_000 }).toBe(true)
  await expect.poll(async () => (await registry().getSession(id))?.status, { timeout: 10_000 }).toBe('idle')
}

/** Ask the manager's faux model to call a tool, and return what it said about the result. */
async function managerTool(manager: SessionSummary, name: string, args: JsonObject): Promise<string> {
  const { text } = await (await session(manager.id)).promptForTest(`tool ${name} ${JSON.stringify(args)}`)

  return text ?? ''
}

async function builderOf(ticket: string): Promise<SessionSummary> {
  const sessions = await registry().listSessions()
  const builder = sessions.find((entry) => entry.role === 'builder' && entry.ticket === ticket)

  if (!builder) throw new Error(`No builder for ${ticket}`)

  return builder
}

describe('the board', () => {
  it('creates tickets in order, with dependencies that must exist', async () => {
    const first = await registry().createTicket({ title: 'Add a health check', spec: 'GET /health answers 200.', repo: '@octo/demo' })
    expect(first).toMatchObject({ status: 'todo', repo: 'octo/demo', dependsOn: [] })
    const second = await registry().createTicket({ title: 'Monitor it', spec: 'Alert when /health fails.', repo: 'octo/demo', dependsOn: [first.id.toLowerCase()] })
    expect(second.dependsOn).toEqual([first.id])
    expect(Number(second.id.slice(2))).toBeGreaterThan(Number(first.id.slice(2)))

    expect(await failure(registry().createTicket({ title: 'Orphan', spec: 'x', repo: 'octo/demo', dependsOn: ['T-999'] }))).toContain('No ticket T-999')
    expect(await failure(registry().createTicket({ title: 'Bad repo', spec: 'x', repo: 'not a repo' }))).toContain('is not a GitHub repository')
    expect(await failure(registry().createTicket({ title: ' ', spec: 'x', repo: 'octo/demo' }))).toContain('needs a title')

    expect((await registry().getTeam()).tickets.map((ticket) => ticket.id)).toEqual([first.id, second.id])
  })

  it('releases a ticket\'s builder when a person moves it back to todo', async () => {
    const ticket = await registry().createTicket({ title: 'Something', spec: 'Do it.', repo: 'octo/demo' })
    expect(await registry().updateTicket(ticket.id, { status: 'blocked', note: 'Waiting on design' })).toMatchObject({ status: 'blocked', note: 'Waiting on design' })
    expect(await registry().updateTicket(ticket.id, { status: 'todo' })).not.toHaveProperty('builder')
  })
})

describe('the engineering manager', () => {
  it('is started once, and works without a workspace', async () => {
    const manager = await registry().startManager()
    expect(manager).toMatchObject({ role: 'manager', name: 'Engineering manager' })
    expect((await registry().startManager()).id).toBe(manager.id)
    expect((await registry().getTeam()).manager?.id).toBe(manager.id)

    expect(await managerTool(manager, 'board_list', {})).toContain('tool said: The board is empty.')
    expect(await managerTool(manager, 'exec', { backend: 'shell', command: 'ls' })).toContain('tool failed')
    const { text } = await (await session(manager.id)).promptForTest('section preamble')
    expect(text).toContain('engineering manager')
    await settled(manager.id)
  })

  it('creates and assigns tickets, refusing ones that wait on others', async () => {
    const manager = await registry().startManager()
    const created = await managerTool(manager, 'create_ticket', { title: 'Add a route', spec: 'GET /ping answers pong.', repo: 'octo/demo' })
    expect(created).toContain('[todo] Add a route')
    const first = ticketId(created)
    const second = ticketId(await managerTool(manager, 'create_ticket', { title: 'Document it', spec: 'README mentions /ping.', repo: 'octo/demo', depends_on: [first] }))

    expect(await managerTool(manager, 'assign_ticket', { id: second })).toContain(`tool failed: ${second} waits on ${first}`)
    expect(await managerTool(manager, 'assign_ticket', { id: first })).toContain(`Assigned ${first} [in_progress]`)
    expect(await managerTool(manager, 'assign_ticket', { id: first })).toContain(`tool failed: ${first} is in_progress`)

    // The builder got its ticket as its first prompt, and its role's prompt.
    const builder = await builderOf(first)
    expect(builder.name).toBe(`${first}: Add a route`)
    expect((await registry().getTeam()).tickets[0]).toMatchObject({ status: 'in_progress', builder: builder.id })
    await settled(builder.id)
    expect(await (await session(builder.id)).latestReport()).toContain(`echo: Ticket ${first}: Add a route`)
    const { text } = await (await session(builder.id)).promptForTest('section team')
    expect(text).toContain(`working on ticket ${first}`)
    await settled(builder.id)

    // Its finished runs reach the manager, with what it reported.
    await expect.poll(async () => (await registry().getTeam()).messages.some((message) => message.from === 'team' && message.body.includes('The builder finished a run')), { timeout: 10_000 }).toBe(true)
    await settled(manager.id)
  })

  it('passes messages between the manager and its builders', async () => {
    const manager = await registry().startManager()
    const { id } = await registry().createTicket({ title: 'Cache it', spec: 'Cache GET /ping.', repo: 'octo/demo' })
    await managerTool(manager, 'assign_ticket', { id })
    const builder = await builderOf(id)
    await settled(builder.id)

    // A builder asks; the question reaches the manager in a team update.
    expect((await (await session(builder.id)).promptForTest('tool ask_manager {"message":"Which cache TTL?"}')).text).toContain('tool said: Sent.')
    await expect.poll(async () => (await session(manager.id)).latestReport(), { timeout: 10_000 }).toContain('Which cache TTL?')
    await settled(builder.id)
    await settled(manager.id)

    // The manager answers; the answer arrives in the builder's session.
    expect(await managerTool(manager, 'message_builder', { id, message: 'Use 60 seconds.' })).toContain(`Sent to the builder of ${id}`)
    await expect.poll(async () => (await session(builder.id)).latestReport(), { timeout: 10_000 }).toContain('[Manager] Use 60 seconds.')
    expect(await managerTool(manager, 'read_builder', { id })).toContain('Builder:')
    await settled(builder.id)
    await settled(manager.id)

    // Only the manager reads the board, and only builders ask the manager.
    expect(await failure(registry().teamBoard(builder.id))).toContain('Only the team\'s manager')
    expect(await failure(registry().teamAskManager(manager.id, 'hi'))).toContain('Only the team\'s builder')
  })

  it('moves a ticket to review when its builder opens a pull request, and back when the builder is deleted', async () => {
    const manager = await registry().startManager()
    const { id } = await registry().createTicket({ title: 'Ship it', spec: 'Do the thing.', repo: 'octo/demo' })
    await managerTool(manager, 'assign_ticket', { id })
    const builder = await builderOf(id)
    await settled(builder.id)

    await registry().setTask(builder.id, { repo: 'octo/demo', branch: 'pi/x', pullRequest: { number: 7, url: 'https://github.com/octo/demo/pull/7' } })
    expect((await registry().getTeam()).tickets[0]).toMatchObject({ status: 'in_review', pullRequest: { number: 7 } })
    await expect.poll(async () => (await session(manager.id)).latestReport(), { timeout: 10_000 }).toContain('opened pull request #7')
    await settled(manager.id)

    await registry().deleteSession(builder.id)
    expect((await registry().getTeam()).tickets[0]).toMatchObject({ status: 'todo', note: 'Its builder session was deleted.' })
    expect((await registry().getTeam()).tickets[0]).not.toHaveProperty('builder')
  })

  it('patrols its builders, and stays quiet when there is nothing to check', async () => {
    const manager = await registry().startManager()
    await settled(manager.id)
    await registry().patrol()
    expect((await registry().getTeam()).messages.some((message) => message.from === 'patrol')).toBe(false)

    const { id } = await registry().createTicket({ title: 'Ready one', spec: 'Ready.', repo: 'octo/demo' })
    await registry().patrol()
    await expect.poll(async () => (await session(manager.id)).latestReport(), { timeout: 10_000 }).toContain('[Patrol]')
    expect(await (await session(manager.id)).latestReport()).toContain(`${id} Ready one`)
    await settled(manager.id)
  })
})
