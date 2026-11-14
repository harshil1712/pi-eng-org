import { describe, expect, it } from 'vitest'
import type { Ticket } from '~/contract'
import { humanReviewBlocker, updatesMessage } from '~/server/team'
import { TEAM_PROMPT_LIMIT } from '~/server/team-tools'

const at = '2026-11-13T22:00:00.000Z'

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 'T-1',
  title: 'Health check',
  spec: 'GET /health answers 200.',
  repo: 'octo/demo',
  dependsOn: [],
  status: 'in_review',
  reviewRounds: 1,
  review: { verdict: 'approved', round: 1, comments: 'Fine.', at },
  pullRequest: { number: 1, url: 'https://github.com/octo/demo/pull/1' },
  createdAt: at,
  updatedAt: at,
  ...overrides,
})

describe('the gate before the person', () => {
  it('lets an approved ticket through, with QA passed or never asked for', () => {
    expect(humanReviewBlocker(ticket())).toBeUndefined()
    expect(humanReviewBlocker(ticket({ qaSession: 'qa', qa: { result: 'pass', summary: 'Works.', at } }))).toBeUndefined()
  })

  it('stops a ticket review has not approved while rounds are left', () => {
    expect(humanReviewBlocker(ticket({ reviewRounds: 0, review: undefined }))).toContain('has not been reviewed')
    expect(humanReviewBlocker(ticket({ reviewRounds: 2, review: undefined }))).toContain('review round 2 is still going')
    expect(humanReviewBlocker(ticket({ reviewRounds: 2, review: { verdict: 'changes_requested', round: 2, comments: 'Add a test.', at } }))).toContain('1 more rounds are left')
  })

  it('leaves the call to the manager once every round is used', () => {
    expect(humanReviewBlocker(ticket({ reviewRounds: 3, review: { verdict: 'changes_requested', round: 3, comments: 'Still no test.', at } }))).toBeUndefined()
  })

  it('waits for a QA run that was asked for, and stops one that failed', () => {
    expect(humanReviewBlocker(ticket({ qaSession: 'qa' }))).toContain('QA run has not reported yet')
    expect(humanReviewBlocker(ticket({ qaSession: 'qa', qa: { result: 'fail', summary: 'Broken.', at } }))).toContain('QA failed')
  })
})

describe('the manager\'s updates', () => {
  it('fit in one team prompt however many there are, and say how many were left out', () => {
    const updates = Array.from({ length: 30 }, (_, index) => ({ ticket: `T-${index}`, kind: 'qa' as const, body: 'x'.repeat(10_000) }))
    const message = updatesMessage(updates)

    expect(message.length).toBeLessThanOrEqual(TEAM_PROMPT_LIMIT)
    expect(message).toMatch(/…and \d+ more updates; read the board with board_list\./)
    expect(updatesMessage(updates.slice(0, 2))).not.toContain('more updates')
  })
})
