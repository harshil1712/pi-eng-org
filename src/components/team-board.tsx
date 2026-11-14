import { useState } from 'react'
import { Badge } from '@cloudflare/kumo/components/badge'
import { Button } from '@cloudflare/kumo/components/button'
import { LayerCard } from '@cloudflare/kumo/components/layer-card'
import { Loader } from '@cloudflare/kumo/components/loader'
import { Switch } from '@cloudflare/kumo/components/switch'
import { Tabs } from '@cloudflare/kumo/components/tabs'
import { cn } from '@cloudflare/kumo/utils'
import type { SessionSummary, Ticket, TicketStatus } from '~/contract'
import { isOneOf } from '~/lib/one-of'
import { ProcessBadges, PullRequestLink, STATUS_LABELS, StatusMenu, waitingOn } from './team-parts'

/** The board's columns, left to right. Cancelled tickets join Done when shown. */
const COLUMNS = ['todo', 'in_progress', 'blocked', 'in_review', 'done'] as const satisfies readonly TicketStatus[]

type Column = (typeof COLUMNS)[number]

/** Done tickets shown before "Show more": the column otherwise grows for ever. */
const DONE_SHOWN = 5

/** On a phone, the column to open on: the first that needs the person, else the first with tickets. */
const PHONE_ORDER: Column[] = ['in_review', 'blocked', 'in_progress', 'todo', 'done']

type BoardProps = {
  tickets: Ticket[]
  sessions: Map<string, SessionSummary>
  onOpen: (ticket: Ticket) => void
  onStatus: (ticket: Ticket, status: TicketStatus) => void
}

export function Board({ tickets, sessions, onOpen, onStatus }: BoardProps) {
  const [showCancelled, setShowCancelled] = useState(false)
  const [allDone, setAllDone] = useState(false)
  const [phoneColumn, setPhoneColumn] = useState<Column | null>(null)
  const cancelled = tickets.filter((ticket) => ticket.status === 'cancelled').length

  const columns = COLUMNS.map((status) => {
    const matching = tickets.filter((ticket) => ticket.status === status || (status === 'done' && showCancelled && ticket.status === 'cancelled'))

    // Finished work reads newest first; the rest in the order it was asked for.
    return { status, tickets: status === 'done' ? matching.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : matching }
  })

  const shownOnPhone = phoneColumn ?? PHONE_ORDER.find((status) => columns.some((column) => column.status === status && column.tickets.length)) ?? 'todo'

  return (
    <section aria-labelledby="board-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="board-heading" className="font-semibold">Board</h2>
        {cancelled > 0 && <Switch size="sm" label={`Show cancelled (${cancelled})`} checked={showCancelled} onCheckedChange={setShowCancelled} />}
      </div>
      {/* A phone shows one column at a time. */}
      <div className="-mx-1 overflow-x-auto px-1 md:hidden">
        <Tabs
          variant="segmented"
          size="sm"
          tabs={columns.map((column) => ({ value: column.status, label: <>{STATUS_LABELS[column.status].label}<span className="ml-1 text-kumo-subtle">{column.tickets.length}</span></> }))}
          value={shownOnPhone}
          onValueChange={(value) => { if (isOneOf(COLUMNS, value)) setPhoneColumn(value) }}
        />
      </div>
      <div className="grid gap-3 md:grid-cols-3 xl:flex xl:items-start">
        {columns.map((column) => {
          const shown = column.status === 'done' && !allDone ? column.tickets.slice(0, DONE_SHOWN) : column.tickets
          const hidden = column.tickets.length - shown.length

          return (
            <LayerCard
              key={column.status}
              aria-labelledby={`column-${column.status}`}
              className={cn(
                'min-w-0 xl:basis-0',
                // An empty column needs only its heading; the work gets the room.
                column.tickets.length ? 'xl:grow-[2]' : 'xl:grow',
                column.status !== shownOnPhone && 'max-md:hidden',
              )}
            >
              <LayerCard.Secondary className="my-0 px-3 py-2.5 text-sm max-md:hidden">
                <h3 id={`column-${column.status}`} className="text-kumo-default">{STATUS_LABELS[column.status].label}</h3>
                <Badge variant="neutral">{column.tickets.length}</Badge>
              </LayerCard.Secondary>
              <LayerCard.Primary className="gap-2 p-2">
                {shown.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-kumo-subtle">Nothing here.</p>
                ) : shown.map((ticket) => (
                  <TicketCard
                    key={ticket.id}
                    ticket={ticket}
                    tickets={tickets}
                    working={ticket.builder ? sessions.get(ticket.builder)?.status === 'running' : false}
                    onOpen={() => onOpen(ticket)}
                    onStatus={(status) => onStatus(ticket, status)}
                  />
                ))}
                {hidden > 0 && <Button size="sm" variant="ghost" onClick={() => setAllDone(true)}>Show {hidden} more</Button>}
                {allDone && column.status === 'done' && column.tickets.length > DONE_SHOWN && (
                  <Button size="sm" variant="ghost" onClick={() => setAllDone(false)}>Show fewer</Button>
                )}
              </LayerCard.Primary>
            </LayerCard>
          )
        })}
      </div>
    </section>
  )
}

function TicketCard({ ticket, tickets, working, onOpen, onStatus }: {
  ticket: Ticket
  tickets: Ticket[]
  working: boolean
  onOpen: () => void
  onStatus: (status: TicketStatus) => void
}) {
  const waiting = ticket.status === 'todo' ? waitingOn(ticket, tickets) : []
  // A note is the latest word on work in flight; on a finished ticket it is history.
  const note = ticket.status !== 'done' && ticket.status !== 'cancelled' ? ticket.note : undefined

  return (
    <article
      aria-label={`${ticket.id}: ${ticket.title}`}
      className={cn(
        'relative flex flex-col gap-1.5 rounded-md border border-kumo-hairline bg-kumo-base p-3 text-sm transition-colors hover:bg-kumo-tint',
        ticket.status === 'cancelled' && 'opacity-60',
      )}
    >
      {/* The whole card opens the ticket; the controls in it sit above this button. */}
      <button type="button" onClick={onOpen} className="flex cursor-pointer items-start gap-2 text-left after:absolute after:inset-0 after:rounded-md" aria-label={`Open ${ticket.id}`}>
        <span className="shrink-0 font-mono text-xs text-kumo-subtle">{ticket.id}</span>
        <span className="min-w-0 flex-1 font-medium break-words">{ticket.title}</span>
      </button>
      <span className="truncate text-xs text-kumo-subtle">{ticket.repo}{ticket.baseBranch ? `#${ticket.baseBranch}` : ''}</span>
      {waiting.length > 0 && <span className="text-xs text-kumo-subtle">Waits on {waiting.join(', ')}</span>}
      {note && <p className="line-clamp-2 text-xs break-words text-kumo-subtle" title={note}>{note}</p>}
      <div className="relative z-10 mt-0.5 flex flex-wrap items-center gap-1.5">
        <StatusMenu ticket={ticket} onStatus={onStatus} />
        <ProcessBadges ticket={ticket} />
        {working && <span className="flex items-center gap-1 text-xs text-kumo-subtle"><Loader size={12} />Working</span>}
        {ticket.pullRequest && <PullRequestLink pullRequest={ticket.pullRequest} className="ml-auto" />}
      </div>
    </article>
  )
}
