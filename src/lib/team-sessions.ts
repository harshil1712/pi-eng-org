import type { SessionSummary, Ticket, TicketStatus } from '~/contract'

/** One ticket's sessions, as the sidebar nests them. */
export type TicketSessions = {
  id: string
  title: string
  /** Undefined when the ticket is no longer on the board. */
  status: TicketStatus | undefined
  /** The ticket's builder now, or its latest one. */
  builder: SessionSummary | undefined
  /** Builders that worked on it before, newest first. */
  earlier: SessionSummary[]
  reviewers: SessionSummary[]
  qa: SessionSummary[]
  /** Whether any of its sessions is running, or the latest run of any failed. */
  activity: 'running' | 'failed' | 'idle'
  updatedAt: string
}

export type TeamSessions = {
  manager: SessionSummary | undefined
  /** Tickets still being worked on, most recently active first. */
  active: TicketSessions[]
  /** Done, cancelled, or gone from the board. */
  finished: TicketSessions[]
  /** Sessions a person started, outside the team. */
  solo: SessionSummary[]
}

const FINISHED: (TicketStatus | undefined)[] = ['done', 'cancelled', undefined]

/**
 * Split the catalog into the team's sessions, by ticket, and everyone
 * else's. A ticket gathers 2 to 4 sessions (builder, reviewer, QA, a
 * replacement builder), so listing them flat buries the person's own.
 */
export function groupTeamSessions(sessions: SessionSummary[], tickets: Ticket[]): TeamSessions {
  const board = new Map(tickets.map((ticket) => [ticket.id, ticket]))
  const byTicket = new Map<string, SessionSummary[]>()
  const solo: SessionSummary[] = []
  let manager: SessionSummary | undefined

  for (const session of sessions) {
    if (session.role === 'manager') manager ??= session
    else if (session.role && session.ticket) byTicket.set(session.ticket, [...byTicket.get(session.ticket) ?? [], session])
    else solo.push(session)
  }

  const grouped = [...byTicket].map(([id, entries]) => ticketSessions(id, entries, board.get(id)))
  grouped.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return {
    manager,
    // A ticket gone from the board that still runs is worth seeing.
    active: grouped.filter((entry) => !FINISHED.includes(entry.status) || entry.activity === 'running'),
    finished: grouped.filter((entry) => FINISHED.includes(entry.status) && entry.activity !== 'running'),
    solo,
  }
}

function ticketSessions(id: string, entries: SessionSummary[], ticket: Ticket | undefined): TicketSessions {
  // The catalog lists newest first; keep that order within each role.
  const builders = entries.filter((entry) => entry.role === 'builder')
  const builder = builders.find((entry) => entry.id === ticket?.builder) ?? builders[0]
  const named = builder?.name ?? entries[0]?.name ?? ''

  return {
    id,
    // Builders are named `T-n: title`; the board's title wins when it has the ticket.
    title: ticket?.title ?? named.replace(/^T-\d+:\s*/, ''),
    status: ticket?.status,
    builder,
    earlier: builders.filter((entry) => entry !== builder),
    reviewers: entries.filter((entry) => entry.role === 'reviewer'),
    qa: entries.filter((entry) => entry.role === 'qa'),
    activity: entries.some((entry) => entry.status === 'running') ? 'running' : entries.some((entry) => entry.status === 'failed') ? 'failed' : 'idle',
    updatedAt: entries.map((entry) => entry.updatedAt).toSorted().at(-1) ?? '',
  }
}
