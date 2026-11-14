import type { TranscriptView } from '@earendil-works/pi-durable'
import type { RunStatus } from '~/lib/run-status'

export type { RunStatus }

export const PI_AGENT_NAME = 'PiSession'

export const PI_REGISTRY_NAME = 'PiRegistry'

export const PI_AGENT_PREFIX = 'api/agents'

export const PI_REGISTRY_INSTANCE = 'singleton'

/** The registry's route segment for sessions; see `sessionBasePath`. */
export const PI_SESSIONS_ROUTE = 'sessions'

/**
 * A session's path, through the registry: the registry owns the catalog and
 * forwards the session's requests and WebSocket to its Agent, whose own name
 * never leaves the registry. `pi-registry` is the kebab-case of the
 * `PiRegistry` binding, as `routeAgentRequest` matches it.
 */
export function sessionBasePath(sessionId: string): string {
  return `${PI_AGENT_PREFIX}/pi-registry/${PI_REGISTRY_INSTANCE}/${PI_SESSIONS_ROUTE}/${encodeURIComponent(sessionId)}`
}

/**
 * Server → browser frame on a PiSession connection. Every frame carries a
 * complete renderer view, so a reconnect replaces stale state atomically.
 */
export type PiViewMessage = {
  type: 'pi:view'
  view: TranscriptView
}

export type WorkspaceFile = {
  path: string
  size: number
  mtime: string
}

export type WorkspaceFileContent = WorkspaceFile & {
  content: string
}

export type PullRequest = {
  number: number
  url: string
}

/** A repository the session can work on, for `@` suggestions. */
export type Repository = {
  /** `owner/name` */
  repo: string
  private: boolean
  description?: string
}

/** The GitHub repository a session cloned, when the model called `clone_repository`. */
export type SessionTask = {
  /** `owner/name` */
  repo: string
  /** The branch the task starts from and its pull request targets. */
  baseBranch: string
  /** The commit the task started from; changes are measured against it. */
  baseCommit: string
  /** The branch the agent's work is pushed to. */
  branch: string
  /** Where the clone lives in the workspace. */
  dir: string
  pullRequest?: PullRequest
}

/** A PiSession's Agent state, synced to its clients by the Agents SDK. Only the server writes it. */
export type PiSessionState = {
  task: SessionTask | null
  /** The ID of the model pi answers with, one of `listModels()`. */
  model: string
}

/** A model the session can switch to. */
export type ModelOption = {
  id: string
  label: string
}

/** One file the task changed since its base commit, uncommitted work included. */
export type TaskChange = {
  path: string
  status: 'A' | 'M' | 'D'
  insertions: number
  deletions: number
}

/**
 * A session's part in the team: the engineering manager, which never writes
 * code and runs the board, or a builder working one ticket. Solo sessions
 * have no role.
 */
export type TeamRole = 'manager' | 'builder' | 'reviewer' | 'qa'

export type SessionSummary = {
  id: string
  name?: string
  role?: TeamRole
  /** The ticket a builder works on. */
  ticket?: string
  /** From the session's first prompt. */
  title?: string
  repo?: string
  branch?: string
  pullRequest?: PullRequest
  /** What pi is doing, as the session last reported it. A change moves the session to the top. */
  status: RunStatus
  createdAt: string
  updatedAt: string
}

/** One of the tabs in the session's browser, as Live View offers it. */
export type BrowserTabView = {
  /** The tab's CDP target ID, stable while it stays open. */
  targetId: string
  /** The embeddable Live View URL for the tab, a bearer credential that connects for about five minutes. */
  url: string
  /** What the tab is showing now. */
  pageUrl?: string
  title?: string
}

export interface PiSessionContract {
  readonly state: PiSessionState
  submit(prompt: string): Promise<{ operationId: string; accepted: boolean }>
  steer(prompt: string): Promise<{ operationId: string; accepted: boolean }>
  abort(): void
  listFiles(): Promise<WorkspaceFile[]>
  readWorkspaceFile(path: string): Promise<WorkspaceFileContent>
  listChanges(): Promise<TaskChange[]>
  readChange(path: string): Promise<string>
  listModels(): Promise<ModelOption[]>
  setModel(id: string): Promise<void>
  /** The session's browser tabs to watch live, or null when this deployment has no browser. */
  browserLiveView(): Promise<BrowserTabView[] | null>
}

/**
 * Where an MCP server's connection stands, as the Agents SDK reports it.
 * `not-connected` is a saved server with no connection yet, such as right
 * after the registry wakes.
 */
export type McpServerState = 'ready' | 'authenticating' | 'connecting' | 'connected' | 'discovering' | 'failed' | 'not-connected'

/** One MCP server connected on the registry, for the Settings page. Never carries credentials. */
export type McpServerSummary = {
  id: string
  name: string
  url: string
  state: McpServerState
  error?: string
  /** Where to authorize, while `state` is `authenticating`. */
  authUrl?: string
  /** Tools the connected server offers. */
  toolCount: number
  /** Whether sessions can use the server. */
  enabled: boolean
}

export type ConnectMcpServerInput = {
  name: string
  url: string
  /** Sent with every request, e.g. `Authorization: Bearer <token>`. Without them the server may ask for OAuth. */
  headers?: Record<string, string>
}

/** A server just added or reconnected; `authUrl` when it waits for OAuth in the browser. */
export type ConnectMcpServerResult = {
  server: McpServerSummary
  authUrl?: string
}

/** The registry's Agent state: a revision every catalog change bumps, so pages know to reload the list. */
export type PiRegistryState = {
  revision: number
}

/** A new session: its name, the first prompt, and the model pi answers with. Each is optional. */
export type CreateSessionInput = { name?: string; prompt?: string; model?: string }

/**
 * Where a ticket stands. `todo` until the manager assigns it, `in_progress`
 * while its builder works, `in_review` once the builder opened a pull
 * request, `blocked` when it needs a decision, and `done` or `cancelled`.
 */
export type TicketStatus = 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled'

export const TICKET_STATUSES: readonly TicketStatus[] = ['todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']

/** Statuses that hold one of the `MAX_BUILDERS` builder slots. */
export const ACTIVE_STATUSES: readonly TicketStatus[] = ['in_progress', 'in_review', 'blocked']

/** One unit of work on the board: one ticket, one builder, one pull request. */
export type Ticket = {
  /** `T-<n>`, in creation order. */
  id: string
  title: string
  /** What to build and how to know it is done, in Markdown. */
  spec: string
  /** `owner/name` */
  repo: string
  baseBranch?: string
  /** Tickets that must be `done` before this one can be assigned. */
  dependsOn: string[]
  status: TicketStatus
  /** The builder session's catalog ID, once assigned. */
  builder?: string
  pullRequest?: PullRequest
  /** The last word on the ticket's state, from the manager or a person. */
  note?: string
  createdAt: string
  updatedAt: string
} & TicketProcess

/** A reviewer's verdict on one round of a builder's changes. */
export type TicketReview = {
  verdict: 'approved' | 'changes_requested'
  /** Which round, from 1 to `MAX_REVIEW_ROUNDS`. */
  round: number
  comments: string
  at: string
}

/** A QA agent's result for the ticket's pull request. */
export type TicketQa = {
  result: 'pass' | 'fail'
  summary: string
  /** The Browser Run session whose recording shows the QA run, when it used the browser. */
  recording?: string
  at: string
}

/** The manager's request that a person review and ship the ticket. */
export type HumanReviewRequest = { summary: string; requestedAt: string }

/**
 * Where a shipped ticket stands in the merge queue. `queued` waits its
 * turn, `waiting` waits on GitHub (checks, mergeability, or a branch update),
 * then `merged`, or `conflict` or `failed`, which need the team.
 */
export type MergeState = 'queued' | 'waiting' | 'merged' | 'conflict' | 'failed'

export type TicketMerge = {
  state: MergeState
  queuedAt: string
  /** Attempts made while waiting on GitHub. */
  attempts: number
  detail?: string
  /** When a waiting ticket is tried again, in milliseconds since the epoch. */
  retryAt?: number
  sha?: string
}

/** How far a ticket has come through review, QA, the person and the merge queue. */
export type TicketProcess = {
  /** Review rounds used, at most `MAX_REVIEW_ROUNDS`. */
  reviewRounds: number
  /** The reviewer session's catalog ID. */
  reviewer?: string
  review?: TicketReview
  /** The QA session's catalog ID. */
  qaSession?: string
  qa?: TicketQa
  humanReview?: HumanReviewRequest
  merge?: TicketMerge
}

/** Review rounds a builder may ask for before the ticket goes to its manager. */
export const MAX_REVIEW_ROUNDS = 3

export type CreateTicketInput = { title: string; spec: string; repo: string; baseBranch?: string; dependsOn?: string[] }

export type UpdateTicketInput = { status?: TicketStatus; note?: string }

/** One message between team members, as the team page shows it. */
export type TeamMessage = {
  id: number
  /** `human`, `manager`, `patrol`, or a builder's ticket ID. */
  from: string
  to: string
  body: string
  at: string
}

/** The team at a glance: its manager, board and recent messages. */
export type TeamView = {
  manager?: SessionSummary
  tickets: Ticket[]
  messages: TeamMessage[]
  /** How many builders may work at once. */
  maxBuilders: number
  /** Seconds between the manager's patrols of its builders. */
  patrolSeconds: number
}

export interface PiRegistryContract {
  readonly state: PiRegistryState
  createSession(input?: CreateSessionInput): Promise<SessionSummary>
  getSession(sessionId: string): Promise<SessionSummary | null>
  listSessions(): Promise<SessionSummary[]>
  renameSession(sessionId: string, name?: string): Promise<SessionSummary>
  deleteSession(sessionId: string): Promise<void>
  listRepositories(): Promise<Repository[]>
  listModels(): Promise<ModelOption[]>
  listMcpServers(): Promise<McpServerSummary[]>
  connectMcpServer(input: ConnectMcpServerInput): Promise<ConnectMcpServerResult>
  reconnectMcpServer(id: string): Promise<ConnectMcpServerResult>
  setMcpServerEnabled(id: string, enabled: boolean): Promise<McpServerSummary>
  deleteMcpServer(id: string): Promise<void>
  /** Start the team's engineering manager, or return the one already running. */
  startManager(input?: { model?: string }): Promise<SessionSummary>
  getTeam(): Promise<TeamView>
  createTicket(input: CreateTicketInput): Promise<Ticket>
  updateTicket(id: string, input: UpdateTicketInput): Promise<Ticket>
  /** A person approves a ticket in review; it joins the merge queue. */
  shipTicket(id: string): Promise<Ticket>
  /** A person sends a ticket in review back to its builder, saying why. */
  sendBackTicket(id: string, note: string): Promise<Ticket>
}

/** Where the team page loads a QA recording from: rrweb events, by tab. */
export function recordingPath(ticketId: string): string {
  return `/team/recordings/${encodeURIComponent(ticketId)}`
}
