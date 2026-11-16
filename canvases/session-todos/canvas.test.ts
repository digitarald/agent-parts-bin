import { createTestCanvas } from '@rwoll/canvas-kit/testing'
import { afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTodoCanvas } from './canvas.ts'
import { emptySnapshot, mergeSnapshot, waitingOn } from './model.ts'
import { followTodos } from '../../plugins/session-todos/src/follow.ts'

let close: (() => Promise<void>) | undefined
afterEach(() => close?.())
const initial = { rows: [{ id: 'a', title: 'Build the adapter', status: 'in_progress' }], dependencies: [] }

it('highlights real changes, preserves ages on reread/reopen, and never sends a prompt', async () => {
  let result = initial
  let now = 1000
  const harness = await createTestCanvas(createTodoCanvas({ read: async () => result }), { now: () => now })
  close = harness.close
  const opened = await harness.open('monitor')
  assert.equal(harness.state('monitor')?.rows[0]?.changedAt, null)
  result = { ...initial, rows: [{ ...initial.rows[0]!, title: 'Verify the adapter', status: 'done' }] }
  await harness.invoke('monitor', 'refresh')
  assert.equal(harness.state('monitor')?.rows[0]?.title, 'Verify the adapter')
  assert.equal(harness.state('monitor')?.rows[0]?.change, 'completed')
  assert.equal(harness.state('monitor')?.rows[0]?.changedAt, 1000)
  now = 9000
  await harness.invoke('monitor', 'refresh')
  assert.equal((await harness.open('monitor')).url, opened.url)
  assert.equal(harness.state('monitor')?.rows[0]?.changedAt, 1000)
  assert.deepEqual(harness.sentToAgent, [])
  await assert.rejects(harness.host.invoke({ instanceId: 'monitor', actionName: 'refresh', input: { query: 'DELETE FROM todos' }, source: 'ui' }), { code: 'invalid_input' })
})

it('retains last-known data on read failure and clears the error on recovery', async () => {
  let fail = false
  const harness = await createTestCanvas(createTodoCanvas({ read: async () => {
    if (fail) throw new Error('transport closed')
    return initial
  } }))
  close = harness.close
  await harness.open('monitor')
  fail = true
  await harness.invoke('monitor', 'refresh')
  assert.equal(harness.state('monitor')?.rows[0]?.id, 'a')
  assert.match(harness.state('monitor')?.error ?? '', /Could not read/)
  fail = false
  await harness.invoke('monitor', 'refresh')
  assert.equal(harness.state('monitor')?.error, null)
})

it('tracks dependency edits and removals, keeps unknown statuses, and rejects malformed data', () => {
  const start = mergeSnapshot(emptySnapshot(), {
    rows: [...initial.rows, { id: 'b', title: 'Review', status: 'pending' }], dependencies: [],
  }, null)
  const next = mergeSnapshot(start, {
    rows: start.rows.map(row => ({ ...row, status: row.id === 'a' ? 'custom' : row.status })),
    dependencies: [{ todoId: 'b', dependsOn: 'a' }],
  }, 2000)
  assert.equal(next.rows[0]?.status, 'custom')
  assert.equal(next.rows[1]?.change, 'edited')
  assert.equal(next.rows[1]?.changedAt, 2000)
  assert.deepEqual(waitingOn(next.rows[1]!, next), ['Build the adapter'])
  assert.deepEqual(mergeSnapshot(next, { rows: [], dependencies: [] }, 3000).removed, { count: 2, at: 3000 })
  assert.throws(() => mergeSnapshot(next, { rows: [{ title: 'No identity' }], dependencies: [] }, 4000), /unsupported todo snapshot/)
  assert.throws(() => mergeSnapshot(next, { rows: [...initial.rows, ...initial.rows], dependencies: [] }, 4000), /duplicate todo IDs/)
})

it('rereads after a change during an in-flight read and unsubscribes on close', async () => {
  let listener = () => {}
  let unsubscribed = false
  let reads = 0
  let release!: () => void
  let done!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const finished = new Promise<void>(resolve => { done = resolve })
  const reports: string[] = []
  const stop = followTodos({ on: (_type, handler) => {
    listener = handler
    return () => { unsubscribed = true }
  } }, async () => {
    reads++
    if (reads === 1) await gate
    else done()
  }, message => reports.push(message))
  listener()
  listener()
  listener()
  release()
  await finished
  assert.equal(reads, 2)
  stop()
  listener()
  assert.equal(unsubscribed, true)
  assert.equal(reads, 2)
  assert.deepEqual(reports, [])
})
