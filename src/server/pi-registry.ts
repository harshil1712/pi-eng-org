import { Agent, callable, type Connection } from 'agents'
import { type RoutedAgentEntry, RoutedAgents } from 'agents/routing'
import {
  type ConnectMcpServerInput,
  type ConnectMcpServerResult,
  type CreateSessionInput,
  type CreateTicketInput,
  MAX_REVIEW_ROUNDS,
  type McpServerSummary,
  type ModelOption,
  PI_AGENT_PREFIX,
  PI_SESSIONS_ROUTE,
  type PiRegistryState,
  type PullRequest,
  type Repository,
  type RunStatus,
  type SessionSummary,
  type TeamRole,
  type TeamView,
  type Ticket,
  type TicketMerge,
  type TicketProcess,
  type UpdateTicketInput,
} from '~/contract'
import { Board } from './board'
import { humanReviewBlocker, MAX_BUILDERS, MERGE_MAX_ATTEMPTS, MERGE_RETRY_SECONDS, NOTIFY_DELAY_SECONDS, PATROL_SECONDS, patrolMessage, updatesMessage } from './team'
import { type BuilderReport, builderPrompt, type QaInput, qaPrompt, type ReviewInput, type ReviewRequest, reviewerPrompt, type TeamApi } from './team-tools'
import { errorMessage } from '~/lib/error-message'
import { cleanMcpServerInput, type JsonObject, type McpCallResult, type McpServerCatalog, McpServers } from './mcp-servers'
import { titleFromPrompt } from './session-title'
import { closePullRequest, type GitHubThread, mergePullRequest, type MergeOutcome, parseRepo, reactToComment } from './github'
import { listRepositories, repoToken } from './github-app'
import { followUpPrompt, type GitHubMention, issuePrompt } from './github-webhook'
import { type WebhookEvent, webhookPrompt } from './generic-webhook'
import { modelOptions } from './models'
import type { PiSession, SessionRole } from './pi-session'

/** A session's task, as the catalog lists it. */
export type CatalogTask = { repo: string; branch: string; pullRequest?: PullRequest }

type SessionMetadata = {
  name?: string
  /** From the first prompt, for sessions nobody named. */
  title?: string
  repo?: string
  branch?: string
  pullRequest?: PullRequest
  /** Absent while idle. */
  status?: Exclude<RunStatus, 'idle'>
  /** The GitHub issue a mention started the session from. */
  thread?: GitHubThread
  role?: TeamRole
  /** The ticket a builder works on. */
  ticket?: string
}

type SessionEntry = RoutedAgentEntry<SessionMetadata>

/** Storage key of the manager's catalog ID. */
const MANAGER_KEY = 'team:manager'

const MAX_NAME_LENGTH = 120

/**
 * The singleton catalog of sessions, on the Agents SDK's `RoutedAgents`.
 *
 * Each catalog entry names one `PiSession` Agent by an opaque physical
 * name that never leaves the registry. The registry forwards
 * `/sessions/{id}/...` requests and WebSocket upgrades to that Agent, which
 * then owns its socket, and deleting an entry condemns the Agent through the
 * SDK's deferred teardown. Each session's state lives in its own Agent.
 *
 * Its Agent state is a revision that every catalog change bumps. The SDK
 * syncs it to every open page, which reloads the list when it moves, so
 * the sidebar follows titles, pull requests and order without polling.
 */
export class PiRegistry extends Agent<Env, PiRegistryState> implements TeamApi {
  override initialState: PiRegistryState = { revision: 0 }

  readonly sessions = new RoutedAgents<PiSession, SessionMetadata>({
    namespace: this.env.PiSession,
    route: PI_SESSIONS_ROUTE,
  })

  readonly mcpServers: McpServers
  readonly board: Board

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.board = new Board(ctx.storage.sql)
    this.lifecycle.use(this.sessions)
    this.mcpServers = new McpServers(this.mcp, ctx.storage.sql)
    // You authorize in this tab, so OAuth comes back to Settings either way.
    this.mcp.configureOAuthCallback({
      customHandler: (result) => new Response(null, {
        status: 302,
        headers: { Location: result.authSuccess ? '/settings' : `/settings?mcp_error=${encodeURIComponent(result.authError)}` },
      }),
    })
  }

  @callable()
  async createSession(input: CreateSessionInput = {}): Promise<SessionSummary> {
    const name = cleanName(input.name)

    return this.#create(name ? { name } : {}, input)
  }

  async #create(metadata: SessionMetadata, input: { prompt?: string; model?: string; thread?: GitHubThread; role?: SessionRole }): Promise<SessionSummary> {
    // Checked here, before there is an entry to undo, so a bad model never reaches a session.
    if (input.model && !this.listModels().some(({ id }) => id === input.model)) throw new Error(`Unknown model: ${input.model}`)
    const entry = await this.sessions.create({ metadata })

    // The session reports activity under its entry ID, which only the
    // registry knows. Without it the entry is unusable, so undo the create.
    try {
      const session = await this.sessions.get(entry.id)

      if (!session) throw new Error(`Session not found: ${entry.id}`)
      await session.joinCatalog(entry.id)

      if (input.thread) await session.setThread(input.thread)

      // Before the prompt, so pi answers it with the role's tools.
      if (input.role) await session.setRole(input.role)

      // Before the prompt, so pi answers it with the model the home page chose.
      if (input.model) await session.setModel(input.model)

      // The home page starts a session with its first prompt; a session
      // that cannot take it is no use to the caller either.
      if (input.prompt?.trim()) {
        // The session titles its entry before `submit` returns. The team's
        // prompts carry repository text, so they get the team's limit.
        await (input.role ? session.submitFromTeam(input.prompt) : session.submit(input.prompt))
      }
    } catch (error) {
      await this.sessions.delete(entry.id)
      throw error
    }

    this.#changed()

    return summary(await this.#require(entry.id))
  }

  @callable()
  async getSession(sessionId: string): Promise<SessionSummary | null> {
    const entry = await this.#find(sessionId)

    return entry ? summary(entry) : null
  }

  @callable()
  async listSessions(): Promise<SessionSummary[]> {
    return (await this.sessions.list()).map(summary)
  }

  @callable()
  async renameSession(sessionId: string, name?: string): Promise<SessionSummary> {
    const entry = await this.#require(sessionId)
    const nextName = cleanName(name)
    const { name: _previous, ...metadata } = entry.metadata ?? {}
    await this.sessions.setMetadata(sessionId, nextName ? { ...metadata, name: nextName } : metadata)
    this.#changed()

    return summary(await this.#require(sessionId))
  }

  /**
   * The GitHub App's repositories, for `@` suggestions. On the registry, so
   * the home page can suggest them before any session exists.
   */
  @callable()
  async listRepositories(): Promise<Repository[]> {
    return listRepositories(this.env)
  }

  /**
   * Called by the webhook endpoint for a trusted mention of the App's bot.
   * Queued, so GitHub gets its answer at once and a failure is retried;
   * keyed by the delivery, so a delivery GitHub repeats while the first
   * still waits replaces it instead of running twice.
   */
  async receiveGitHubMention(mention: GitHubMention, deliveryId: string): Promise<void> {
    await this.queue('handleGitHubMention', mention, { id: `github:${deliveryId}` })
  }

  /**
   * A mention on an issue or pull request a session works on goes to that
   * session; one on an issue without a session starts one. Pull requests Pi
   * did not open are not supported yet. The comment gets 👀 when Pi takes it,
   * and 😕 when it cannot.
   */
  async handleGitHubMention(mention: GitHubMention): Promise<void> {
    const repo = mention.repo.toLowerCase()
    const entries = await this.sessions.list()

    const entry = entries.find(({ metadata }) => metadata?.repo?.toLowerCase() === repo && metadata.pullRequest?.number === mention.number)
      ?? entries.find(({ metadata }) => metadata?.thread?.repo.toLowerCase() === repo && metadata.thread.number === mention.number)

    if (entry) {
      await this.#react(mention, 'eyes')
      const session = await this.sessions.get(entry.id)

      if (session) await session.submit(followUpPrompt(mention))

      return
    }

    if (mention.kind !== 'issue') {
      await this.#react(mention, 'confused')

      return
    }

    await this.#react(mention, 'eyes')
    const thread = { repo: mention.repo, number: mention.number }
    await this.#create({ title: `${mention.repo}#${mention.number}: ${mention.title}`, thread }, { prompt: issuePrompt(mention), thread })
  }

  /**
   * Called by the generic webhook endpoint for an authenticated delivery.
   * Queued like a GitHub mention, and keyed by the body's digest, so a
   * delivery the sender repeats while the first still waits replaces it.
   */
  async receiveWebhook(event: WebhookEvent, deliveryId: string): Promise<void> {
    await this.queue('handleWebhook', event, { id: `webhook:${deliveryId}` })
  }

  /** Each delivery starts its own session. */
  async handleWebhook(event: WebhookEvent): Promise<void> {
    await this.#create({ title: event.title }, { prompt: webhookPrompt(event) })
  }

  /** Reactions only tell you Pi saw the comment; failing one must not stop the work. */
  async #react(mention: GitHubMention, content: 'eyes' | 'confused'): Promise<void> {
    try {
      const repo = parseRepo(mention.repo)
      await reactToComment(await repoToken(this.env, repo), repo, mention.comment, content)
    } catch (error) {
      console.warn('Could not react to the GitHub comment', error)
    }
  }

  /** The models a session can use, the default first, for the home page's picker. Tests override this. */
  @callable()
  listModels(): ModelOption[] {
    return modelOptions(this.env.AI_MODEL)
  }

  /** The MCP servers connected for every session, for Settings. */
  @callable()
  listMcpServers(): McpServerSummary[] {
    return this.mcpServers.list()
  }

  /**
   * Add an MCP server, connect it and discover its tools. A server that
   * wants OAuth answers with the `authUrl` to open; its callback is this
   * Agent's route, which the SDK intercepts. A server that fails to connect
   * is not kept.
   */
  @callable()
  async connectMcpServer(input: ConnectMcpServerInput): Promise<ConnectMcpServerResult> {
    const { name, url, headers } = cleanMcpServerInput(input, this.mcpServers.list())
    const id = crypto.randomUUID().replaceAll('-', '').slice(0, 12)

    try {
      const result = await this.addMcpServer(name, url, {
        id,
        // The callback is `/api/agents/pi-registry/singleton/callback` on the page's host.
        agentsPrefix: PI_AGENT_PREFIX,
        transport: headers ? { headers } : {},
      })

      return { server: this.mcpServers.get(id), ...(result.state === 'authenticating' ? { authUrl: result.authUrl } : {}) }
    } catch (error) {
      await this.removeMcpServer(id).catch(() => {})
      throw error
    }
  }

  /** Connect a server again: after a failure, or to authorize, when it answers with an `authUrl`. */
  @callable()
  async reconnectMcpServer(id: string): Promise<ConnectMcpServerResult> {
    this.mcpServers.get(id)
    const { authUrl } = await this.mcpServers.connect(id)

    return { server: this.mcpServers.get(id), ...(authUrl ? { authUrl } : {}) }
  }

  @callable()
  setMcpServerEnabled(id: string, enabled: boolean): McpServerSummary {
    return this.mcpServers.setEnabled(id, enabled)
  }

  @callable()
  async deleteMcpServer(id: string): Promise<void> {
    this.mcpServers.get(id)
    await this.removeMcpServer(id)
    this.mcpServers.forget(id)
  }

  /** Called by a PiSession for the MCP tools it can offer. */
  async listMcpTools(): Promise<McpServerCatalog[]> {
    return this.mcpServers.tools()
  }

  /** Called by a PiSession to run an MCP tool, so credentials never leave the registry. */
  async callMcpTool(serverId: string, name: string, args: JsonObject): Promise<McpCallResult> {
    return this.mcpServers.call(serverId, name, args)
  }

  @callable()
  async deleteSession(sessionId: string): Promise<void> {
    if (!await this.sessions.delete(sessionId)) throw new Error(`Session not found: ${sessionId}`)

    if (await this.ctx.storage.get<string>(MANAGER_KEY) === sessionId) await this.ctx.storage.delete(MANAGER_KEY)
    const ticket = this.board.byBuilder(sessionId)

    // A ticket whose builder is gone goes back to the board.
    if (ticket && ticket.status !== 'done' && ticket.status !== 'cancelled') {
      this.board.update(ticket.id, { status: 'todo', builder: null, note: 'Its builder session was deleted.' })
    }

    this.#changed()
  }

  /**
   * Start the team's engineering manager, or return the one already
   * running, and its patrol: every `PATROL_SECONDS` the registry, not the
   * model, collects each builder's state and hands it to the manager.
   */
  @callable()
  async startManager(input: { model?: string } = {}): Promise<SessionSummary> {
    const existing = await this.#manager()

    if (existing) return summary(existing)

    const created = await this.#create({ name: 'Engineering manager', role: 'manager' }, {
      ...(input.model ? { model: input.model } : {}),
      role: { role: 'manager' },
    })

    await this.ctx.storage.put(MANAGER_KEY, created.id)
    await this.scheduleEvery(this.patrolSeconds(), 'patrol')

    return created
  }

  @callable()
  async getTeam(): Promise<TeamView> {
    const manager = await this.#manager()

    return {
      ...(manager ? { manager: summary(manager) } : {}),
      tickets: this.board.list(),
      messages: this.board.messages(),
      maxBuilders: MAX_BUILDERS,
      patrolSeconds: this.patrolSeconds(),
    }
  }

  /** A person adds a ticket from the team page; the manager hears of it. */
  @callable()
  async createTicket(input: CreateTicketInput): Promise<Ticket> {
    const ticket = this.board.create(input)
    this.board.log('human', 'board', `Created ${ticket.id}: ${ticket.title}`)
    await this.#notify({ ticket: ticket.id, kind: 'board', body: `The person added this ticket: ${ticket.title} (${ticket.repo}).` })
    this.#changed()

    return ticket
  }

  /** A person moves a ticket from the team page; the manager hears of it. */
  @callable()
  async updateTicket(id: string, input: UpdateTicketInput): Promise<Ticket> {
    const ticket = this.#updateTicket(id, input)
    const change = [input.status ? `status ${input.status}` : '', input.note ? `note: ${input.note}` : ''].filter(Boolean).join(', ')
    this.board.log('human', ticket.id, `Updated: ${change}`)
    await this.#notify({ ticket: ticket.id, kind: 'board', body: `The person updated this ticket: ${change}.` })

    return ticket
  }

  // Team RPC, called by sessions' team tools with their catalog ID.

  async teamBoard(caller: string): Promise<Ticket[]> {
    await this.#requireRole(caller, 'manager')

    return this.board.list()
  }

  async teamCreateTicket(caller: string, input: CreateTicketInput): Promise<Ticket> {
    await this.#requireRole(caller, 'manager')
    const ticket = this.board.create(input)
    this.board.log('manager', 'board', `Created ${ticket.id}: ${ticket.title}`)
    this.#changed()

    return ticket
  }

  async teamUpdateTicket(caller: string, id: string, input: UpdateTicketInput): Promise<Ticket> {
    await this.#requireRole(caller, 'manager')
    const ticket = this.#updateTicket(id, input)
    this.board.log('manager', ticket.id, `Updated: ${[input.status, input.note].filter(Boolean).join(', ')}`)

    return ticket
  }

  /**
   * Start a builder on a ready ticket. The ticket is claimed before the
   * session exists, so two calls racing across the awaits cannot both
   * start one, and released again if the session cannot be created.
   */
  async teamAssign(caller: string, id: string): Promise<Ticket> {
    await this.#requireRole(caller, 'manager')
    const ticket = this.board.require(id)

    if (ticket.status !== 'todo') throw new Error(`${ticket.id} is ${ticket.status}; only a todo ticket can be assigned.`)
    const waiting = this.board.waitingOn(ticket)

    if (waiting.length) throw new Error(`${ticket.id} waits on ${waiting.join(', ')}, which must be done first.`)
    const active = this.board.active().length

    if (active >= MAX_BUILDERS) throw new Error(`${active} builders are already working, the limit. Wait for one to finish.`)
    this.board.update(ticket.id, { status: 'in_progress', builder: null })
    let builder: SessionSummary

    try {
      builder = await this.#create(
        { name: `${ticket.id}: ${ticket.title}`, role: 'builder', ticket: ticket.id },
        { prompt: builderPrompt(ticket), role: { role: 'builder', ticket: ticket.id } },
      )
    } catch (error) {
      this.board.update(ticket.id, { status: 'todo' })
      throw error
    }

    const assigned = this.board.update(ticket.id, { builder: builder.id })
    this.board.log('manager', ticket.id, 'Assigned a builder.')
    this.#changed()

    return assigned
  }

  async teamMessageBuilder(caller: string, id: string, message: string): Promise<void> {
    await this.#requireRole(caller, 'manager')
    const builder = await this.#builder(this.board.require(id))

    if (!builder) throw new Error(`${id} has no builder. Assign it first.`)
    await builder.submitFromTeam(`[Manager] ${message}`)
    this.board.log('manager', id, message)
  }

  async teamReadBuilder(caller: string, id: string): Promise<BuilderReport> {
    await this.#requireRole(caller, 'manager')
    const ticket = this.board.require(id)

    return { ticket, ...await this.#builderState(ticket) }
  }

  async teamAskManager(caller: string, message: string): Promise<void> {
    const entry = await this.#requireRole(caller, 'builder')
    const ticket = entry.metadata?.ticket ?? 'unknown ticket'
    this.board.log(ticket, 'manager', message)
    await this.#notify({ ticket, kind: 'question', body: `The builder asks:\n${message}` })
  }

  /**
   * Deliver the queued updates to the manager in one message. Scheduled by
   * `#notify`; updates stay queued until a manager takes them, and a failed
   * delivery leaves them for the next.
   */
  async flushUpdates(): Promise<void> {
    const manager = await this.#manager()

    if (!manager) return
    const { updates, last } = this.board.pendingUpdates()

    if (!updates.length) return

    // A finished run is reported with what the builder said.
    const withReports = await Promise.all(updates.map(async (update) => {
      if (update.kind !== 'finished') return update
      const ticket = this.board.get(update.ticket)
      const report = ticket && (await this.#builderState(ticket)).report

      return report ? { ...update, report } : update
    }))

    const message = updatesMessage(withReports)
    const session = await this.sessions.get(manager.id)

    if (!session) return
    await session.submitFromTeam(message)
    this.board.clearUpdates(last)
    this.board.log('team', 'manager', message)

    // Updates queued while this ran may have been folded into this run's own schedule row.
    if (this.board.pendingUpdates().updates.length) await this.schedule(this.notifyDelaySeconds(), 'flushUpdates', 'manager', { idempotent: false })
  }

  /**
   * The patrol: every active builder's state, and what is ready, handed to
   * the manager. Skipped while the manager is running, so patrols never
   * pile up behind a long turn, and when there is nothing to look at.
   */
  async patrol(): Promise<void> {
    const manager = await this.#manager()

    if (!manager || manager.metadata?.status === 'running') return
    const active = this.board.active()
    const ready = this.board.ready()

    if (!active.length && !ready.length) return
    const entries = await Promise.all(active.map(async (ticket) => ({ ticket, ...await this.#builderState(ticket) })))
    const message = patrolMessage(entries, ready, MAX_BUILDERS)
    const session = await this.sessions.get(manager.id)

    if (!session) return
    await session.submitFromTeam(message)
    this.board.log('patrol', 'manager', message)
  }

  async teamRequestReview(caller: string, request: ReviewRequest): Promise<{ round: number }> {
    const { ticket } = await this.#callerTicket(caller, 'builder')

    if (ticket.reviewRounds >= MAX_REVIEW_ROUNDS) {
      await this.#notify({
        ticket: ticket.id,
        kind: 'review',
        body: `The builder used all ${MAX_REVIEW_ROUNDS} review rounds; the last verdict was ${ticket.review?.verdict ?? 'not in yet'}. Decide whether it is ready for the person, or give it direction.`,
      })
      throw new Error(`All ${MAX_REVIEW_ROUNDS} review rounds are used. List what is left in your report; your manager has been told.`)
    }

    const round = ticket.reviewRounds + 1
    const counted = this.board.update(ticket.id, { process: (process) => ({ ...process, reviewRounds: round, review: undefined }) })

    try {
      const reviewer = await this.#child(counted, 'reviewer', reviewerPrompt(counted, request, round))
      this.board.update(ticket.id, { process: (process) => ({ ...process, reviewer }) })
    } catch (error) {
      // The round never started: give it back, with the verdict it replaced.
      this.board.update(ticket.id, { process: (process) => ({ ...process, reviewRounds: round - 1, review: ticket.review }) })
      throw error
    }

    this.board.log(ticket.id, 'reviewer', `Requested review round ${round} of ${MAX_REVIEW_ROUNDS}.`)
    this.#changed()

    return { round }
  }

  async teamSubmitReview(caller: string, input: ReviewInput): Promise<void> {
    const { ticket } = await this.#callerTicket(caller, 'reviewer')
    const round = Math.max(1, ticket.reviewRounds)
    const comments = input.comments.trim()
    this.board.update(ticket.id, { process: (process) => ({ ...process, review: { verdict: input.verdict, round, comments, at: new Date().toISOString() } }) })
    const last = round >= MAX_REVIEW_ROUNDS && input.verdict === 'changes_requested'
    const heading = `[Reviewer, round ${round} of ${MAX_REVIEW_ROUNDS}] ${input.verdict === 'approved' ? 'Approved.' : 'Changes requested:'}`
    const tail = last ? '\n\nThat was the last review round: fix what you can, push, and list what is left in your report.' : ''
    await this.#tellBuilder(ticket, `${heading}\n${comments}${tail}`)
    this.board.log('reviewer', ticket.id, `${input.verdict === 'approved' ? 'Approved' : 'Changes requested'} (round ${round}): ${comments}`)
    await this.#notify({ ticket: ticket.id, kind: 'review', body: `Review round ${round} of ${MAX_REVIEW_ROUNDS}: ${input.verdict === 'approved' ? 'approved' : 'changes requested'}.${last ? ' That was the last round.' : ''}` })
    this.#changed()
  }

  async teamRequestQa(caller: string, instructions: string): Promise<void> {
    const { entry, ticket } = await this.#callerTicket(caller, 'builder')
    const branch = entry.metadata?.branch

    if (!ticket.pullRequest || !branch) throw new Error('Push your branch with create_pull_request first: QA checks out the pushed branch.')
    const qaSession = await this.#child(ticket, 'qa', qaPrompt(ticket, branch, instructions))
    this.board.update(ticket.id, { process: (process) => ({ ...process, qaSession, qa: undefined }) })
    this.board.log(ticket.id, 'qa', 'Requested QA.')
    this.#changed()
  }

  async teamSubmitQa(caller: string, input: QaInput): Promise<void> {
    const { ticket } = await this.#callerTicket(caller, 'qa')
    const summary = input.summary.trim()
    const qa = { result: input.result, summary, ...(input.recording ? { recording: input.recording } : {}), at: new Date().toISOString() }
    this.board.update(ticket.id, { process: (process) => ({ ...process, qa }) })
    await this.#tellBuilder(ticket, `[QA] ${input.result === 'pass' ? 'Passed' : 'Failed'}:\n${summary}`)
    this.board.log('qa', ticket.id, `${input.result === 'pass' ? 'Passed' : 'Failed'}: ${summary}`)
    await this.#notify({ ticket: ticket.id, kind: 'qa', body: `QA ${input.result === 'pass' ? 'passed' : 'failed'}${input.recording ? ', with a recording for the person' : ''}:\n${summary}` })
    this.#changed()
  }

  async teamRequestHumanReview(caller: string, id: string, summary: string): Promise<Ticket> {
    await this.#requireRole(caller, 'manager')
    const ticket = this.board.require(id)
    const text = summary.trim()

    if (!ticket.pullRequest) throw new Error(`${ticket.id} has no pull request to review yet.`)

    if (!text) throw new Error('Write a summary the person can check in a minute.')
    const notReady = humanReviewBlocker(ticket)

    if (notReady) throw new Error(`${ticket.id} is not ready for the person: ${notReady}`)
    const updated = this.board.update(ticket.id, { process: (process) => ({ ...process, humanReview: { summary: text, requestedAt: new Date().toISOString() } }) })
    this.board.log('manager', 'human', `${ticket.id} is ready for your review: ${text}`)
    this.#changed()

    return updated
  }

  async teamReserveNumber(caller: string, key: string, atLeast: number): Promise<number> {
    const { ticket } = await this.#callerTicket(caller, 'builder')
    const number = this.board.reserveNumber(ticket.repo, key, atLeast, ticket.id)
    this.board.log(ticket.id, 'board', `Reserved ${key} number ${number} in ${ticket.repo}.`)

    return number
  }

  /** The Browser Run session of a ticket's last QA run, for its recording. */
  async qaRecording(id: string): Promise<string | undefined> {
    return this.board.get(id)?.qa?.recording
  }

  /** The person ships a ticket: it leaves their inbox and joins the merge queue. */
  @callable()
  async shipTicket(id: string): Promise<Ticket> {
    const ticket = this.board.require(id)

    if (!ticket.pullRequest) throw new Error(`${ticket.id} has no pull request to ship.`)

    if (ticket.merge && ticket.merge.state !== 'conflict' && ticket.merge.state !== 'failed') return ticket

    const shipped = this.board.update(ticket.id, {
      process: (process) => ({ ...process, humanReview: undefined, merge: { state: 'queued', queuedAt: new Date().toISOString(), attempts: 0 } }),
    })

    this.board.log('human', ticket.id, `Shipped. Pull request #${ticket.pullRequest.number} is in the merge queue.`)
    await this.#notify({ ticket: ticket.id, kind: 'merge', body: 'The person shipped it; it is in the merge queue.' })
    await this.schedule(0, 'processMergeQueue', 'merge', { idempotent: true })
    this.#changed()

    return shipped
  }

  /** The person sends a ticket back to its builder from their inbox, saying why. */
  @callable()
  async sendBackTicket(id: string, note: string): Promise<Ticket> {
    const ticket = this.board.require(id)
    const reason = note.trim()

    if (!reason) throw new Error('Say what needs to change.')

    const sent = this.board.update(ticket.id, {
      ...(ticket.builder ? { status: 'in_progress' } : {}),
      note: `Sent back: ${reason}`,
      process: (process) => ({ ...process, humanReview: undefined }),
    })

    await this.#tellBuilder(ticket, `[Person] Sent back from review:\n${reason}`)
    this.board.log('human', ticket.id, `Sent back: ${reason}`)
    await this.#notify({ ticket: ticket.id, kind: 'board', body: `The person sent it back from review: ${reason}` })
    this.#changed()

    return sent
  }

  /**
   * The merge queue: deterministic code, not a model. Each repository's
   * shipped tickets merge one at a time, in the order they were shipped;
   * the head of a repository's queue holds the rest back while it waits on
   * GitHub. Runs whenever a ticket ships and while any wait.
   */
  async processMergeQueue(): Promise<void> {
    const queued = () => this.board.list()
      .filter((ticket) => ticket.merge?.state === 'queued' || ticket.merge?.state === 'waiting')
      .sort((a, b) => (a.merge?.queuedAt ?? '').localeCompare(b.merge?.queuedAt ?? ''))

    const heads = new Map<string, Ticket>()

    for (const ticket of queued()) if (!heads.has(ticket.repo)) heads.set(ticket.repo, ticket)

    for (const ticket of heads.values()) {
      if ((ticket.merge?.retryAt ?? 0) <= Date.now()) await this.#attemptMerge(ticket)
    }

    // Whatever still waits, including tickets shipped while this ran.
    const due = queued().map((ticket) => ticket.merge?.retryAt ?? 0)

    if (due.length) {
      const seconds = Math.max(0, Math.ceil((Math.min(...due) - Date.now()) / 1000))
      // Not idempotent: this run's own schedule row may not be gone yet.
      await this.schedule(seconds, 'processMergeQueue', 'merge', { idempotent: false })
    }
  }

  async #attemptMerge(ticket: Ticket): Promise<void> {
    const { pullRequest, merge } = ticket

    if (!pullRequest || !merge) return
    let outcome: MergeOutcome

    try {
      outcome = await this.mergeOnGitHub(ticket.repo, pullRequest.number)
    } catch (error) {
      outcome = { kind: 'failed', detail: errorMessage(error) }
    }

    const attempts = merge.attempts + 1

    const setMerge = (next: Partial<TicketMerge>) => (process: TicketProcess): TicketProcess => ({
      ...process,
      merge: { state: merge.state, queuedAt: merge.queuedAt, attempts, ...next },
    })

    if (outcome.kind === 'merged') {
      this.board.update(ticket.id, { status: 'done', process: setMerge({ state: 'merged', ...(outcome.sha ? { sha: outcome.sha } : {}) }) })
      const ready = this.board.ready().filter((entry) => entry.dependsOn.includes(ticket.id))
      this.board.log('merge-queue', ticket.id, `Merged pull request #${pullRequest.number}.`)
      await this.#tellBuilder(ticket, `[Merge queue] Pull request #${pullRequest.number} is merged. Your work on ${ticket.id} is done.`)
      await this.#notify({
        ticket: ticket.id,
        kind: 'merge',
        body: `Merged pull request #${pullRequest.number}; the ticket is done.${ready.length ? ` Now ready: ${ready.map((entry) => `${entry.id} ${entry.title}`).join('; ')}.` : ''}`,
      })
    } else if (outcome.kind === 'updated' || (outcome.kind === 'waiting' && attempts < this.mergeMaxAttempts())) {
      const detail = outcome.kind === 'updated' ? 'Brought the branch up to date with its base; waiting for its checks.' : outcome.detail
      this.board.update(ticket.id, { process: setMerge({ state: 'waiting', detail, retryAt: Date.now() + this.mergeRetrySeconds() * 1000 }) })
    } else if (outcome.kind === 'conflict') {
      this.board.update(ticket.id, { status: 'blocked', note: `Pull request #${pullRequest.number} conflicts with its base.`, process: setMerge({ state: 'conflict', detail: 'Conflicts with its base.' }) })
      this.board.log('merge-queue', ticket.id, `Pull request #${pullRequest.number} conflicts with its base.`)
      await this.#notify({
        ticket: ticket.id,
        kind: 'merge',
        body: `Pull request #${pullRequest.number} conflicts with its base, so the merge queue skipped it. Builders cannot resolve conflicts in their workspace: set the ticket back to todo so a fresh builder redoes it on the latest base, or ask the person to resolve it and ship it again.`,
      })
    } else {
      const detail = outcome.kind === 'waiting' ? `Gave up after ${attempts} attempts: ${outcome.detail}` : outcome.detail
      this.board.update(ticket.id, { status: 'blocked', note: `Could not merge: ${detail}`, process: setMerge({ state: 'failed', detail }) })
      this.board.log('merge-queue', ticket.id, `Could not merge: ${detail}`)
      await this.#notify({ ticket: ticket.id, kind: 'merge', body: `The merge queue could not merge pull request #${pullRequest.number}: ${detail} Tell the person.` })
    }

    this.#changed()
  }

  /** One merge-queue step on GitHub, as the App. Tests override this. */
  protected async mergeOnGitHub(repo: string, number: number): Promise<MergeOutcome> {
    const ref = parseRepo(repo)

    return mergePullRequest(await repoToken(this.env, ref), ref, number)
  }

  /** Close an earlier builder's pull request; says what happened, for the manager's update. */
  async #closeSuperseded(ticket: Ticket, number: number, by: number): Promise<string> {
    try {
      await this.closeOnGitHub(ticket.repo, number, `Superseded by #${by}, which a new builder opened for ${ticket.id}.`)
      this.board.log('team', ticket.id, `Closed pull request #${number}, superseded by #${by}.`)

      return ` It replaces #${number}, which is now closed.`
    } catch (error) {
      return ` It replaces #${number}, which could not be closed (${errorMessage(error)}): ask the person to close it.`
    }
  }

  protected async closeOnGitHub(repo: string, number: number, comment: string): Promise<void> {
    const ref = parseRepo(repo)
    await closePullRequest(await repoToken(this.env, ref), ref, number, comment)
  }

  protected mergeRetrySeconds(): number {
    return MERGE_RETRY_SECONDS
  }

  protected mergeMaxAttempts(): number {
    return MERGE_MAX_ATTEMPTS
  }

  /** Seconds between patrols. Tests override this. */
  protected patrolSeconds(): number {
    return PATROL_SECONDS
  }

  /** Seconds updates gather before they reach the manager. Tests override this. */
  protected notifyDelaySeconds(): number {
    return NOTIFY_DELAY_SECONDS
  }

  /** Queue an update for the manager, and schedule its delivery once. */
  async #notify(update: Parameters<Board['queueUpdate']>[0]): Promise<void> {
    this.board.queueUpdate(update)
    await this.schedule(this.notifyDelaySeconds(), 'flushUpdates', 'manager', { idempotent: true })
  }

  /** Setting a ticket back to todo releases its builder, so the next assignment starts a fresh one. */
  #updateTicket(id: string, input: UpdateTicketInput): Ticket {
    const leaving = input.status !== undefined && input.status !== 'in_review'

    const ticket = this.board.update(id, {
      ...input,
      ...(input.status === 'todo' ? { builder: null } : {}),
      // A ticket taken out of review leaves the person's inbox.
      ...(leaving ? { process: (process: TicketProcess) => ({ ...process, humanReview: undefined }) } : {}),
    })

    this.#changed()

    return ticket
  }

  /** The caller's catalog entry, checked for `role`, and the ticket it works on. */
  async #callerTicket(caller: string, role: TeamRole): Promise<{ entry: SessionEntry; ticket: Ticket }> {
    const entry = await this.#requireRole(caller, role)
    const id = entry.metadata?.ticket

    if (!id) throw new Error('This session works on no ticket.')
    const ticket = this.board.require(id)

    // A builder taken off its ticket stops: only the ticket's current builder works on it.
    if (role === 'builder' && ticket.builder !== caller) throw new Error(`You are no longer ${ticket.id}'s builder. Stop and report what you have.`)

    return { entry, ticket }
  }

  /** A ticket's reviewer or QA session, given its next prompt: the one it already has, or a new one. */
  async #child(ticket: Ticket, role: 'reviewer' | 'qa', prompt: string): Promise<string> {
    const existing = role === 'reviewer' ? ticket.reviewer : ticket.qaSession
    const session = existing ? await this.sessions.get(existing) : null

    if (existing && session) {
      await session.submitFromTeam(prompt)

      return existing
    }

    const created = await this.#create(
      { name: `${ticket.id} ${role === 'reviewer' ? 'review' : 'QA'}: ${ticket.title}`, role, ticket: ticket.id },
      { prompt, role: { role, ticket: ticket.id } },
    )

    return created.id
  }

  /** A message in the ticket's builder session, when it still has one. */
  async #tellBuilder(ticket: Ticket, message: string): Promise<void> {
    const builder = await this.#builder(ticket)

    if (builder) await builder.submitFromTeam(message)
  }

  async #manager(): Promise<SessionEntry | undefined> {
    const id = await this.ctx.storage.get<string>(MANAGER_KEY)

    return id ? this.#find(id) : undefined
  }

  async #requireRole(caller: string, role: TeamRole): Promise<SessionEntry> {
    const entry = await this.#find(caller)

    if (entry?.metadata?.role !== role) throw new Error(`Only the team's ${role} can do this.`)

    return entry
  }

  async #builder(ticket: Ticket): Promise<DurableObjectStub<PiSession> | null> {
    return ticket.builder ? this.sessions.get(ticket.builder) : null
  }

  /** A ticket's builder: its run status as the catalog lists it, and its last report. */
  async #builderState(ticket: Ticket): Promise<{ status: BuilderReport['status']; report?: string }> {
    const entry = ticket.builder ? await this.#find(ticket.builder) : undefined
    const session = entry && await this.sessions.get(entry.id)

    if (!entry || !session) return { status: 'none' }

    const report = await session.latestReport().catch((cause: unknown) => {
      console.warn('Could not read the builder\'s report', cause)

      return undefined
    })

    return { status: entry.metadata?.status ?? 'idle', ...(report ? { report } : {}) }
  }

  /** Called by a PiSession when it clones its repository and when it opens a pull request. */
  async setTask(sessionId: string, task: CatalogTask): Promise<void> {
    const entry = await this.#find(sessionId)

    if (!entry) return
    await this.sessions.setMetadata(sessionId, { ...entry.metadata, ...task })
    this.#changed()
    const ticketId = entry.metadata?.role === 'builder' ? entry.metadata.ticket : undefined
    const ticket = ticketId ? this.board.get(ticketId) : undefined
    const { pullRequest } = task

    // A builder's first pull request puts its ticket in review.
    if (ticket && pullRequest && ticket.pullRequest?.number !== pullRequest.number) {
      const superseded = ticket.pullRequest
      this.board.update(ticket.id, { pullRequest, ...(ticket.status === 'in_progress' ? { status: 'in_review' } : {}) })
      this.board.log(ticket.id, 'manager', `Opened pull request #${pullRequest.number}.`)
      // One ticket, one pull request: an earlier builder's is closed, so it cannot be shipped by mistake.
      const closed = superseded ? await this.#closeSuperseded(ticket, superseded.number, pullRequest.number) : ''
      await this.#notify({ ticket: ticket.id, kind: 'pull_request', body: `The builder opened pull request #${pullRequest.number}: ${pullRequest.url}. The ticket is in review.${closed}` })
    }
  }

  /**
   * Called by a PiSession when it accepts a prompt: moves the entry to the
   * top, and titles it from its first prompt.
   */
  async touchSession(sessionId: string, prompt?: string): Promise<void> {
    const entry = await this.#find(sessionId)

    if (!entry) return
    const metadata = entry.metadata ?? {}
    // Rewriting the same metadata bumps the entry's `updatedAt`.
    await this.sessions.setMetadata(sessionId, !metadata.title && prompt ? { ...metadata, title: titleFromPrompt(prompt) } : metadata)
    this.#changed()
  }

  /**
   * Called by a PiSession when its run status changes, and once each time
   * it starts, to correct a status an eviction left behind. A change moves
   * the entry to the top, like a prompt; a report of the status the entry
   * already has changes nothing. Keeps the rest of the metadata.
   */
  async setStatus(sessionId: string, status: RunStatus): Promise<void> {
    const entry = await this.#find(sessionId)

    if (!entry) return
    const { status: previous, ...metadata } = entry.metadata ?? {}

    if ((previous ?? 'idle') === status) return
    await this.sessions.setMetadata(sessionId, status === 'idle' ? metadata : { ...metadata, status })
    this.#changed()

    // The manager hears when one of its builders stops, as it happens, not only at the next patrol.
    if (metadata.role !== 'builder' || !metadata.ticket || previous !== 'running') return

    if (status === 'idle') await this.#notify({ ticket: metadata.ticket, kind: 'finished', body: 'The builder finished a run.' })
    else if (status === 'failed') await this.#notify({ ticket: metadata.ticket, kind: 'failed', body: 'The builder\'s last run failed.' })
  }

  /** The revision is the registry's to move. */
  override validateStateChange(_next: PiRegistryState, source: Connection | 'server'): void {
    if (source !== 'server') throw new Error('Registry state is read-only.')
  }

  #changed(): void {
    this.setState({ revision: this.state.revision + 1 })
  }

  async #find(sessionId: string): Promise<RoutedAgentEntry<SessionMetadata> | undefined> {
    return (await this.sessions.list()).find((entry) => entry.id === sessionId)
  }

  async #require(sessionId: string): Promise<RoutedAgentEntry<SessionMetadata>> {
    const entry = await this.#find(sessionId)

    if (!entry) throw new Error(`Session not found: ${sessionId}`)

    return entry
  }
}

function summary(entry: RoutedAgentEntry<SessionMetadata>): SessionSummary {
  return {
    id: entry.id,
    ...(entry.metadata?.name ? { name: entry.metadata.name } : {}),
    ...(entry.metadata?.title ? { title: entry.metadata.title } : {}),
    ...(entry.metadata?.role ? { role: entry.metadata.role } : {}),
    ...(entry.metadata?.ticket ? { ticket: entry.metadata.ticket } : {}),
    ...(entry.metadata?.repo ? { repo: entry.metadata.repo, branch: entry.metadata.branch } : {}),
    ...(entry.metadata?.pullRequest ? { pullRequest: entry.metadata.pullRequest } : {}),
    status: entry.metadata?.status ?? 'idle',
    createdAt: new Date(entry.createdAt).toISOString(),
    updatedAt: new Date(entry.updatedAt).toISOString(),
  }
}

function cleanName(name: string | undefined): string | undefined {
  const value = name?.trim()

  if (!value) return undefined

  if (value.length > MAX_NAME_LENGTH) throw new Error(`Session names are limited to ${MAX_NAME_LENGTH} characters.`)

  return value
}

