import type { ReactNode } from 'react'
import { Badge } from '@cloudflare/kumo/components/badge'
import { Button } from '@cloudflare/kumo/components/button'
import { Collapsible } from '@cloudflare/kumo/components/collapsible'
import { LayerCard } from '@cloudflare/kumo/components/layer-card'
import { CheckCircleIcon, MinusCircleIcon, PlayCircleIcon, RocketLaunchIcon, TrayIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { Streamdown } from 'streamdown'
import { MAX_REVIEW_ROUNDS, type Ticket } from '~/contract'
import { LINK_SAFETY } from './link-safety'
import { PullRequestLink } from './team-parts'

type InboxProps = {
  tickets: Ticket[]
  onOpen: (ticket: Ticket) => void
  onWatch: (ticket: Ticket) => void
  onShip: (ticket: Ticket) => void
  onSendBack: (ticket: Ticket) => void
}

/**
 * The person's review inbox: tickets the manager says are ready. This is the
 * step not to skip: read the summary, watch the recording, then ship.
 */
export function Inbox({ tickets, onOpen, onWatch, onShip, onSendBack }: InboxProps) {
  return (
    <section aria-labelledby="inbox-heading" className="flex flex-col gap-3">
      <h2 id="inbox-heading" className="flex items-center gap-2 font-semibold">
        <TrayIcon size={18} />Ready for your review
        <Badge variant={tickets.length ? 'primary' : 'neutral'}>{tickets.length}</Badge>
      </h2>
      {tickets.length === 0 ? (
        // Usually empty, so one quiet line rather than a placeholder that pushes the board down.
        <p className="flex items-center gap-2 text-sm text-kumo-subtle">
          <CheckCircleIcon size={16} className="shrink-0" />
          Nothing to review. When a pull request has passed review and QA, the manager puts it here for you to watch and ship.
        </p>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {tickets.map((ticket) => (
            <li key={ticket.id} aria-label={`Review ${ticket.id}`} className="min-w-0">
              <InboxCard ticket={ticket} onOpen={() => onOpen(ticket)} onWatch={() => onWatch(ticket)} onShip={() => onShip(ticket)} onSendBack={() => onSendBack(ticket)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function InboxCard({ ticket, onOpen, onWatch, onShip, onSendBack }: { ticket: Ticket; onOpen: () => void; onWatch: () => void; onShip: () => void; onSendBack: () => void }) {
  const { review, qa } = ticket
  const approved = review?.verdict === 'approved'

  return (
    <LayerCard className="h-full">
      <LayerCard.Secondary className="my-0 gap-2 px-4 py-3 text-sm">
        <span className="shrink-0 font-mono text-xs">{ticket.id}</span>
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 cursor-pointer truncate text-left font-medium text-kumo-default hover:underline" title={ticket.title}>
          {ticket.title}
        </button>
        {ticket.pullRequest && <PullRequestLink pullRequest={ticket.pullRequest} />}
      </LayerCard.Secondary>
      <LayerCard.Primary className="flex-1 gap-4 text-sm">
        <div className="message-markdown leading-relaxed">
          <Streamdown linkSafety={LINK_SAFETY}>{ticket.humanReview?.summary ?? ''}</Streamdown>
        </div>
        <div className="flex flex-col gap-2 border-t border-kumo-hairline pt-3">
          <Verdict
            label="Review"
            icon={approved ? <CheckCircleIcon size={16} className="text-kumo-success" /> : <WarningCircleIcon size={16} className="text-kumo-warning" />}
            headline={review ? `${approved ? 'Approved' : 'Changes requested'} in round ${review.round} of ${MAX_REVIEW_ROUNDS}` : 'Not reviewed'}
            details={review?.comments}
          />
          <Verdict
            label="QA"
            // No QA run is not a failure: changes with nothing to see need none.
            icon={qa?.result === 'pass' ? <CheckCircleIcon size={16} className="text-kumo-success" /> : qa ? <WarningCircleIcon size={16} className="text-kumo-danger" /> : <MinusCircleIcon size={16} className="text-kumo-subtle" />}
            headline={qa ? `${qa.result === 'pass' ? 'Passed' : 'Failed'}${qa.recording ? ', with a recording' : ''}` : 'No QA run'}
            details={qa?.summary}
          />
        </div>
        <div className="mt-auto flex flex-wrap items-center justify-end gap-2">
          {qa?.recording && <Button size="sm" variant="secondary" icon={<PlayCircleIcon size={16} />} onClick={onWatch}>Watch recording</Button>}
          <Button size="sm" variant="secondary" onClick={onSendBack}>Send back</Button>
          <Button size="sm" variant="primary" icon={<RocketLaunchIcon size={16} />} onClick={onShip}>Ship it</Button>
        </div>
      </LayerCard.Primary>
    </LayerCard>
  )
}

/** One check's result in a line, with what it said folded underneath. */
function Verdict({ label, icon, headline, details }: { label: string; icon: ReactNode; headline: string; details?: string }) {
  const line = (
    <>
      <span className="w-14 shrink-0 text-xs text-kumo-subtle">{label}</span>
      <span className="flex shrink-0">{icon}</span>
      <span className="min-w-0 text-left">{headline}</span>
    </>
  )

  if (!details) return <div className="flex items-center gap-2">{line}</div>

  return (
    <Collapsible.Root className="group/verdict">
      <Collapsible.Trigger className="flex w-full cursor-pointer items-center gap-2 rounded-md text-left hover:text-kumo-default">
        {line}
        <span className="ml-auto shrink-0 text-xs text-kumo-link group-data-[open]/verdict:hidden">Read</span>
        <span className="ml-auto hidden shrink-0 text-xs text-kumo-link group-data-[open]/verdict:inline">Hide</span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="message-markdown mt-2 max-h-72 overflow-y-auto rounded-md bg-kumo-recessed px-3 py-2 text-xs leading-relaxed [&_:is(h1,h2,h3,h4)]:text-sm">
        <Streamdown linkSafety={LINK_SAFETY}>{details}</Streamdown>
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}
