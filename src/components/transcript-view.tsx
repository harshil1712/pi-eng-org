import { lazy, memo, Suspense } from 'react'
import type { RefObject, UIEventHandler } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Empty } from '@cloudflare/kumo/components/empty'
import { Loader } from '@cloudflare/kumo/components/loader'
import { cn } from '@cloudflare/kumo/utils'
import { Streamdown } from 'streamdown'
import { LINK_SAFETY } from './link-safety'
import { PiMark } from './pi-mark'
import type { TranscriptEntry } from '~/lib/transcript'
import { ActivityCard } from './activity-card'
import { parseTeamMessage } from '~/lib/team-message'
import { TeamMessageCard } from './team-message-card'

const HighlightedMarkdown = lazy(() => import('./highlighted-code').then((module) => ({ default: module.HighlightedMarkdown })))

function latestAssistantText(entries: TranscriptEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]

    if (entry?.type === 'message' && entry.role === 'assistant') return entry.text
  }

  return ''
}

function isUserMessage(entry: TranscriptEntry | undefined) {
  return entry?.type === 'message' && entry.role === 'user'
}

type TranscriptViewProps = {
  activeTextId: string
  entries: TranscriptEntry[]
  isRunning: boolean
  onScroll: UIEventHandler<HTMLDivElement>
  onTryOperation: () => void
  transcriptRef: RefObject<HTMLDivElement | null>
  /** A team session: its first message is the brief the team sent it. */
  team?: boolean
}

export function TranscriptView({ activeTextId, entries, isRunning, onScroll, onTryOperation, transcriptRef, team = false }: TranscriptViewProps) {
  const assistantText = latestAssistantText(entries)
  const briefId = team ? entries.find(isUserMessage)?.id : undefined

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pt-4 pb-2 md:px-5 md:pt-6" ref={transcriptRef} onScroll={onScroll} aria-busy={isRunning} role="log" aria-live="off">
      <span className="sr-only" aria-live="polite" aria-atomic="true">{isRunning ? 'Pi is working.' : assistantText ? `Pi replied: ${assistantText}` : 'Pi is ready.'}</span>
      {entries.length === 0 ? (
        <div className="grid h-full place-items-center">
          <Empty
            className="max-w-xl border-0 bg-transparent"
            icon={<PiMark size="lg" />}
            title="What should Pi work on?"
            description="Pi runs inside a Cloudflare Durable Object and can read and write files in this session’s workspace."
            contents={<Button variant="secondary" size="sm" onClick={onTryOperation}>Try an example</Button>}
          />
        </div>
      ) : (
        <div className="mx-auto w-full max-w-190">
          {entries.map((entry) => <TranscriptRow active={entry.id === activeTextId} brief={entry.id === briefId} entry={entry} isRunning={isRunning} key={entry.id} />)}
          {isRunning && isUserMessage(entries.at(-1)) && (
            <div className="-mt-2 mb-5 flex animate-enter items-center gap-2 text-sm text-kumo-subtle" aria-hidden="true"><Loader size="sm" /> Working…</div>
          )}
        </div>
      )}
    </div>
  )
}

const TranscriptRow = memo(function TranscriptRow({ active, brief, entry, isRunning }: {
  active: boolean
  /** Whether this is the brief a team session started with. */
  brief: boolean
  entry: TranscriptEntry
  isRunning: boolean
}) {
  if (entry.type !== 'message') return <ActivityCard entry={entry} />
  // Messages the team wrote fold into a card, so the agent's replies stand out.
  const teamMessage = entry.role === 'user' ? parseTeamMessage(entry.text, brief) : undefined

  if (teamMessage) return <TeamMessageCard message={teamMessage} />

  return (
    <article className={cn('mb-5 animate-enter', entry.role === 'user' && 'flex justify-end')}>
      <span className="sr-only">{entry.role === 'user' ? 'You:' : 'Pi:'}</span>
      <div className={cn(
        'message-body text-[15px] leading-relaxed wrap-anywhere',
        entry.role === 'user' ? 'max-w-[85%] rounded-2xl bg-kumo-tint px-3.5 py-2 whitespace-pre-wrap' : 'message-markdown',
      )}>
        {entry.role === 'assistant' && entry.text ? entry.text.includes('```') ? (
          <Suspense fallback={<Streamdown linkSafety={LINK_SAFETY}>{entry.text}</Streamdown>}>
            <HighlightedMarkdown active={active}>{entry.text}</HighlightedMarkdown>
          </Suspense>
        ) : (
          <Streamdown caret={active ? 'block' : undefined} isAnimating={active} linkSafety={LINK_SAFETY}>{entry.text}</Streamdown>
        ) : entry.text || (isRunning && active ? <span className="inline-block h-[15px] w-2 animate-blink rounded-xs bg-kumo-subtle align-text-bottom" /> : '')}
      </div>
    </article>
  )
})
