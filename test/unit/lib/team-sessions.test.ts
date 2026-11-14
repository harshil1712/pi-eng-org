import { describe, expect, it } from 'vitest'
import type { SessionSummary, Ticket } from '~/contract'
import { groupTeamSessions } from '~/lib/team-sessions'

const at = (minute: number) => `2026-11-14T00:${String(minute).padStart(2, '0')}:00.000Z`

const session = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id, status: 'idle', createdAt: at(0), updatedAt: at(0), ...overrides,
})

const ticket = (id: string, overrides: Partial<Ticket> = {}): Ticket => ({
  id, title: `Title of ${id}`, spec: '', repo: 'octo/demo', dependsOn: [], status: 'in_progress', reviewRounds: 0, createdAt: at(0), updatedAt: at(0), ...overrides,
})

describe('groupTeamSessions', () => {
  it('splits the manager, each ticket\'s sessions and the person\'s own', () => {
    const grouped = groupTeamSessions([
      session('mine', { name: 'Fix the docs' }),
      session('manager', { role: 'manager' }),
      session('b2', { role: 'builder', ticket: 'T-1', name: 'T-1: Users table', updatedAt: at(9), pullRequest: { number: 8, url: '' } }),
      session('r1', { role: 'reviewer', ticket: 'T-1', updatedAt: at(5) }),
      session('b1', { role: 'builder', ticket: 'T-1', name: 'T-1: Users table', updatedAt: at(3) }),
      session('q1', { role: 'qa', ticket: 'T-2', status: 'running', updatedAt: at(7) }),
    ], [ticket('T-1', { builder: 'b2' }), ticket('T-2', { status: 'done' })])

    expect(grouped.manager?.id).toBe('manager')
    expect(grouped.solo.map((entry) => entry.id)).toEqual(['mine'])
    // A done ticket with a session still running stays in view, and most recent work comes first.
    expect(grouped.active.map((entry) => entry.id)).toEqual(['T-1', 'T-2'])
    expect(grouped.finished).toEqual([])

    const [first] = grouped.active
    expect(first).toMatchObject({ title: 'Title of T-1', status: 'in_progress', activity: 'idle', updatedAt: at(9) })
    expect(first?.builder?.id).toBe('b2')
    expect(first?.earlier.map((entry) => entry.id)).toEqual(['b1'])
    expect(first?.reviewers.map((entry) => entry.id)).toEqual(['r1'])
    expect(grouped.active[1]?.activity).toBe('running')
  })

  it('folds finished tickets away, and names ones gone from the board after their builder', () => {
    const grouped = groupTeamSessions([
      session('b1', { role: 'builder', ticket: 'T-1', name: 'T-1: Users table', status: 'failed' }),
      session('b3', { role: 'builder', ticket: 'T-3' }),
    ], [ticket('T-3', { status: 'cancelled' })])

    expect(grouped.active).toEqual([])
    expect(grouped.finished.map((entry) => [entry.id, entry.title, entry.status, entry.activity])).toEqual([
      ['T-1', 'Users table', undefined, 'failed'],
      ['T-3', 'Title of T-3', 'cancelled', 'idle'],
    ])
  })
})
