import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '~/lib/json'
import { mergePullRequest } from '~/server/github'

const repo = { owner: 'octo', name: 'demo' }

/** A pull request as GitHub's REST API describes it, with the fields the merge queue reads. */
type PullRequestFields = { merged?: boolean; merge_commit_sha?: string; state?: string; draft?: boolean; mergeable?: boolean | null; mergeable_state?: string }

const pr = (fields: PullRequestFields) => ({ number: 7, node_id: 'PR_7', merged: false, state: 'open', draft: false, mergeable: true, mergeable_state: 'clean', head: { sha: 'head1' }, ...fields })

/** Answer each request by its method and path; record them in order. */
function serve(routes: Record<string, () => Response>) {
  const calls: string[] = []

  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const key = `${init?.method ?? 'GET'} ${url.pathname}`
    calls.push(key)
    const route = routes[key]

    if (!route) throw new Error(`Unexpected ${key}`)

    return route()
  })

  return { calls, fetch }
}

const json = (body: JsonObject, status = 200) => Response.json(body, { status })

describe('mergePullRequest', () => {
  afterEach(() => vi.restoreAllMocks())

  it('marks a draft ready, then squash-merges at the head it read', async () => {
    const { calls, fetch } = serve({
      'GET /repos/octo/demo/pulls/7': () => json(pr({ draft: true })),
      'POST /graphql': () => json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }),
      'PUT /repos/octo/demo/pulls/7/merge': () => json({ sha: 'merged1', merged: true, message: 'ok' }),
    })

    expect(await mergePullRequest('t', repo, 7)).toEqual({ kind: 'merged', sha: 'merged1' })
    expect(calls).toEqual(['GET /repos/octo/demo/pulls/7', 'POST /graphql', 'PUT /repos/octo/demo/pulls/7/merge'])
    expect(JSON.parse(fetch.mock.calls[2]![1]!.body as string)).toEqual({ merge_method: 'squash', sha: 'head1' })
  })

  it('reports a pull request merged already, or closed', async () => {
    serve({ 'GET /repos/octo/demo/pulls/7': () => json(pr({ merged: true, merge_commit_sha: 'm1' })) })
    expect(await mergePullRequest('t', repo, 7)).toEqual({ kind: 'merged', sha: 'm1' })
    vi.restoreAllMocks()
    serve({ 'GET /repos/octo/demo/pulls/7': () => json(pr({ state: 'closed' })) })
    expect(await mergePullRequest('t', repo, 7)).toMatchObject({ kind: 'failed' })
  })

  it('brings a branch that is behind up to date instead of merging it', async () => {
    const { calls } = serve({
      'GET /repos/octo/demo/pulls/7': () => json(pr({ mergeable_state: 'behind' })),
      'PUT /repos/octo/demo/pulls/7/update-branch': () => json({ message: 'Updating pull request branch.' }, 202),
    })

    expect(await mergePullRequest('t', repo, 7)).toEqual({ kind: 'updated' })
    expect(calls.at(-1)).toBe('PUT /repos/octo/demo/pulls/7/update-branch')
  })

  it('reports conflicts, and waits while GitHub computes mergeability or protection blocks it', async () => {
    serve({ 'GET /repos/octo/demo/pulls/7': () => json(pr({ mergeable: false, mergeable_state: 'dirty' })) })
    expect(await mergePullRequest('t', repo, 7)).toEqual({ kind: 'conflict' })
    vi.restoreAllMocks()
    serve({ 'GET /repos/octo/demo/pulls/7': () => json(pr({ mergeable: null, mergeable_state: 'unknown' })) })
    expect(await mergePullRequest('t', repo, 7)).toMatchObject({ kind: 'waiting' })
    vi.restoreAllMocks()
    serve({ 'GET /repos/octo/demo/pulls/7': () => json(pr({ mergeable_state: 'blocked' })) })
    expect(await mergePullRequest('t', repo, 7)).toMatchObject({ kind: 'waiting', detail: expect.stringContaining('Branch protection') })
  })

  it('waits when GitHub refuses the merge itself', async () => {
    serve({
      'GET /repos/octo/demo/pulls/7': () => json(pr({})),
      'PUT /repos/octo/demo/pulls/7/merge': () => json({ message: 'Base branch was modified.' }, 409),
    })
    expect(await mergePullRequest('t', repo, 7)).toEqual({ kind: 'waiting', detail: 'GitHub 409: Base branch was modified.' })
  })
})
