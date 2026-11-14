import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Badge, type BadgeVariant } from '@cloudflare/kumo/components/badge'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Button } from '@cloudflare/kumo/components/button'
import { LayerCard } from '@cloudflare/kumo/components/layer-card'
import { Loader } from '@cloudflare/kumo/components/loader'
import { Meter } from '@cloudflare/kumo/components/meter'
import { useKumoToastManager } from '@cloudflare/kumo/components/toast'
import { PlusIcon, UserCircleGearIcon } from '@phosphor-icons/react'
import { ACTIVE_STATUSES, type SessionSummary, type TeamMessage, type TeamView, type Ticket, type TicketStatus } from '~/contract'
import { useSessionRegistry } from '~/hooks/use-session-registry'
import { errorMessage } from '~/lib/error-message'
import { isOneOf } from '~/lib/one-of'
import { Board } from './team-board'
import { NewTicketDialog, RecordingDialog, SendBackDialog } from './team-dialogs'
import { Inbox } from './team-inbox'
import { TicketDetail, TimelineItem } from './ticket-detail'
import { TopBar } from './top-bar'

/** Activity rows shown before "Show all". */
const ACTIVITY_SHOWN = 15

/** A dialog's ticket, kept while it animates closed. */
type Opened = { ticket: Ticket; open: boolean } | null

/**
 * The team: its engineering manager, the ticket board, and what the manager
 * and its builders said to each other. You talk to the manager in its own
 * session; this page is for watching and steering the board. `ticketId`,
 * from the URL, opens that ticket.
 */
export function TeamPage({ ticketId }: { ticketId?: string }) {
  const registry = useSessionRegistry()
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const [creating, setCreating] = useState(false)
  const [starting, setStarting] = useState(false)
  const [watching, setWatching] = useState<Opened>(null)
  const [sendingBack, setSendingBack] = useState<Opened>(null)

  const view = registry.team
  const sessions = new Map(registry.sessions.map((session) => [session.id, session]))
  const opened = ticketId ? view?.tickets.find((ticket) => ticket.id === ticketId) : undefined
  const close = (setter: typeof setWatching) => (open: boolean) => { if (!open) setter((current) => current && { ...current, open: false }) }

  async function act<T>(operation: () => Promise<T>): Promise<T | undefined> {
    try {
      return await operation()
    } catch (caught) {
      toasts.add({ variant: 'error', title: 'Something went wrong', description: errorMessage(caught) })

      return undefined
    }
  }

  async function openManager() {
    setStarting(true)
    const manager = await act(() => registry.agent.stub.startManager())
    setStarting(false)

    if (manager) await navigate({ to: '/sessions/$sessionId', params: { sessionId: manager.id } })
  }

  const openTicket = (ticket: Ticket) => void navigate({ to: '/team', search: { ticket: ticket.id } })
  const setStatus = (ticket: Ticket, status: TicketStatus) => void act(() => registry.agent.stub.updateTicket(ticket.id, { status }))

  return (
    <>
      <TopBar
        actions={(
          <>
            <Button size="sm" variant="secondary" icon={<PlusIcon size={14} />} onClick={() => setCreating(true)}>New ticket</Button>
            <Button size="sm" variant="primary" icon={<UserCircleGearIcon size={16} />} loading={starting} onClick={() => void openManager()}>
              {view?.manager ? 'Talk to manager' : 'Start manager'}
            </Button>
          </>
        )}
      >
        <h1 className="font-semibold">Team</h1>
      </TopBar>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex w-full flex-col gap-8 px-4 py-6 md:px-6">
          {registry.teamError && <Banner variant="error" role="alert" description={registry.teamError} />}
          {!view && !registry.teamError && <div className="flex justify-center py-16"><Loader size={24} /></div>}
          {view && !view.manager && (
            <Banner
              title="No engineering manager yet"
              description={`Start one and tell it what to build. It writes tickets, starts up to ${view.maxBuilders} builders, answers their questions, and checks on every one of them every ${Math.round(view.patrolSeconds / 60)} minutes.`}
            />
          )}
          {view && (
            <>
              <TeamStatus view={view} manager={view.manager ? sessions.get(view.manager.id) ?? view.manager : undefined} />
              <Inbox
                tickets={view.tickets.filter((ticket) => ticket.humanReview)}
                onOpen={openTicket}
                onWatch={(ticket) => setWatching({ ticket, open: true })}
                onShip={(ticket) => void act(() => registry.agent.stub.shipTicket(ticket.id))}
                onSendBack={(ticket) => setSendingBack({ ticket, open: true })}
              />
              <Board tickets={view.tickets} sessions={sessions} onOpen={openTicket} onStatus={setStatus} />
              <Activity messages={view.messages} tickets={view.tickets} onOpen={openTicket} />
            </>
          )}
        </div>
      </main>
      <TicketDetail
        ticket={opened}
        open={Boolean(opened)}
        tickets={view?.tickets ?? []}
        sessions={registry.sessions}
        messages={view?.messages ?? []}
        onOpenChange={(open) => { if (!open) void navigate({ to: '/team', search: {} }) }}
        onStatus={setStatus}
      />
      <RecordingDialog ticket={watching?.ticket ?? null} open={watching?.open ?? false} onOpenChange={close(setWatching)} />
      <SendBackDialog
        ticket={sendingBack?.ticket ?? null}
        open={sendingBack?.open ?? false}
        onOpenChange={close(setSendingBack)}
        onSendBack={async (ticket, note) => {
          const sent = await act(() => registry.agent.stub.sendBackTicket(ticket.id, note))

          if (sent) setSendingBack((current) => current && { ...current, open: false })
        }}
      />
      <NewTicketDialog
        open={creating}
        tickets={view?.tickets ?? []}
        onOpenChange={setCreating}
        onCreate={async (input) => {
          const created = await act(() => registry.agent.stub.createTicket(input))

          if (created) setCreating(false)
        }}
      />
    </>
  )
}

/** The team at a glance: whether the manager is working, and how many builder slots are taken. */
function TeamStatus({ view, manager }: { view: TeamView; manager: SessionSummary | undefined }) {
  const active = view.tickets.filter((ticket) => isOneOf(ACTIVE_STATUSES, ticket.status)).length

  const status: { label: string; variant: BadgeVariant } = !manager ? { label: 'No manager', variant: 'neutral' }
    : manager.status === 'running' ? { label: 'Manager working', variant: 'warning' }
      : manager.status === 'failed' ? { label: 'Manager’s last run failed', variant: 'error' }
        : { label: 'Manager idle', variant: 'success' }

  return (
    <section aria-label="Team status" className="flex flex-wrap items-end gap-x-8 gap-y-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-kumo-subtle">Manager</span>
        <Badge variant={status.variant} appearance="dot">{status.label}</Badge>
      </div>
      <Meter className="w-56" label="Builders" value={active} max={view.maxBuilders} customValue={`${active} of ${view.maxBuilders}`} />
      <p className="text-xs text-kumo-subtle">Patrols every {Math.round(view.patrolSeconds / 60)} minutes.</p>
    </section>
  )
}

/** What the manager, builders, patrol and merge queue said, newest first. */
function Activity({ messages, tickets, onOpen }: { messages: TeamMessage[]; tickets: Ticket[]; onOpen: (ticket: Ticket) => void }) {
  const [all, setAll] = useState(false)
  const newest = messages.toReversed()
  const shown = all ? newest : newest.slice(0, ACTIVITY_SHOWN)
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]))

  return (
    <section aria-labelledby="activity-heading" className="flex flex-col gap-3">
      <h2 id="activity-heading" className="font-semibold">Activity</h2>
      <LayerCard>
        <LayerCard.Secondary className="my-0 px-4 py-2.5 text-xs font-normal">
          Messages between the manager, its builders, the patrol and the merge queue. The last {messages.length} are kept.
        </LayerCard.Secondary>
        <LayerCard.Primary className="gap-0 p-0 text-sm">
          {shown.length === 0 ? <p className="px-3 py-4 text-kumo-subtle">Nothing yet.</p> : (
            <ol className="flex flex-col divide-y divide-kumo-hairline">
              {shown.map((message) => {
                const ticket = byId.get(message.from) ?? byId.get(message.to)

                return (
                  <TimelineItem
                    key={message.id}
                    message={message}
                    ticketId={ticket?.id}
                    aside={ticket && (
                      <button type="button" onClick={() => onOpen(ticket)} className="cursor-pointer font-mono text-xs text-kumo-link hover:underline" aria-label={`Open ${ticket.id}`}>
                        {ticket.id}
                      </button>
                    )}
                  />
                )
              })}
            </ol>
          )}
          {newest.length > ACTIVITY_SHOWN && (
            <div className="border-t border-kumo-hairline p-2">
              <Button size="sm" variant="ghost" onClick={() => setAll((value) => !value)}>{all ? 'Show fewer' : `Show all ${newest.length}`}</Button>
            </div>
          )}
        </LayerCard.Primary>
      </LayerCard>
    </section>
  )
}
