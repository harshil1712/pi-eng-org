import { getAgentByName } from 'agents'
import { BrowserRenderingError, getBrowserRecording } from 'agents/browser'
import { PI_REGISTRY_INSTANCE } from '~/contract'
import { errorMessage } from '~/lib/error-message'

/** Settings the app runs without, which `wrangler types` therefore does not declare. */
export type RecordingEnv = Env & { CLOUDFLARE_ACCOUNT_ID?: string; BROWSER_RECORDING_TOKEN?: string }

/** The team page's QA recordings: `/team/recordings/<ticket>`. */
export const RECORDINGS_PATH = /^\/team\/recordings\/([^/]+)$/

/**
 * Serve the rrweb recording of a ticket's QA run, from Browser Run's REST
 * API. The Browser binding cannot read recordings, so this needs
 * `CLOUDFLARE_ACCOUNT_ID` and a `BROWSER_RECORDING_TOKEN` with Browser
 * Rendering read access. Recordings exist only once the QA browser closed,
 * and Browser Run keeps them for 30 days. Behind Cloudflare Access with the
 * rest of the app: a recording shows whatever the QA browser saw.
 */
export async function handleRecording(request: Request, env: RecordingEnv, ticketId: string): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const apiToken = env.BROWSER_RECORDING_TOKEN?.trim()

  if (!accountId || !apiToken) {
    return Response.json({ error: 'Set CLOUDFLARE_ACCOUNT_ID and the BROWSER_RECORDING_TOKEN secret to watch QA recordings.' }, { status: 501 })
  }

  const registry = await getAgentByName(env.PiRegistry, PI_REGISTRY_INSTANCE)
  const sessionId = await registry.qaRecording(decodeURIComponent(ticketId))

  if (!sessionId) return Response.json({ error: 'This ticket has no QA recording.' }, { status: 404 })

  try {
    const recording = await getBrowserRecording({ accountId, apiToken, sessionId })

    return Response.json(recording, { headers: { 'Cache-Control': 'private, max-age=3600' } })
  } catch (error) {
    // Browser Run answers 404 until the session has closed and the recording is finalized.
    const status = error instanceof BrowserRenderingError && error.status === 404 ? 404 : 502

    return Response.json({ error: status === 404 ? 'The recording is not ready yet. Try again in a minute.' : errorMessage(error) }, { status })
  }
}
