import { createFileRoute } from '@tanstack/react-router'
import { TeamPage } from '~/components/team-page'
import { isString } from '~/lib/json'

/** The page's search: `ticket` opens that ticket's detail, so a link can point at it. */
type TeamSearch = { ticket?: string }

export const Route = createFileRoute('/team')({
  validateSearch: ({ ticket }): TeamSearch => (isString(ticket) && /^T-\d+$/.test(ticket) ? { ticket } : {}),
  component: TeamRoute,
})

function TeamRoute() {
  const { ticket } = Route.useSearch()

  return <TeamPage ticketId={ticket} />
}
