import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '@cloudflare/kumo/components/sidebar'
import { Toasty } from '@cloudflare/kumo/components/toast'
import type { SessionSummary, TeamView, Ticket } from '~/contract'
import { AgentConnectionProvider } from '~/hooks/use-agent-connection'
import { SessionRegistryProvider } from '~/hooks/use-session-registry'
import { SessionSidebar } from '~/components/session-sidebar'
import { renderAtPath } from '../render-at-path'

type RegistryOptions = { onStateUpdate?: (state: { revision: number }, source: 'server' | 'client') => void }

const mocks = {
  registry: {
    stub: {
      deleteSession: vi.fn(),
      getTeam: vi.fn(),
      listSessions: vi.fn(),
      renameSession: vi.fn(),
    },
  },
  registryOptions: undefined as RegistryOptions | undefined,
  useAgent: vi.fn(),
}

const hour = 60 * 60 * 1000

const session = (overrides: Partial<SessionSummary> & { id: string }, ago = 0): SessionSummary => {
  const at = new Date(Date.now() - ago).toISOString()

  return { status: 'idle', createdAt: at, updatedAt: at, ...overrides }
}

const ticket = (id: string, overrides: Partial<Ticket> = {}): Ticket => ({
  id, title: `Title of ${id}`, spec: '', repo: 'octo/demo', dependsOn: [], status: 'in_progress', reviewRounds: 0, createdAt: '', updatedAt: '', ...overrides,
})

const team = (tickets: Ticket[] = []): TeamView => ({ tickets, messages: [], maxBuilders: 5, patrolSeconds: 900 })

/** The app's providers, over a fake registry connection. */
function Providers({ children }: { children: ReactNode }) {
  return <AgentConnectionProvider value={mocks.useAgent}><Toasty><Sidebar.Provider><SessionRegistryProvider>{children}</SessionRegistryProvider></Sidebar.Provider></Toasty></AgentConnectionProvider>
}

/** The sidebar on the page at `path`. */
function renderSidebar(path = '/') {
  return renderAtPath(<SessionSidebar />, { path, wrapper: Providers })
}

/** Open a session's actions menu and pick one. */
async function act_on(name: string, action: 'Rename' | 'Delete') {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }))
  fireEvent.click(await screen.findByRole('menuitem', { name: action }))
}

describe('SessionSidebar', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.useAgent.mockImplementation((options: RegistryOptions) => {
      mocks.registryOptions = options

      return mocks.registry
    })
    mocks.registry.stub.deleteSession.mockResolvedValue(undefined)
    mocks.registry.stub.renameSession.mockResolvedValue(undefined)
    mocks.registry.stub.getTeam.mockResolvedValue(team())
    mocks.registry.stub.listSessions.mockResolvedValue([
      session({ id: 'named-session', name: 'Edge cache prototype', repo: 'octo/demo', pullRequest: { number: 7, url: 'https://github.com/octo/demo/pull/7' } }),
      session({ id: 'titled-session', title: 'Fix the flaky test' }, hour),
      session({ id: 'old-session-1' }, 30 * 24 * hour),
    ])
  })

  it('lists sessions by recency, by name, title or ID, with their repository and pull request', async () => {
    await renderSidebar('/sessions/titled-session')

    const named = await screen.findByRole('link', { name: /Edge cache prototype/ })
    expect(named.getAttribute('href')).toBe('/sessions/named-session')
    expect(within(named).getByText('octo/demo')).toBeTruthy()
    expect(within(named).getByTitle('Pull request #7').textContent).toBe('7')
    expect(screen.getByRole('link', { name: 'Fix the flaky test' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Untitled old-sess' })).toBeTruthy()
    expect(screen.getByText('Older')).toBeTruthy()
  })

  it('marks running and failed sessions', async () => {
    mocks.registry.stub.listSessions.mockResolvedValue([
      session({ id: 'running-session', title: 'Busy', status: 'running' }),
      session({ id: 'failed-session', title: 'Broken', status: 'failed' }),
      session({ id: 'idle-session', title: 'Quiet' }),
    ])
    await renderSidebar()

    // jsdom has no layout, so the accessible name runs the inline spans together.
    const running = await screen.findByRole('link', { name: /^Busy\s*\(running\)$/ })
    expect(within(running).getByTitle('Running')).toBeTruthy()
    const failed = screen.getByRole('link', { name: /^Broken\s*\(last run failed\)$/ })
    expect(within(failed).getByTitle('Last run failed')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Quiet' })).toBeTruthy()
  })

  it('reloads the list when the registry reports a change', async () => {
    await renderSidebar()
    await screen.findByRole('link', { name: /Edge cache prototype/ })

    mocks.registry.stub.listSessions.mockResolvedValue([session({ id: 'new-session', title: 'Add a README' })])
    act(() => mocks.registryOptions?.onStateUpdate?.({ revision: 5 }, 'server'))

    expect(await screen.findByRole('link', { name: 'Add a README' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Edge cache prototype/ })).toBeNull()
  })

  it('renames and deletes sessions from their menu', async () => {
    const { router } = await renderSidebar('/settings')
    await screen.findByRole('link', { name: /Edge cache prototype/ })

    await act_on('Edge cache prototype', 'Rename')
    const input = await screen.findByLabelText('Name')
    fireEvent.change(input, { target: { value: 'Cache spike' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocks.registry.stub.renameSession).toHaveBeenCalledWith('named-session', 'Cache spike'))

    await act_on('Fix the flaky test', 'Delete')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(mocks.registry.stub.deleteSession).toHaveBeenCalledWith('titled-session'))
    expect(router.state.location.pathname).toBe('/settings')
  })

  it('goes home after deleting the open session, and reports a failed delete', async () => {
    const { router } = await renderSidebar('/sessions/titled-session')
    await screen.findByRole('link', { name: 'Fix the flaky test' })

    await act_on('Fix the flaky test', 'Delete')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))

    mocks.registry.stub.deleteSession.mockRejectedValue(new Error('Session not found: named-session'))
    await act_on('Edge cache prototype', 'Delete')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Session not found: named-session')).toBeTruthy()
  })

  it('starts a new session from the header', async () => {
    const { router } = await renderSidebar('/settings')
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
  })

  it('nests the team\'s sessions under their tickets, below the board and the manager', async () => {
    mocks.registry.stub.listSessions.mockResolvedValue([
      session({ id: 'mine', name: 'My own session' }),
      session({ id: 'manager', role: 'manager', name: 'Engineering manager' }),
      session({ id: 'builder-1', role: 'builder', ticket: 'T-1', name: 'T-1: Users table', status: 'running', pullRequest: { number: 8, url: '' } }),
      session({ id: 'review-1', role: 'reviewer', ticket: 'T-1' }),
      session({ id: 'builder-2', role: 'builder', ticket: 'T-2', name: 'T-2: Old work' }),
    ])
    mocks.registry.stub.getTeam.mockResolvedValue(team([ticket('T-1', { builder: 'builder-1', humanReview: { summary: 'Ready.', requestedAt: '' } }), ticket('T-2', { status: 'done' })]))
    await renderSidebar('/sessions/review-1')

    expect((await screen.findByRole('link', { name: /^Board/ })).getAttribute('href')).toBe('/team')
    expect(await screen.findByLabelText('1 ready for your review')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Manager' }).getAttribute('href')).toBe('/sessions/manager')

    // The open session's ticket is unfolded, with its builder and reviewer under it.
    const active = screen.getByRole('button', { name: 'T-1: Title of T-1' })
    expect(active.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('link', { name: /^Builder/ }).getAttribute('href')).toBe('/sessions/builder-1')
    expect(screen.getByRole('link', { name: 'Review' }).getAttribute('aria-current')).toBe('page')

    // Finished tickets are folded away; the person's own sessions keep their own list.
    expect(screen.getByRole('button', { name: /^Finished/ }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('link', { name: 'My own session' })).toBeTruthy()
    expect(screen.queryByText('T-2: Old work')).toBeNull()
  })

  it('links each ticket to its details on the board, and marks the open one', async () => {
    mocks.registry.stub.listSessions.mockResolvedValue([session({ id: 'builder-2', role: 'builder', ticket: 'T-2' })])
    mocks.registry.stub.getTeam.mockResolvedValue(team([ticket('T-1'), ticket('T-2', { status: 'done' })]))
    await renderSidebar('/team?ticket=T-2')

    // A finished ticket unfolds when it is the one open.
    const details = await screen.findByRole('link', { name: 'Details' })
    expect(details.getAttribute('href')).toBe('/team?ticket=T-2')
    expect(details.getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: /^Board/ }).getAttribute('aria-current')).toBeNull()
  })

  it('opens Settings from the footer', async () => {
    const { router } = await renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
  })
})
