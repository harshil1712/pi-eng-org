import { Badge, type BadgeVariant } from '@cloudflare/kumo/components/badge'
import { DropdownMenu } from '@cloudflare/kumo/components/dropdown'
import { Link } from '@cloudflare/kumo/components/link'
import { cn } from '@cloudflare/kumo/utils'
import { CaretDownIcon, GitPullRequestIcon } from '@phosphor-icons/react'
import { MAX_REVIEW_ROUNDS, type MergeState, type PullRequest, TICKET_STATUSES, type Ticket, type TicketStatus } from '~/contract'

/** Status labels, in the variants dot badges support: success, warning, error and neutral. */
export const STATUS_LABELS: Record<TicketStatus, { label: string; variant: BadgeVariant }> = {
  todo: { label: 'To do', variant: 'neutral' },
  in_progress: { label: 'In progress', variant: 'warning' },
  in_review: { label: 'In review', variant: 'success' },
  blocked: { label: 'Blocked', variant: 'error' },
  done: { label: 'Done', variant: 'neutral' },
  cancelled: { label: 'Cancelled', variant: 'neutral' },
}

export const MERGE_LABELS: Record<MergeState, { label: string; variant: BadgeVariant }> = {
  queued: { label: 'Merge queued', variant: 'neutral' },
  waiting: { label: 'Merging', variant: 'warning' },
  merged: { label: 'Merged', variant: 'success' },
  conflict: { label: 'Merge conflict', variant: 'error' },
  failed: { label: 'Merge failed', variant: 'error' },
}

/** The ticket's status as a dot badge that opens a menu of the others. */
export function StatusMenu({ ticket, onStatus }: { ticket: Ticket; onStatus: (status: TicketStatus) => void }) {
  const status = STATUS_LABELS[ticket.status]

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={(
          <button type="button" className="flex cursor-pointer items-center gap-1 rounded-md" aria-label={`Status of ${ticket.id}: ${status.label}`}>
            <Badge variant={status.variant} appearance="dot">{status.label}</Badge>
            <CaretDownIcon size={10} className="text-kumo-subtle" />
          </button>
        )}
      />
      <DropdownMenu.Content align="start">
        {TICKET_STATUSES.filter((option) => option !== ticket.status).map((option) => (
          <DropdownMenu.Item key={option} onClick={() => onStatus(option)}>{STATUS_LABELS[option].label}</DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

/**
 * Where the ticket is in review, QA and the merge queue, as the badges that
 * still mean something: a done ticket shows only how it merged.
 */
export function ProcessBadges({ ticket }: { ticket: Ticket }) {
  const merge = ticket.merge && MERGE_LABELS[ticket.merge.state]

  if (ticket.status === 'cancelled') return null

  if (ticket.status === 'done') return merge ? <Badge variant={merge.variant}>{merge.label}</Badge> : null

  return (
    <>
      {ticket.review ? (
        <Badge variant={ticket.review.verdict === 'approved' ? 'success' : 'warning'}>
          {ticket.review.verdict === 'approved' ? 'Approved' : 'Changes'} {ticket.review.round}/{MAX_REVIEW_ROUNDS}
        </Badge>
      ) : ticket.reviewRounds > 0 && <Badge variant="neutral">Reviewing {ticket.reviewRounds}/{MAX_REVIEW_ROUNDS}</Badge>}
      {ticket.qaSession && !ticket.qa && <Badge variant="neutral">QA running</Badge>}
      {ticket.qa && <Badge variant={ticket.qa.result === 'pass' ? 'success' : 'error'}>QA {ticket.qa.result}</Badge>}
      {merge && <span title={ticket.merge?.detail}><Badge variant={merge.variant}>{merge.label}</Badge></span>}
    </>
  )
}

export function PullRequestLink({ pullRequest, className }: { pullRequest: PullRequest; className?: string }) {
  return (
    <Link href={pullRequest.url} target="_blank" rel="noreferrer" className={cn('inline-flex shrink-0 items-center gap-1 text-xs', className)} aria-label={`Pull request #${pullRequest.number}`}>
      <GitPullRequestIcon size={12} />#{pullRequest.number}<Link.ExternalIcon />
    </Link>
  )
}

/** Tickets this one waits on that are not done yet. */
export function waitingOn(ticket: Ticket, tickets: Ticket[]): string[] {
  return ticket.dependsOn.filter((id) => tickets.find((entry) => entry.id === id)?.status !== 'done')
}
