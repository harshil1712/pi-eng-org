import { useState } from 'react'
import { ClientOnly, useLocation, useNavigate, useParams } from '@tanstack/react-router'
import { Button } from '@cloudflare/kumo/components/button'
import { DropdownMenu } from '@cloudflare/kumo/components/dropdown'
import { Sidebar, useSidebar } from '@cloudflare/kumo/components/sidebar'
import { useKumoToastManager } from '@cloudflare/kumo/components/toast'
import { cn } from '@cloudflare/kumo/utils'
import { ChatsCircleIcon, CheckCircleIcon, DotsThreeIcon, GearSixIcon, GitPullRequestIcon, KanbanIcon, NotePencilIcon, PencilSimpleIcon, TrashIcon, UserCircleGearIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { PiMark } from './pi-mark'
import { ThemeToggle } from './theme-toggle'
import type { SessionSummary } from '~/contract'
import { DeleteSessionDialog, RenameSessionDialog } from './session-dialogs'
import { displayName, useSessionRegistry } from '~/hooks/use-session-registry'
import { errorMessage } from '~/lib/error-message'
import { groupTeamSessions, type TicketSessions } from '~/lib/team-sessions'

const DAY = 24 * 60 * 60 * 1000

/** Sessions by when they were last active, newest first, as the registry lists them. */
function groupByRecency(sessions: SessionSummary[], now: number) {
  const today = new Date(now).setHours(0, 0, 0, 0)
  const groups: { label: string; sessions: SessionSummary[] }[] = []

  for (const session of sessions) {
    const at = Date.parse(session.updatedAt)
    const label = at >= today ? 'Today' : at >= today - DAY ? 'Yesterday' : at >= today - 6 * DAY ? 'Previous 7 days' : 'Older'
    const group = groups.at(-1)

    if (group?.label === label) group.sessions.push(session)
    else groups.push({ label, sessions: [session] })
  }

  return groups
}

/** A pulsing dot while pi runs, in the colour of the session page's Running badge, a warning after a failed run, nothing when idle. */
function StatusMarker({ status }: { status: SessionSummary['status'] | 'idle' }) {
  if (status === 'running') {
    return (
      <span className="flex size-3 shrink-0 items-center justify-center" title="Running">
        <span aria-hidden className="size-2 rounded-full bg-kumo-warning motion-safe:animate-pulse" />
        <span className="sr-only">(running)</span>
      </span>
    )
  }

  if (status === 'failed') {
    return (
      <span className="flex shrink-0 items-center text-kumo-danger" title="Last run failed">
        <WarningCircleIcon aria-hidden size={13} />
        <span className="sr-only">(last run failed)</span>
      </span>
    )
  }

  return null
}

type SessionAction = { action: 'rename' | 'delete'; session: SessionSummary }

export function SessionSidebar() {
  const registry = useSessionRegistry()
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const { isMobile, setOpenMobile } = useSidebar()
  const { sessionId } = useParams({ strict: false })
  const pathname = useLocation({ select: (location) => location.pathname })
  // The ticket open on the board, from its `?ticket=` search.
  const openTicket = useLocation({ select: (location) => (location.pathname === '/team' ? new URLSearchParams(location.searchStr).get('ticket') ?? undefined : undefined) })
  // The target outlives `open` so the dialog keeps its text while it animates closed.
  const [dialog, setDialog] = useState<SessionAction & { open: boolean } | null>(null)
  const closeDialog = (open: boolean) => { if (!open) setDialog((current) => current && { ...current, open: false }) }

  const onAction = (action: SessionAction) => setDialog({ ...action, open: true })

  const team = groupTeamSessions(registry.sessions, registry.team?.tickets ?? [])
  const groups = groupByRecency(team.solo, registry.asOf)
  const inbox = registry.team?.tickets.filter((ticket) => ticket.humanReview).length ?? 0
  // On a phone the sidebar is a sheet over the page; picking a destination closes it.
  const closeOnMobile = () => { if (isMobile) setOpenMobile(false) }

  const item = { currentId: sessionId, onNavigate: closeOnMobile, onAction }

  async function act<T>(operation: () => Promise<T>) {
    try {
      await operation()
    } catch (caught) {
      toasts.add({ variant: 'error', title: 'Something went wrong', description: errorMessage(caught) })
    }
  }

  return (
    <>
      <Sidebar aria-label="Sessions">
        <Sidebar.Header className="gap-0.5 pr-2 pl-4">
          <span className="mr-auto flex items-center gap-2 font-semibold"><PiMark />Pi</span>
          <Button
            shape="square"
            size="sm"
            variant="ghost"
            aria-label="New session"
            title="New session"
            icon={<NotePencilIcon size={17} />}
            onClick={() => { closeOnMobile(); void navigate({ to: '/' }) }}
          />
          {!isMobile && <Sidebar.Trigger aria-label="Hide sessions" title="Hide sessions" />}
        </Sidebar.Header>
        <Sidebar.Content>
          {/* The team first: its board, its manager, and each ticket's sessions folded under the ticket. */}
          <Sidebar.Group>
            <Sidebar.GroupLabel>Team</Sidebar.GroupLabel>
            <Sidebar.Menu>
              <Sidebar.MenuButton icon={KanbanIcon} href="/team" active={pathname === '/team' && !openTicket} aria-current={pathname === '/team' && !openTicket ? 'page' : undefined} onClick={closeOnMobile}>
                Board
                {inbox > 0 && <Sidebar.MenuBadge aria-label={`${inbox} ready for your review`}>{inbox}</Sidebar.MenuBadge>}
              </Sidebar.MenuButton>
              {team.manager && (
                <SessionItem {...item} session={team.manager} label="Manager" icon={<UserCircleGearIcon size={16} />} />
              )}
              {team.active.map((ticket) => <TicketItem key={ticket.id} {...item} openTicket={openTicket} ticket={ticket} />)}
              {team.finished.length > 0 && (
                <Sidebar.MenuItem>
                  <Sidebar.Collapsible defaultOpen={team.finished.some((ticket) => ticketHas(ticket, sessionId) || openTicket === ticket.id)}>
                    <Sidebar.CollapsibleTrigger
                      render={(
                        <Sidebar.MenuButton icon={CheckCircleIcon}>
                          Finished
                          <Sidebar.MenuBadge>{team.finished.length}</Sidebar.MenuBadge>
                          <Sidebar.MenuChevron />
                        </Sidebar.MenuButton>
                      )}
                    />
                    <Sidebar.CollapsibleContent>
                      <Sidebar.MenuSub>
                        {team.finished.map((ticket) => <TicketItem key={ticket.id} {...item} openTicket={openTicket} ticket={ticket} nested />)}
                      </Sidebar.MenuSub>
                    </Sidebar.CollapsibleContent>
                  </Sidebar.Collapsible>
                </Sidebar.MenuItem>
              )}
            </Sidebar.Menu>
          </Sidebar.Group>
          {registry.loading && registry.sessions.length === 0 ? (
            // Kumo's skeleton lines pick random widths as they render, which
            // never match between the server and the browser.
            <ClientOnly><Sidebar.Loading label="Loading sessions" /></ClientOnly>
          ) : team.solo.length === 0 ? (
            <Sidebar.Group>
              <Sidebar.GroupLabel>Sessions</Sidebar.GroupLabel>
              <p className="flex items-center gap-2 px-3 py-1 text-xs text-kumo-subtle">
                <ChatsCircleIcon size={16} className="shrink-0 text-kumo-inactive" />
                Sessions you start appear here.
              </p>
            </Sidebar.Group>
          ) : groups.map((group) => (
            <Sidebar.Group key={group.label}>
              <Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
              <Sidebar.Menu>
                {group.sessions.map((session) => <SessionItem key={session.id} {...item} session={session} />)}
              </Sidebar.Menu>
            </Sidebar.Group>
          ))}
        </Sidebar.Content>
        <Sidebar.Footer className="flex items-center gap-0.5 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <span className="mr-auto text-xs text-kumo-subtle">Pi on Cloudflare</span>
          <Button
            shape="square"
            size="sm"
            variant="ghost"
            aria-label="Settings"
            title="Settings"
            icon={<GearSixIcon size={16} />}
            onClick={() => { closeOnMobile(); void navigate({ to: '/settings' }) }}
          />
          <ThemeToggle />
        </Sidebar.Footer>
      </Sidebar>
      {dialog && (
        <>
          <RenameSessionDialog
            name={dialog.session.name}
            open={dialog.open && dialog.action === 'rename'}
            onOpenChange={closeDialog}
            onRename={(name) => void act(() => registry.agent.stub.renameSession(dialog.session.id, name))}
          />
          <DeleteSessionDialog
            name={displayName(dialog.session)}
            open={dialog.open && dialog.action === 'delete'}
            onOpenChange={closeDialog}
            onDelete={() => void act(async () => {
              const { id } = dialog.session
              await registry.agent.stub.deleteSession(id)

              // The open session is gone, so go home rather than to a dead page.
              if (id === sessionId) await navigate({ to: '/' })
            })}
          />
        </>
      )}
    </>
  )
}

type ItemProps = {
  currentId: string | undefined
  onNavigate: () => void
  onAction: (action: SessionAction) => void
}

function ticketHas(ticket: TicketSessions, id: string | undefined): boolean {
  return [ticket.builder, ...ticket.earlier, ...ticket.reviewers, ...ticket.qa].some((session) => session?.id === id)
}

/** A top-level session: the manager, or one a person started. */
function SessionItem({ session, label, icon, currentId, onNavigate, onAction }: ItemProps & { session: SessionSummary; label?: string; icon?: React.ReactNode }) {
  const current = session.id === currentId

  return (
    <Sidebar.MenuItem className="group/session relative">
      <Sidebar.MenuButton href={`/sessions/${session.id}`} active={current} aria-current={current ? 'page' : undefined} onClick={onNavigate} icon={icon} className="pr-8">
        <span className="flex min-w-0 flex-1 flex-col py-0.5">
          <span className="truncate">{label ?? displayName(session)}</span>
          {!label && session.repo && session.repo !== displayName(session) && (
            <span className="truncate text-xs text-kumo-subtle">{session.repo}</span>
          )}
        </span>
        <StatusMarker status={session.status} />
        <PullRequestNumber session={session} />
      </Sidebar.MenuButton>
      <SessionActions session={session} onAction={onAction} />
    </Sidebar.MenuItem>
  )
}

/** A ticket, folded open while it has work going on or holds the open session, with its sessions under it. */
function TicketItem({ ticket, nested = false, currentId, openTicket, onNavigate, onAction }: ItemProps & { ticket: TicketSessions; nested?: boolean; openTicket: string | undefined }) {
  const label = (
    <>
      <span className="shrink-0 font-mono text-xs text-kumo-subtle">{ticket.id}</span>
      <span className="min-w-0 flex-1 truncate text-left">{ticket.title}</span>
      <StatusMarker status={ticket.activity} />
      <Sidebar.MenuChevron />
    </>
  )

  const sessions = [
    ...ticket.builder ? [{ session: ticket.builder, label: 'Builder' }] : [],
    ...ticket.reviewers.map((session) => ({ session, label: 'Review' })),
    ...ticket.qa.map((session) => ({ session, label: 'QA' })),
    ...ticket.earlier.map((session) => ({ session, label: 'Earlier builder' })),
  ]

  const content = (
    <Sidebar.Collapsible defaultOpen={ticket.activity === 'running' || ticketHas(ticket, currentId) || openTicket === ticket.id}>
      <Sidebar.CollapsibleTrigger
        render={nested
          ? <Sidebar.MenuSubButton aria-label={`${ticket.id}: ${ticket.title}`} title={ticket.title}>{label}</Sidebar.MenuSubButton>
          : <Sidebar.MenuButton aria-label={`${ticket.id}: ${ticket.title}`} title={ticket.title}>{label}</Sidebar.MenuButton>}
      />
      <Sidebar.CollapsibleContent>
        <Sidebar.MenuSub>
          {/* The ticket itself: its spec, checks and timeline on the board. */}
          <Sidebar.MenuSubButton href={`/team?ticket=${ticket.id}`} active={openTicket === ticket.id} aria-current={openTicket === ticket.id ? 'page' : undefined} onClick={onNavigate}>
            Details
          </Sidebar.MenuSubButton>
          {sessions.map(({ session, label: role }) => {
            const current = session.id === currentId

            return (
              <Sidebar.MenuSubItem key={session.id} className="group/session relative">
                <Sidebar.MenuSubButton href={`/sessions/${session.id}`} active={current} aria-current={current ? 'page' : undefined} onClick={onNavigate} className="pr-8">
                  <span className="min-w-0 flex-1 truncate">{role}</span>
                  <StatusMarker status={session.status} />
                  <PullRequestNumber session={session} />
                </Sidebar.MenuSubButton>
                <SessionActions session={session} onAction={onAction} />
              </Sidebar.MenuSubItem>
            )
          })}
        </Sidebar.MenuSub>
      </Sidebar.CollapsibleContent>
    </Sidebar.Collapsible>
  )

  return nested ? <Sidebar.MenuSubItem>{content}</Sidebar.MenuSubItem> : <Sidebar.MenuItem>{content}</Sidebar.MenuItem>
}

function PullRequestNumber({ session }: { session: SessionSummary }) {
  if (!session.pullRequest) return null

  return (
    <span className="flex shrink-0 items-center gap-0.5 text-xs text-kumo-subtle" title={`Pull request #${session.pullRequest.number}`}>
      <GitPullRequestIcon size={12} />{session.pullRequest.number}
    </span>
  )
}

/** Rename and delete, shown on hover beside a session. */
function SessionActions({ session, onAction }: { session: SessionSummary; onAction: (action: SessionAction) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={(
          <Button
            shape="square"
            size="xs"
            variant="ghost"
            aria-label={`Actions for ${displayName(session)}`}
            icon={<DotsThreeIcon size={16} weight="bold" />}
            className={cn(
              'absolute top-1/2 right-1 -translate-y-1/2 transition-opacity',
              'md:opacity-0 md:group-hover/session:opacity-100 md:group-focus-within/session:opacity-100 md:data-popup-open:opacity-100',
            )}
          />
        )}
      />
      <DropdownMenu.Content align="end">
        <DropdownMenu.Item icon={PencilSimpleIcon} onClick={() => onAction({ action: 'rename', session })}>Rename</DropdownMenu.Item>
        <DropdownMenu.Item icon={TrashIcon} variant="danger" onClick={() => onAction({ action: 'delete', session })}>Delete</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
