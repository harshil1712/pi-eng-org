import type { CreateTicketInput, PullRequest, TeamMessage, Ticket, TicketProcess, TicketStatus } from '~/contract'
import { ACTIVE_STATUSES, TICKET_STATUSES } from '~/contract'
import { isOneOf } from '~/lib/one-of'
import { parseRepo, repoSlug } from './github'
import type { TeamUpdate } from './team'

const TITLE_LIMIT = 200

const SPEC_LIMIT = 20_000

const NOTE_LIMIT = 2_000

const MESSAGE_LIMIT = 20_000

/** Messages the team page shows; older ones are deleted as new ones arrive. */
const MESSAGES_KEPT = 200

type TicketRow = {
  num: number
  title: string
  spec: string
  repo: string
  base_branch: string | null
  depends_on: string
  status: string
  builder: string | null
  pr_number: number | null
  pr_url: string | null
  note: string | null
  process: string
  created_at: number
  updated_at: number
}

type MessageRow = { id: number; sender: string; recipient: string; body: string; at: number }

type UpdateRow = { id: number; ticket: string; kind: string; body: string }

/** Updates waiting for the manager, and the last one's row ID. */
export type PendingUpdates = { updates: TeamUpdate[]; last: number }

/** What may change on a ticket after it is created. */
export type TicketPatch = {
  status?: TicketStatus
  note?: string
  /** null unassigns the ticket's builder. */
  builder?: string | null
  pullRequest?: PullRequest
  /** Rewrites the ticket's review, QA, human review and merge state. */
  process?: (current: TicketProcess) => TicketProcess
}

/**
 * The team's ticket board and message log, in the registry's SQLite.
 *
 * A ticket names its dependencies when it is created and only then, and they
 * must already exist, so the dependency graph cannot have a cycle.
 */
export class Board {
  readonly #sql: SqlStorage

  constructor(sql: SqlStorage) {
    this.#sql = sql
    sql.exec(`CREATE TABLE IF NOT EXISTS team_tickets (
      num INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      spec TEXT NOT NULL,
      repo TEXT NOT NULL,
      base_branch TEXT,
      depends_on TEXT NOT NULL,
      status TEXT NOT NULL,
      builder TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      note TEXT,
      process TEXT NOT NULL DEFAULT '{"reviewRounds":0}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS team_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      body TEXT NOT NULL,
      at INTEGER NOT NULL
    )`)
    // One number per ticket and sequence: a ticket that changes builders keeps
    // its number, and cancelled tickets' numbers do not count as taken.
    sql.exec(`CREATE TABLE IF NOT EXISTS team_reservations (
      repo TEXT NOT NULL,
      key TEXT NOT NULL,
      ticket INTEGER NOT NULL,
      number INTEGER NOT NULL,
      PRIMARY KEY (repo, key, ticket)
    )`)
    sql.exec('DROP TABLE IF EXISTS team_sequences')
    sql.exec(`CREATE TABLE IF NOT EXISTS team_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL
    )`)
  }

  /**
   * A ticket's number in a repository's sequence, such as its migrations:
   * at least `atLeast`, and above every number another live ticket holds, so
   * builders working in parallel never collide. A ticket asking again, from
   * a new builder too, gets the number it already has, unless another live
   * ticket took it while this one was cancelled.
   */
  reserveNumber(repo: string, key: string, atLeast: number, ticketId: string): number {
    const slug = repoSlug(parseRepo(repo))
    const name = key.trim().toLowerCase()
    const ticket = ticketNumber(ticketId)

    if (!name) throw new Error('A sequence needs a name, such as migrations.')

    if (ticket === undefined) throw new Error(`No ticket ${ticketId}.`)

    // Numbers other live tickets hold.
    const live = this.#sql.exec<{ number: number }>(
      `SELECT r.number FROM team_reservations r JOIN team_tickets t ON t.num = r.ticket
       WHERE r.repo = ? AND r.key = ? AND r.ticket != ? AND t.status != 'cancelled'`,
      slug, name, ticket,
    ).toArray().map((row) => row.number)

    const held = this.#sql.exec<{ number: number }>('SELECT number FROM team_reservations WHERE repo = ? AND key = ? AND ticket = ?', slug, name, ticket).toArray()[0]

    if (held && !live.includes(held.number)) return held.number
    const next = Math.max(Math.max(0, ...live) + 1, Math.floor(atLeast))
    this.#sql.exec(
      'INSERT INTO team_reservations (repo, key, ticket, number) VALUES (?, ?, ?, ?) ON CONFLICT (repo, key, ticket) DO UPDATE SET number = excluded.number',
      slug, name, ticket, next,
    )

    return next
  }

  /** Hold an update for the manager until the registry delivers the batch. */
  queueUpdate(update: TeamUpdate): void {
    this.#sql.exec('INSERT INTO team_updates (ticket, kind, body) VALUES (?, ?, ?)', update.ticket, update.kind, update.body.slice(0, MESSAGE_LIMIT))
  }

  /** The updates waiting, oldest first, with the ID to `clearUpdates` up to once they are delivered. */
  pendingUpdates(): PendingUpdates {
    const rows = this.#sql.exec<UpdateRow>('SELECT * FROM team_updates ORDER BY id').toArray()

    return {
      updates: rows.map((row) => ({ ticket: row.ticket, kind: isUpdateKind(row.kind) ? row.kind : 'board', body: row.body })),
      last: rows.at(-1)?.id ?? 0,
    }
  }

  clearUpdates(last: number): void {
    this.#sql.exec('DELETE FROM team_updates WHERE id <= ?', last)
  }

  list(): Ticket[] {
    return this.#sql.exec<TicketRow>('SELECT * FROM team_tickets ORDER BY num').toArray().map(ticket)
  }

  get(id: string): Ticket | undefined {
    const num = ticketNumber(id)

    if (num === undefined) return undefined
    const row = this.#sql.exec<TicketRow>('SELECT * FROM team_tickets WHERE num = ?', num).toArray()[0]

    return row && ticket(row)
  }

  require(id: string): Ticket {
    const found = this.get(id)

    if (!found) throw new Error(`No ticket ${id}.`)

    return found
  }

  byBuilder(builder: string): Ticket | undefined {
    const row = this.#sql.exec<TicketRow>('SELECT * FROM team_tickets WHERE builder = ? ORDER BY num DESC LIMIT 1', builder).toArray()[0]

    return row && ticket(row)
  }

  create(input: CreateTicketInput): Ticket {
    const title = input.title.trim()
    const spec = input.spec.trim()

    if (!title) throw new Error('A ticket needs a title.')

    if (title.length > TITLE_LIMIT) throw new Error(`Ticket titles are limited to ${TITLE_LIMIT} characters.`)

    if (!spec) throw new Error('A ticket needs a spec: what to build and how to know it is done.')

    if (spec.length > SPEC_LIMIT) throw new Error(`Ticket specs are limited to ${SPEC_LIMIT} characters.`)
    const repo = repoSlug(parseRepo(input.repo.replace(/^@/, '')))
    const dependsOn = [...new Set((input.dependsOn ?? []).map((id) => this.require(id.trim()).id))]
    const baseBranch = input.baseBranch?.trim() || null
    const now = Date.now()

    const row = this.#sql.exec<TicketRow>(
      'INSERT INTO team_tickets (title, spec, repo, base_branch, depends_on, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
      title, spec, repo, baseBranch, JSON.stringify(dependsOn), 'todo', now, now,
    ).one()

    return ticket(row)
  }

  update(id: string, patch: TicketPatch): Ticket {
    const current = this.require(id)
    const note = patch.note === undefined ? current.note : patch.note.trim().slice(0, NOTE_LIMIT) || undefined
    const builder = patch.builder === undefined ? current.builder : patch.builder ?? undefined
    const pullRequest = patch.pullRequest ?? current.pullRequest
    const process = patch.process ? patch.process(processOf(current)) : processOf(current)

    const row = this.#sql.exec<TicketRow>(
      'UPDATE team_tickets SET status = ?, note = ?, builder = ?, pr_number = ?, pr_url = ?, process = ?, updated_at = ? WHERE num = ? RETURNING *',
      patch.status ?? current.status,
      note ?? null,
      builder ?? null,
      pullRequest?.number ?? null,
      pullRequest?.url ?? null,
      JSON.stringify(process),
      Date.now(),
      ticketNumber(current.id)!,
    ).one()

    return ticket(row)
  }

  /** The dependencies of `ticket` that are not done yet. */
  waitingOn(ticket: Ticket): string[] {
    return ticket.dependsOn.filter((id) => this.get(id)?.status !== 'done')
  }

  /** Tickets a builder could start now: to do, with every dependency done. */
  ready(): Ticket[] {
    return this.list().filter((entry) => entry.status === 'todo' && this.waitingOn(entry).length === 0)
  }

  /** Tickets that hold a builder. */
  active(): Ticket[] {
    return this.list().filter((entry) => isOneOf(ACTIVE_STATUSES, entry.status))
  }

  log(from: string, to: string, body: string): void {
    this.#sql.exec('INSERT INTO team_messages (sender, recipient, body, at) VALUES (?, ?, ?, ?)', from, to, body.slice(0, MESSAGE_LIMIT), Date.now())
    this.#sql.exec('DELETE FROM team_messages WHERE id <= (SELECT MAX(id) FROM team_messages) - ?', MESSAGES_KEPT)
  }

  /** The most recent messages, oldest first. */
  messages(limit = 50): TeamMessage[] {
    return this.#sql.exec<MessageRow>('SELECT * FROM team_messages ORDER BY id DESC LIMIT ?', limit)
      .toArray()
      .reverse()
      .map((row) => ({ id: row.id, from: row.sender, to: row.recipient, body: row.body, at: new Date(row.at).toISOString() }))
  }
}

export function isTicketStatus(value: string): value is TicketStatus {
  return isOneOf(TICKET_STATUSES, value)
}

const UPDATE_KINDS: readonly TeamUpdate['kind'][] = ['question', 'finished', 'failed', 'pull_request', 'board', 'review', 'qa', 'merge']

function isUpdateKind(value: string): value is TeamUpdate['kind'] {
  return isOneOf(UPDATE_KINDS, value)
}

function ticketNumber(id: string): number | undefined {
  const match = /^T-(\d+)$/i.exec(id.trim())

  return match ? Number(match[1]) : undefined
}

/** The process fields of a ticket, without the rest. */
function processOf({ reviewRounds, reviewer, review, qaSession, qa, humanReview, merge }: Ticket): TicketProcess {
  return { reviewRounds, reviewer, review, qaSession, qa, humanReview, merge }
}

function ticket(row: TicketRow): Ticket {
  // SAFETY: only `create`, which writes a JSON array of IDs, sets depends_on.
  const dependsOn = JSON.parse(row.depends_on) as string[]
  // SAFETY: only `update` writes process, from a TicketProcess; JSON drops its undefined fields.
  const process = JSON.parse(row.process) as TicketProcess

  return {
    ...process,
    reviewRounds: process.reviewRounds ?? 0,
    id: `T-${row.num}`,
    title: row.title,
    spec: row.spec,
    repo: row.repo,
    ...(row.base_branch ? { baseBranch: row.base_branch } : {}),
    dependsOn,
    status: isTicketStatus(row.status) ? row.status : 'todo',
    ...(row.builder ? { builder: row.builder } : {}),
    ...(row.pr_number && row.pr_url ? { pullRequest: { number: row.pr_number, url: row.pr_url } } : {}),
    ...(row.note ? { note: row.note } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}
