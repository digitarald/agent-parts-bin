import { useEffect, useState } from 'react'
import { createCanvasHooks } from '@rwoll/canvas-kit/react'
import type canvas from './canvas.ts'
import { relativeTime, waitingOn, type Snapshot, type Todo } from './model.ts'
import './App.css'

const { useCanvas, useAction } = createCanvasHooks<typeof canvas>()

function StatusIcon({ status }: { status: string | undefined }) {
  return <svg className={`status-icon status-${status ?? 'unknown'}`} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    {status === 'done' ? <path d="m4 10 4 4 8-9" /> : status === 'blocked'
      ? <><circle cx="10" cy="10" r="6" /><path d="M6 10h8" /></>
      : status === 'in_progress' ? <><circle cx="10" cy="10" r="6" /><circle cx="10" cy="10" r="2.4" fill="currentColor" stroke="none" /></>
        : <circle cx="10" cy="10" r="6" />}
  </svg>
}

function TodoRow({ todo, state, now }: { todo: Todo, state: Snapshot, now: number }) {
  const dependencies = waitingOn(todo, state)
  const recent = todo.changedAt !== null && now - todo.changedAt < 12_000
  const detail = Boolean(todo.description || dependencies.length)
  const title = todo.title || todo.id
  const summary = <>
    <StatusIcon status={todo.status} />
    <span className="row-content">
      <span className="todo-title">{title}</span>
      {todo.changedAt !== null && <span className="row-meta">
        {todo.change === 'edited' ? 'Edited' : todo.change === 'completed' ? 'Done'
          : todo.change === 'started' ? 'Started' : todo.change === 'blocked' ? 'Blocked'
            : todo.change === 'reopened' ? 'Reopened' : 'Added'}{' '}
        <time dateTime={new Date(todo.changedAt).toISOString()} title={new Date(todo.changedAt).toLocaleString()}>
          {relativeTime(todo.changedAt, now)}
        </time>
      </span>}
      {!!dependencies.length && todo.status !== 'done' && <span className="dependency-preview" title={dependencies.join(', ')}>
        After {dependencies[0]}{dependencies.length > 1 ? ` +${dependencies.length - 1}` : ''}
      </span>}
    </span>
    {detail && <svg className="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>}
  </>
  return <li className={`todo-row ${recent ? 'recent' : ''}`} data-todo-id={todo.id}>
    {recent && <span key={`${todo.changedAt}-${todo.change}`} className="change-flash" aria-hidden="true" />}
    {detail ? <details>
      <summary>{summary}</summary>
      <div className="todo-detail">
        {todo.description && <p>{todo.description}</p>}
        {!!dependencies.length && <p className="dependency-detail">Waiting for {dependencies.join(', ')}</p>}
      </div>
    </details> : <div className="row-summary">{summary}</div>}
  </li>
}

export default function App() {
  const { state, status, agent } = useCanvas()
  const [refresh, { pending, error }] = useAction('refresh')
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const active = state.rows.filter(row => row.status === 'in_progress')
  const blocked = state.rows.filter(row => row.status === 'blocked')
  const unknown = state.rows.filter(row => !['in_progress', 'blocked', 'pending', 'done'].includes(row.status ?? ''))
  const pendingRows = state.rows.filter(row => row.status === 'pending')
  const done = state.rows.filter(row => row.status === 'done')
  const justDone = done.filter(row => row.change === 'completed' && row.changedAt !== null && now - row.changedAt < 15_000)
  const completed = done.filter(row => !justDone.includes(row))
  const problem = state.error || error?.message
  const connection = problem ? 'Needs refresh' : status === 'live' ? (agent.busy ? 'Agent working' : 'Agent idle')
    : status === 'connecting' ? 'Connecting' : 'Reconnecting'
  const section = (title: string, rows: Todo[], name: string) => rows.length > 0 && <section className={`todo-section ${name}`} aria-label={title}>
    <h2>{title}<span className="section-count">{rows.length}</span></h2>
    <ul>{rows.map(todo => <TodoRow key={todo.id} todo={todo} state={state} now={now} />)}</ul>
  </section>
  return <main className="todo-panel">
    <header className="panel-header">
      <div className="title-line">
        <h1>Todos</h1>
        {!!state.rows.length && <span className="completion-count" aria-label={`${done.length} of ${state.rows.length} todos done`}>{done.length}<span> / {state.rows.length}</span></span>}
      </div>
      <span className={`connection ${problem || status !== 'live' ? 'disconnected' : ''}`} role="status">
        <span className="connection-dot" aria-hidden="true" />{connection}
      </span>
    </header>
    {!!state.rows.length && <div className="progress-track" role="progressbar" aria-label="Completed todos" aria-valuenow={done.length} aria-valuemin={0} aria-valuemax={state.rows.length}>
      <span style={{ width: `${done.length / state.rows.length * 100}%` }} />
    </div>}
    {problem && <div className="read-error" role="alert"><span>{problem} {state.rows.length > 0 && 'Showing the last read.'}</span>
      <button type="button" disabled={pending} onClick={() => refresh()}>Retry</button>
    </div>}
    {!state.rows.length && !problem && <div className="empty-state">
      <StatusIcon status="pending" /><h2>No todos yet</h2><p>The agent's plan will appear here.</p>
    </div>}
    <div className={`work-columns ${active.length || blocked.length || unknown.length ? 'has-focus' : ''}`}>
      <div className="focus-column">
        {section('In progress', active, 'active-section')}
        {section('Blocked', blocked, 'blocked-section')}
        {section('Unspecified status', unknown, 'unknown-section')}
      </div>
      <div className="next-column">{section('Next', pendingRows, 'next-section')}</div>
    </div>
    {section('Just finished', justDone, 'finished-section')}
    {completed.length > 0 && <details className="completed-section">
      <summary>Completed <span className="section-count">{completed.length}</span></summary>
      <ul>{completed.map(todo => <TodoRow key={todo.id} todo={todo} state={state} now={now} />)}</ul>
    </details>}
    {state.rows.length > 0 && <footer>
      <span>{state.changedAt === null ? 'Watching for changes' : <>Updated <time dateTime={new Date(state.changedAt).toISOString()}>{relativeTime(state.changedAt, now)}</time></>}</span>
      {state.removed && now - state.removed.at < 15_000 && <span>{state.removed.count} removed</span>}
    </footer>}
    <span className="visually-hidden" aria-live="polite" aria-atomic="true">
      {state.changedAt === null ? '' : `Todo list updated. ${active.length} in progress, ${blocked.length} blocked, ${done.length} done.`}
    </span>
  </main>
}
