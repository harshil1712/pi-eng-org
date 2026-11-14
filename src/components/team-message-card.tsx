import { useState } from 'react'
import { Collapsible } from '@cloudflare/kumo/components/collapsible'
import { LayerCard } from '@cloudflare/kumo/components/layer-card'
import { type Icon, CaretRightIcon, ClipboardTextIcon, ClockClockwiseIcon, EyeIcon, GitMergeIcon, ListChecksIcon, TestTubeIcon, UserCircleGearIcon, UserIcon } from '@phosphor-icons/react'
import { Streamdown } from 'streamdown'
import type { TeamMessageKind, TeamMessageView } from '~/lib/team-message'
import { LINK_SAFETY } from './link-safety'

const ICONS: Record<TeamMessageKind, Icon> = {
  update: ListChecksIcon,
  patrol: ClockClockwiseIcon,
  manager: UserCircleGearIcon,
  reviewer: EyeIcon,
  qa: TestTubeIcon,
  person: UserIcon,
  merge: GitMergeIcon,
  brief: ClipboardTextIcon,
}

/**
 * A message the team sent this session, not one a person typed: updates,
 * patrols, briefs and messages between agents. Folded to one line, so the
 * agent's own replies stand out, and opened to read the whole thing.
 */
export function TeamMessageCard({ message }: { message: TeamMessageView }) {
  const [open, setOpen] = useState(false)
  const MessageIcon = ICONS[message.kind]

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="mb-5 animate-enter" aria-label={`Automated message: ${message.label}`}>
      <LayerCard>
        <LayerCard.Secondary className="my-0 p-0">
          <Collapsible.Trigger aria-label={message.summary ? `${message.label}: ${message.summary}` : message.label} className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm hover:text-kumo-default">
            <MessageIcon size={15} className="shrink-0" aria-hidden="true" />
            <span className="shrink-0 font-medium text-kumo-default">{message.label}</span>
            {message.summary && <span className="min-w-0 flex-1 truncate font-normal">{message.summary}</span>}
            <CaretRightIcon size={13} className={`ml-auto shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
          </Collapsible.Trigger>
        </LayerCard.Secondary>
        {open && (
          <LayerCard.Primary className="message-markdown max-h-96 overflow-y-auto px-4 py-3 text-sm leading-relaxed [&_:is(h1,h2,h3,h4)]:text-sm [&_:is(h1,h2,h3,h4)]:font-semibold">
            <Collapsible.Panel>
              <Streamdown linkSafety={LINK_SAFETY}>{message.body}</Streamdown>
            </Collapsible.Panel>
          </LayerCard.Primary>
        )}
      </LayerCard>
    </Collapsible.Root>
  )
}
