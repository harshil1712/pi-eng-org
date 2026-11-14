/** What sent a message the team wrote into a session, rather than a person. */
export type TeamMessageKind = 'update' | 'patrol' | 'manager' | 'reviewer' | 'qa' | 'person' | 'merge' | 'brief'

export type TeamMessageView = {
  kind: TeamMessageKind
  /** Who or what it is from, such as "Team update" or "Reviewer · round 2 of 3". */
  label: string
  /** One line to show while it is folded. */
  summary: string
  /** The rest, as markdown. */
  body: string
}

/** The boilerplate the registry puts around updates and patrols, which the model needs and the person does not. */
const UPDATE_HEADER = /^\[Team update\][^\n]*\n?/

const PATROL_HEADER = /^\[Patrol\][^\n]*\n?/

const UPDATE_FOOTER = /\n+Act on what needs you:[^\n]*\s*$/

const PATROL_FOOTER = /\n+Go through each builder:[^\n]*\s*$/

/**
 * A message the team wrote, recognized by the prefixes the registry gives
 * them, or undefined for one a person typed. `firstOfTeamSession` also
 * recognizes the brief a builder, reviewer or QA session starts with.
 */
export function parseTeamMessage(text: string, firstOfTeamSession = false): TeamMessageView | undefined {
  if (UPDATE_HEADER.test(text)) {
    const body = text.replace(UPDATE_HEADER, '').replace(UPDATE_FOOTER, '').trim()
    const items = body.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2))

    return { kind: 'update', label: items.length === 1 ? 'Team update' : `Team update · ${items.length}`, summary: items.join(' · '), body }
  }

  if (PATROL_HEADER.test(text)) {
    const body = text.replace(PATROL_HEADER, '').replace(PATROL_FOOTER, '').trim()
    const active = body.split('\n').filter((line) => line.startsWith('- ')).length
    const ready = /^Ready to assign[^:]*: (.*)$/m.exec(body)?.[1]
    const summary = [active ? `${active} active ${active === 1 ? 'ticket' : 'tickets'}` : 'No builders working', ready ? `ready: ${ready}` : ''].filter(Boolean).join(' · ')

    return { kind: 'patrol', label: 'Patrol', summary, body }
  }

  const tagged = /^\[(Manager|Reviewer, round (\d+) of (\d+)|QA|Person|Merge queue)\]\s*/.exec(text)

  if (tagged) {
    const body = text.slice(tagged[0].length).trim()
    const [, sender = '', round, of] = tagged
    const view = (kind: TeamMessageKind, label: string): TeamMessageView => ({ kind, label, summary: firstLine(body), body })

    if (round) return view('reviewer', `Reviewer · round ${round} of ${of}`)

    if (sender === 'Manager') return view('manager', 'Manager')

    if (sender === 'QA') return view('qa', 'QA')

    if (sender === 'Person') return view('person', 'You, from the review inbox')

    return view('merge', 'Merge queue')
  }

  if (!firstOfTeamSession) return undefined
  const brief = /^(?:Ticket (T-\d+): (.+)|Review round (\d+) of (\d+) for ticket (T-\d+): (.+)|QA for ticket (T-\d+): (.+))$/m.exec(firstLine(text))

  if (!brief) return undefined
  const [, ticket, title, round, of, reviewed, reviewTitle, checked, qaTitle] = brief
  const label = ticket ? `Ticket ${ticket}` : reviewed ? `Review request · ${reviewed} · round ${round} of ${of}` : `QA request · ${checked}`

  return { kind: 'brief', label, summary: title ?? reviewTitle ?? qaTitle ?? '', body: text.trim() }
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim() ?? ''
}
