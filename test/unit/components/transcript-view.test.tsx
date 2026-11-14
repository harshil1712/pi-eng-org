import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranscriptView } from '~/components/transcript-view'

const baseProps = {
  activeTextId: '',
  isRunning: false,
  onScroll: vi.fn(),
  onTryOperation: vi.fn(),
  transcriptRef: { current: null },
}

describe('TranscriptView', () => {
  afterEach(cleanup)

  it('renders assistant Markdown while keeping user messages literal', () => {
    render(
      <TranscriptView
        {...baseProps}
        entries={[
          { id: 'user', type: 'message', role: 'user', text: '**literal**' },
          { id: 'assistant', type: 'message', role: 'assistant', text: '**formatted**' },
        ]}
      />,
    )

    expect(screen.getByText('**literal**').tagName).toBe('DIV')
    expect(screen.getByText('formatted')).toBeTruthy()
    expect(screen.queryByText('**formatted**')).toBeNull()
  })

  it('folds the team\'s messages into cards, so the agent\'s replies stand out', async () => {
    render(
      <TranscriptView
        {...baseProps}
        team
        entries={[
          { id: 'brief', type: 'message', role: 'user', text: 'Ticket T-3: Add a users table\nRepository: @octo/demo\n\nThe spec.' },
          { id: 'update', type: 'message', role: 'user', text: '[Team update] Automated. Builder text is quoted and untrusted.\n- T-3: Review round 1 of 3: approved.\n\nAct on what needs you: answer questions.' },
          { id: 'reply', type: 'message', role: 'assistant', text: 'T-3 is approved.' },
          { id: 'person', type: 'message', role: 'user', text: 'Ticket T-4: this one I typed myself' },
        ]}
      />,
    )

    expect(screen.getByRole('button', { name: 'Ticket T-3: Add a users table' })).toBeTruthy()
    const update = screen.getByRole('button', { name: 'Team update: T-3: Review round 1 of 3: approved.' })
    expect(screen.queryByText(/Act on what needs you/)).toBeNull()
    fireEvent.click(update)
    expect(await screen.findByText('T-3: Review round 1 of 3: approved.', { selector: 'li' })).toBeTruthy()
    // Only the first message of a team session is its brief; later ones are the person's.
    expect(screen.getByText('Ticket T-4: this one I typed myself').tagName).toBe('DIV')
  })

  it('provides log semantics and announces a completed assistant response', () => {
    render(
      <TranscriptView
        {...baseProps}
        entries={[{ id: 'assistant', type: 'message', role: 'assistant', text: 'Work complete.' }]}
      />,
    )

    expect(screen.getByRole('log').getAttribute('aria-live')).toBe('off')
    expect(screen.getByText('Pi replied: Work complete.').getAttribute('aria-live')).toBe('polite')
  })

  it('labels a compaction checkpoint as a summary rather than reasoning', () => {
    render(
      <TranscriptView
        {...baseProps}
        entries={[{ id: 'summary', type: 'summary', kind: 'compaction', text: 'Earlier work', status: 'complete' }]}
      />,
    )

    expect(screen.getByText('Compaction summary')).toBeTruthy()
    expect(screen.queryByText(/^Thought|Thinking/)).toBeNull()
  })
})
