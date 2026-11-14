import { useEffect, useRef } from 'react'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Loader } from '@cloudflare/kumo/components/loader'
import { recordingPath } from '~/contract'
import { useRemote } from '~/hooks/use-remote'

/** A Browser Run recording as the server sends it: rrweb events, by tab. */
type Recording = { duration: number; events: Record<string, object[]> }

type RecordingError = { error: string }

/**
 * Replays a ticket's QA recording: the rrweb capture of everything the QA
 * agent's browser showed. The tab with the most events is the one QA used.
 * rrweb-player renders into the DOM itself, so it is loaded and mounted
 * only in the browser, once the recording has arrived.
 */
export function RecordingPlayer({ ticketId }: { ticketId: string }) {
  const target = useRef<HTMLDivElement>(null)

  const recording = useRemote(`recording:${ticketId}`, async () => {
    const response = await fetch(recordingPath(ticketId))
    // SAFETY: the recordings endpoint answers a Recording, or a RecordingError on failure.
    const body = await response.json() as Recording | RecordingError

    if ('error' in body) throw new Error(body.error)

    return body
  })

  const events = recording.current ? Object.values(recording.current.events).toSorted((a, b) => b.length - a.length)[0] : undefined

  useEffect(() => {
    const element = target.current

    if (!element || !events?.length) return
    let destroy: (() => void) | undefined
    let cancelled = false

    void Promise.all([import('rrweb-player'), import('rrweb-player/dist/style.css')]).then(([{ default: Player }]) => {
      if (cancelled) return
      const width = Math.max(320, element.clientWidth)
      // SAFETY: Browser Run records rrweb events, which rrweb-player replays as they are.
      const replay = events as ConstructorParameters<typeof Player>[0]['props']['events']
      const player = new Player({ target: element, props: { events: replay, width, height: Math.round(width * 0.56), autoPlay: false, skipInactive: true } })
      destroy = () => player.getReplayer().destroy()
    })

    return () => {
      cancelled = true
      destroy?.()
      element.replaceChildren()
    }
  }, [events])

  if (recording.error) return <Banner variant="error" role="alert" description={recording.error} />

  if (recording.loading) return <div className="flex justify-center py-10"><Loader /></div>

  if (!events?.length) return <Banner description="The recording is empty: the QA browser showed nothing." />

  return <div ref={target} className="w-full overflow-hidden rounded-md" aria-label="QA recording" />
}
