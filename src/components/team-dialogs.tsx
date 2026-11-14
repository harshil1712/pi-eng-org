import { useId, useState, type SubmitEvent } from 'react'
import { Input, InputArea } from '@cloudflare/kumo/components/input'
import { LayerDialog } from '@cloudflare/kumo/components/layer-dialog'
import type { CreateTicketInput, Ticket } from '~/contract'
import { RecordingPlayer } from './recording-player'

type OpenProps = { open: boolean; onOpenChange: (open: boolean) => void }

export function RecordingDialog({ ticket, open, onOpenChange }: OpenProps & { ticket: Ticket | null }) {
  return (
    <LayerDialog.Root open={open} onOpenChange={onOpenChange}>
      <LayerDialog.Content size="xl">
        <LayerDialog.Title>{ticket ? `${ticket.id} QA recording` : 'QA recording'}</LayerDialog.Title>
        <LayerDialog.Description>Everything the QA agent's browser showed while it exercised the change.</LayerDialog.Description>
        <LayerDialog.Body>
          {open && ticket && <RecordingPlayer ticketId={ticket.id} />}
        </LayerDialog.Body>
      </LayerDialog.Content>
    </LayerDialog.Root>
  )
}

export function SendBackDialog({ ticket, open, onOpenChange, onSendBack }: OpenProps & {
  ticket: Ticket | null
  onSendBack: (ticket: Ticket, note: string) => Promise<void>
}) {
  const formId = useId()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!ticket) return
    setBusy(true)
    await onSendBack(ticket, note)
    setBusy(false)
    setNote('')
  }

  return (
    <LayerDialog.Root open={open} onOpenChange={onOpenChange} dismissDisabled={busy}>
      <LayerDialog.Content>
        <LayerDialog.Title>Send {ticket?.id} back</LayerDialog.Title>
        <LayerDialog.Description>The builder gets your note as its next message, and the manager hears about it.</LayerDialog.Description>
        <LayerDialog.Body>
          <form id={formId} onSubmit={(event) => void submit(event)}>
            <InputArea label="What needs to change" value={note} onValueChange={setNote} rows={4} required />
          </form>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="Cancel">
          <LayerDialog.Action form={formId} type="submit" loading={busy}>Send back</LayerDialog.Action>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  )
}

export function NewTicketDialog({ open, tickets, onOpenChange, onCreate }: OpenProps & {
  tickets: Ticket[]
  onCreate: (input: CreateTicketInput) => Promise<void>
}) {
  const formId = useId()
  const [title, setTitle] = useState('')
  const [repo, setRepo] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [dependsOn, setDependsOn] = useState('')
  const [spec, setSpec] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    const ids = dependsOn.split(/[\s,]+/).filter(Boolean)
    await onCreate({ title, repo, spec, ...(baseBranch.trim() ? { baseBranch } : {}), ...(ids.length ? { dependsOn: ids } : {}) })
    setBusy(false)
  }

  const unfinished = tickets.filter((ticket) => ticket.status !== 'done' && ticket.status !== 'cancelled').map((ticket) => ticket.id)
  // The repository most tickets were for, to save typing it again.
  const usual = tickets.at(-1)?.repo

  return (
    <LayerDialog.Root open={open} onOpenChange={onOpenChange} dismissDisabled={busy}>
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>New ticket</LayerDialog.Title>
        <LayerDialog.Description>One ticket is one pull request. The manager hears about it and decides when to start a builder.</LayerDialog.Description>
        <LayerDialog.Body>
          <form id={formId} onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
            <Input label="Title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} required />
            <div className="grid gap-4 md:grid-cols-2">
              <Input label="Repository" value={repo} onChange={(event) => setRepo(event.target.value)} placeholder={usual ?? 'owner/name'} required />
              <Input label="Base branch" value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} placeholder="Default branch" required={false} />
            </div>
            <Input
              label="Depends on"
              description="Tickets that must be done first, such as T-1, T-2."
              value={dependsOn}
              onChange={(event) => setDependsOn(event.target.value)}
              placeholder={unfinished.length ? unfinished.slice(0, 3).join(', ') : 'T-1, T-2'}
              required={false}
            />
            <InputArea label="Spec" value={spec} onValueChange={setSpec} rows={5} placeholder="What to build, and how to know it is done." required />
          </form>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="Cancel">
          <LayerDialog.Action form={formId} type="submit" loading={busy}>Create ticket</LayerDialog.Action>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  )
}
