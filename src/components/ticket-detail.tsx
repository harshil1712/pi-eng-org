import type { ReactNode } from 'react'
import { Collapsible } from '@cloudflare/kumo/components/collapsible'
import { LayerDialog } from '@cloudflare/kumo/components/layer-dialog'
import { Link } from '@cloudflare/kumo/components/link'
import { CaretRightIcon } from '@phosphor-icons/react'
import { Streamdown } from 'streamdown'
import { MAX_REVIEW_ROUNDS, type SessionSummary, type TeamMessage, type Ticket, type TicketStatus } from '~/contract'
import { parseTeamMessage } from '~/lib/team-message'
import { groupTeamSessions } from '~/lib/team-sessions'
import { LINK_SAFETY } from './link-safety'
import { MERGE_LABELS, ProcessBadges, PullRequestLink, StatusMenu, waitingOn } from './team-parts'

type TicketDetailProps = {
  ticket: Ticket | undefined
  open: boolean
  tickets: Ticket[]
  sessions: SessionSummary[]
  messages: TeamMessage[]
  onOpenChange: (open: boolean) => void
  onStatus: (ticket: Ticket, status: TicketStatus) => void
}

/** One ticket in full: its spec, sessions, pull requests, checks, and what was said about it. */
export function TicketDetail({ ticket, open, tickets, sessions, messages, onOpenChange, onStatus }: TicketDetailProps) {
  return (
    <LayerDialog.Root open={open && Boolean(ticket)} onOpenChange={onOpenChange}>
      {/* LayerDialog wants its Title, Description and Body as direct children. */}
      <LayerDialog.Content size="xl" verticalAlign="top">
        <LayerDialog.Title>
          {ticket && <span className="mr-2 font-mono text-kumo-subtle">{ticket.id}</span>}{ticket?.title ?? 'Ticket'}
        </LayerDialog.Title>
        <LayerDialog.Description>
          {ticket ? `${ticket.repo}${ticket.baseBranch ? ` · from ${ticket.baseBranch}` : ''}` : ''}
        </LayerDialog.Description>
        <LayerDialog.Body>
          {ticket ? <TicketDetailBody ticket={ticket} tickets={tickets} sessions={sessions} messages={messages} onStatus={onStatus} /> : null}
        </LayerDialog.Body>
      </LayerDialog.Content>
    </LayerDialog.Root>
  )
}

function TicketDetailBody({ ticket, tickets, sessions, messages, onStatus }: Omit<TicketDetailProps, 'ticket' | 'open' | 'onOpenChange'> & { ticket: Ticket }) {
  const team = groupTeamSessions(sessions, [ticket])
  const own = [...team.active, ...team.finished].find((entry) => entry.id === ticket.id)
  const waiting = waitingOn(ticket, tickets)
  const timeline = messages.filter((message) => message.from === ticket.id || message.to === ticket.id)

  // The registry logs each pull request a new builder's replaced.
  const superseded = timeline.flatMap((message) => {
    const match = /^Closed pull request #(\d+), superseded by #(\d+)/.exec(message.body)

    return match ? [{ number: Number(match[1]), by: Number(match[2]) }] : []
  })

  const linked = [
    ...own?.builder ? [{ session: own.builder, role: 'Builder' }] : [],
    ...own?.reviewers.map((session) => ({ session, role: 'Reviewer' })) ?? [],
    ...own?.qa.map((session) => ({ session, role: 'QA' })) ?? [],
    ...own?.earlier.map((session) => ({ session, role: 'Earlier builder' })) ?? [],
  ]

  return (
    // The dialog's scroll area is as wide as its widest child: containment
    // keeps long, truncated lines from widening it past the dialog.
    <div className="flex min-w-0 flex-col gap-5 text-sm wrap-anywhere [contain:inline-size]">
          <div className="flex flex-wrap items-center gap-2">
            <StatusMenu ticket={ticket} onStatus={(status) => onStatus(ticket, status)} />
            <ProcessBadges ticket={ticket} />
            {ticket.pullRequest && <PullRequestLink pullRequest={ticket.pullRequest} />}
            {superseded.map(({ number, by }) => (
              <span key={number} className="text-xs text-kumo-subtle">#{number} closed, superseded by #{by}</span>
            ))}
          </div>
          {waiting.length > 0 && <p className="text-kumo-subtle">Waits on {waiting.join(', ')}.</p>}
          {ticket.note && <p className="rounded-md bg-kumo-recessed px-3 py-2 text-kumo-strong">{ticket.note}</p>}

          <Section title="Spec">
            <div className="message-markdown max-h-80 overflow-y-auto rounded-md bg-kumo-recessed px-4 py-3 leading-relaxed [&_:is(h1,h2,h3,h4)]:text-sm [&_:is(h1,h2,h3,h4)]:font-semibold [&_pre]:overflow-x-auto">
              <Streamdown linkSafety={LINK_SAFETY}>{ticket.spec}</Streamdown>
            </div>
          </Section>

          {linked.length > 0 && (
            <Section title="Sessions">
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {linked.map(({ session, role }) => (
                  <li key={session.id} className="flex items-center gap-1.5">
                    <Link href={`/sessions/${session.id}`}>{role}</Link>
                    {session.status === 'running' && <span className="text-xs text-kumo-subtle">working</span>}
                    {session.status === 'failed' && <span className="text-xs text-kumo-danger">last run failed</span>}
                    {session.pullRequest && <span className="text-xs text-kumo-subtle">#{session.pullRequest.number}</span>}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {(ticket.review || ticket.qa || ticket.merge) && (
            <Section title="Checks">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                {ticket.review && (
                  <Check label="Review" headline={`${ticket.review.verdict === 'approved' ? 'Approved' : 'Changes requested'} in round ${ticket.review.round} of ${MAX_REVIEW_ROUNDS}`} body={ticket.review.comments} />
                )}
                {ticket.qa && <Check label="QA" headline={ticket.qa.result === 'pass' ? 'Passed' : 'Failed'} body={ticket.qa.summary} />}
                {ticket.merge && <Check label="Merge" headline={`${MERGE_LABELS[ticket.merge.state].label}, after ${ticket.merge.attempts} attempts`} body={ticket.merge.detail} />}
              </dl>
            </Section>
          )}

          <Section title="Timeline">
            {timeline.length === 0 ? <p className="text-kumo-subtle">Nothing yet.</p> : (
              <ol className="flex flex-col divide-y divide-kumo-hairline rounded-lg border border-kumo-hairline">
                {timeline.map((message) => <TimelineItem key={message.id} message={message} ticketId={ticket.id} />)}
              </ol>
            )}
          </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-kumo-subtle uppercase">{title}</h3>
      {children}
    </section>
  )
}

function Check({ label, headline, body }: { label: string; headline: string; body?: string }) {
  return (
    <>
      <dt className="text-kumo-subtle">{label}</dt>
      <dd className="min-w-0">
        {body ? (
          <Collapsible.Root className="group/check">
            <Collapsible.Trigger className="flex cursor-pointer items-center gap-1 text-left hover:underline">
              {headline}<CaretRightIcon size={12} className="transition-transform group-data-[open]/check:rotate-90" aria-hidden="true" />
            </Collapsible.Trigger>
            <Collapsible.Panel className="message-markdown mt-2 max-h-72 overflow-y-auto rounded-md bg-kumo-recessed px-3 py-2 text-xs leading-relaxed [&_:is(h1,h2,h3,h4)]:text-sm">
              <Streamdown linkSafety={LINK_SAFETY}>{body}</Streamdown>
            </Collapsible.Panel>
          </Collapsible.Root>
        ) : headline}
      </dd>
    </>
  )
}

/** Who a log entry is from or to, in words: a ticket's own ID means its builder. */
export function partyName(party: string, ticketId?: string): string {
  if (party === ticketId) return 'Builder'

  if (party === 'human') return 'You'

  if (party === 'merge-queue') return 'Merge queue'

  return party.charAt(0).toUpperCase() + party.slice(1)
}

/** One log entry: its time, who to whom, and a line; opens to the whole message. `aside` sits at the row's end. */
export function TimelineItem({ message, ticketId, aside }: { message: TeamMessage; ticketId?: string; aside?: ReactNode }) {
  const parsed = parseTeamMessage(message.body)
  const summary = parsed?.summary || message.body.split('\n')[0]
  const long = message.body.length > summary.length + 2

  const head = (
    <>
      <time dateTime={message.at} className="w-16 shrink-0 text-xs text-kumo-subtle tabular-nums">{new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
      <span className="w-40 shrink-0 truncate text-xs text-kumo-subtle">{partyName(message.from, ticketId)} → {partyName(message.to, ticketId)}</span>
      <span className="min-w-0 flex-1 truncate">{summary}</span>
    </>
  )

  if (!long) return <li className="flex items-center gap-3 px-3 py-2">{head}{aside}</li>

  return (
    <li className="flex items-start">
      <Collapsible.Root className="group/item min-w-0 flex-1">
        <Collapsible.Trigger className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left hover:bg-kumo-tint">
          {head}
          <CaretRightIcon size={12} className="shrink-0 text-kumo-subtle transition-transform group-data-[open]/item:rotate-90" aria-hidden="true" />
        </Collapsible.Trigger>
        <Collapsible.Panel className="message-markdown max-h-80 overflow-y-auto border-t border-kumo-hairline bg-kumo-recessed px-4 py-3 text-xs leading-relaxed [&_:is(h1,h2,h3,h4)]:text-sm">
          <Streamdown linkSafety={LINK_SAFETY}>{parsed?.body ?? message.body}</Streamdown>
        </Collapsible.Panel>
      </Collapsible.Root>
      {aside && <span className="flex shrink-0 py-2 pr-3">{aside}</span>}
    </li>
  )
}
