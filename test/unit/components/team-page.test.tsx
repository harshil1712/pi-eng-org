import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '@cloudflare/kumo/components/sidebar'
import { Toasty } from '@cloudflare/kumo/components/toast'
import type { SessionSummary, TeamView, Ticket } from '~/contract'
import { AgentConnectionProvider } from '~/hooks/use-agent-connection'
import { SessionRegistryProvider } from '~/hooks/use-session-registry'
import { TeamPage } from '~/components/team-page'
import { renderAtPath } from '../render-at-path'

const mocks = {
  registry: {
    stub: {
      listSessions: vi.fn(),
      getTeam: vi.fn(),
      startManager: vi.fn(),
      createTicket: vi.fn(),
      updateTicket: vi.fn(),
      shipTicket: vi.fn(),
      sendBackTicket: vi.fn(),
    },
  },
  useAgent: vi.fn(),
}

const NOW = '2026-11-12T10:00:00.000Z'

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 'T-1', title: 'Add a route', spec: 'GET /ping', repo: 'octo/demo', dependsOn: [], status: 'todo', reviewRounds: 0, createdAt: NOW, updatedAt: NOW, ...overrides,
})

const manager: SessionSummary = { id: 'm1', name: 'Engineering manager', role: 'manager', status: 'idle', createdAt: NOW, updatedAt: NOW }

const team = (overrides: Partial<TeamView> = {}): TeamView => ({ tickets: [], messages: [], maxBuilders: 5, patrolSeconds: 900, ...overrides })

function Providers({ children }: { children: ReactNode }) {
  return <AgentConnectionProvider value={mocks.useAgent}><Toasty><Sidebar.Provider><SessionRegistryProvider>{children}</SessionRegistryProvider></Sidebar.Provider></Toasty></AgentConnectionProvider>
}

describe('TeamPage', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.useAgent.mockReturnValue(mocks.registry)
    mocks.registry.stub.listSessions.mockResolvedValue([])
    mocks.registry.stub.getTeam.mockResolvedValue(team())
  })

  it('offers to start a manager, and opens its session', async () => {
    mocks.registry.stub.startManager.mockResolvedValue(manager)
    const { router } = await renderAtPath(<TeamPage />, { path: '/team', wrapper: Providers })
    expect(await screen.findByText('No engineering manager yet')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start manager' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/sessions/m1'))
  })

  it('shows tickets in their columns with review, QA and merge state', async () => {
    mocks.registry.stub.getTeam.mockResolvedValue(team({
      manager,
      tickets: [
        ticket(),
        ticket({ id: 'T-2', title: 'Cache it', status: 'in_review', reviewRounds: 2, review: { verdict: 'approved', round: 2, comments: 'LGTM', at: NOW }, qa: { result: 'pass', summary: 'ok', at: NOW } }),
        ticket({ id: 'T-3', title: 'Ship it', status: 'done', merge: { state: 'merged', queuedAt: NOW, attempts: 1 } }),
      ],
    }))
    await renderAtPath(<TeamPage />, { path: '/team', wrapper: Providers })
    const board = await screen.findByRole('region', { name: 'Board' })
    const review = within(board).getByRole('article', { name: 'T-2: Cache it' })
    expect(review.textContent).toContain('Approved 2/3')
    expect(review.textContent).toContain('QA pass')
    expect(within(board).getByRole('article', { name: 'T-3: Ship it' }).textContent).toContain('Merged')
    expect(screen.getByRole('button', { name: 'Talk to manager' })).toBeTruthy()
  })

  it('ships a ticket from the inbox, or sends it back with a note', async () => {
    const waiting = ticket({
      status: 'in_review',
      pullRequest: { number: 9, url: 'https://github.com/octo/demo/pull/9' },
      humanReview: { summary: 'Ping answers pong.', requestedAt: NOW },
      review: { verdict: 'approved', round: 1, comments: 'Fine.', at: NOW },
      qa: { result: 'pass', summary: 'Works.', recording: 'browser-1', at: NOW },
    })

    mocks.registry.stub.getTeam.mockResolvedValue(team({ manager, tickets: [waiting] }))
    mocks.registry.stub.shipTicket.mockResolvedValue(waiting)
    mocks.registry.stub.sendBackTicket.mockResolvedValue(waiting)
    await renderAtPath(<TeamPage />, { path: '/team', wrapper: Providers })

    const card = await screen.findByRole('listitem', { name: 'Review T-1' })
    expect(card.textContent).toContain('Ping answers pong.')
    expect(card.textContent).toContain('Approved in round 1 of 3')
    expect(card.textContent).toContain('Passed, with a recording')
    // What the reviewer said is folded under its verdict.
    fireEvent.click(within(card).getByRole('button', { name: /Approved in round 1 of 3/ }))
    expect(await within(card).findByText('Fine.')).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Watch recording' })).toBeTruthy()

    fireEvent.click(within(card).getByRole('button', { name: 'Ship it' }))
    await waitFor(() => expect(mocks.registry.stub.shipTicket).toHaveBeenCalledWith('T-1'))

    fireEvent.click(within(card).getByRole('button', { name: 'Send back' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('What needs to change'), { target: { value: 'Fix the copy.' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send back' }))
    await waitFor(() => expect(mocks.registry.stub.sendBackTicket).toHaveBeenCalledWith('T-1', 'Fix the copy.'))
  })

  it('opens a ticket in full: spec, sessions, superseded pull requests and its timeline', async () => {
    const builder: SessionSummary = { id: 'b2', role: 'builder', ticket: 'T-1', status: 'running', createdAt: NOW, updatedAt: NOW }
    mocks.registry.stub.listSessions.mockResolvedValue([manager, builder])
    mocks.registry.stub.getTeam.mockResolvedValue(team({
      manager,
      tickets: [ticket({ status: 'in_review', builder: 'b2', spec: '## Goal\nA users table.', pullRequest: { number: 8, url: 'https://github.com/octo/demo/pull/8' } })],
      messages: [
        { id: 1, from: 'T-1', to: 'manager', body: 'Opened pull request #8.', at: NOW },
        { id: 2, from: 'team', to: 'T-1', body: 'Closed pull request #6, superseded by #8.', at: NOW },
      ],
    }))
    const { router } = await renderAtPath(<TeamPage ticketId="T-1" />, { path: '/team', wrapper: Providers })

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Add a route')).toBeTruthy()
    expect(within(dialog).getByRole('heading', { name: 'Goal' })).toBeTruthy()
    expect(within(dialog).getByText('#6 closed, superseded by #8')).toBeTruthy()
    expect(within(dialog).getByRole('link', { name: 'Builder' }).getAttribute('href')).toBe('/sessions/b2')
    expect(within(dialog).getByText('Opened pull request #8.')).toBeTruthy()
    expect(within(dialog).getAllByText('Builder → Manager')).toHaveLength(1)

    // Closing it goes through its URL.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(router.state.location.search).toEqual({}))
  })

  it('keeps Done short and newest first, and cancelled tickets out of the way', async () => {
    const done = Array.from({ length: 7 }, (_, index) => ticket({ id: `T-${index + 1}`, title: `Done ${index + 1}`, status: 'done', updatedAt: `2026-11-12T10:0${index}:00.000Z` }))
    mocks.registry.stub.getTeam.mockResolvedValue(team({ manager, tickets: [...done, ticket({ id: 'T-8', title: 'Dropped', status: 'cancelled' })] }))
    const { router } = await renderAtPath(<TeamPage />, { path: '/team', wrapper: Providers })

    const board = await screen.findByRole('region', { name: 'Board' })
    const titles = () => within(board).getAllByRole('article').map((card) => card.getAttribute('aria-label'))
    expect(titles()).toEqual(['T-7: Done 7', 'T-6: Done 6', 'T-5: Done 5', 'T-4: Done 4', 'T-3: Done 3'])
    fireEvent.click(within(board).getByRole('button', { name: 'Show 2 more' }))
    expect(titles()).toHaveLength(7)

    fireEvent.click(screen.getByRole('switch', { name: 'Show cancelled (1)' }))
    expect(titles()).toContain('T-8: Dropped')

    // A card opens its ticket by the ticket's URL.
    fireEvent.click(within(board).getByRole('button', { name: 'Open T-7' }))
    await waitFor(() => expect(router.state.location.search).toEqual({ ticket: 'T-7' }))
  })

  it('creates a ticket with its dependencies', async () => {
    mocks.registry.stub.getTeam.mockResolvedValue(team({ manager, tickets: [ticket()] }))
    mocks.registry.stub.createTicket.mockResolvedValue(ticket({ id: 'T-2' }))
    await renderAtPath(<TeamPage />, { path: '/team', wrapper: Providers })
    fireEvent.click(await screen.findByRole('button', { name: 'New ticket' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Document it' } })
    fireEvent.change(within(dialog).getByLabelText('Repository'), { target: { value: 'octo/demo' } })
    fireEvent.change(within(dialog).getByLabelText(/^Depends on/), { target: { value: 'T-1' } })
    fireEvent.change(within(dialog).getByLabelText('Spec'), { target: { value: 'README mentions /ping.' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create ticket' }))
    await waitFor(() => expect(mocks.registry.stub.createTicket).toHaveBeenCalledWith({ title: 'Document it', repo: 'octo/demo', spec: 'README mentions /ping.', dependsOn: ['T-1'] }))
  })
})
