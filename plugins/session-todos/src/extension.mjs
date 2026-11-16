import { createCanvas, CanvasError, joinSession } from '@github/copilot-sdk/extension'
import { CanvasHost } from '@rwoll/canvas-kit/server'
import { CanvasKitError } from '@rwoll/canvas-kit'
import { fileURLToPath } from 'node:url'
import { createTodoCanvas } from '../../../canvases/session-todos/canvas.ts'
import { followTodos } from './follow.ts'

let session
const ready = Promise.withResolvers()
const definition = createTodoCanvas({
  read: () => session.rpc.plan.readSqlTodosWithDependencies(),
})
const log = (message, level = 'info') => {
  void session.log(message, { level }).catch(() => {
    process.stderr.write('session-todos: could not report a diagnostic to the session.\n')
  })
}
const host = new CanvasHost(definition, {
  uiDir: fileURLToPath(new URL('./ui/', import.meta.url)),
  indexFile: 'session-todos.html',
  session: ready.promise,
  log,
})
const instances = new Set()
async function guard(run) {
  try { return await run() }
  catch (error) {
    if (error instanceof CanvasError) throw error
    if (error instanceof CanvasKitError) throw new CanvasError(error.code, error.message)
    log('Session Todos could not read the runtime or open its panel.', 'error')
    throw new CanvasError('todos_unavailable', 'Could not load session todos. Check that this host supports the plan API, then reopen.')
  }
}
const canvas = createCanvas({
  id: definition.id,
  displayName: definition.title,
  description: definition.description,
  actions: [...definition.actions.values()].map(action => ({
    name: action.name,
    description: action.description,
    inputSchema: action.inputJsonSchema,
    handler: ctx => guard(() => host.invoke({ instanceId: ctx.instanceId, actionName: action.name, input: ctx.input, source: 'agent' })),
  })),
  open: ctx => guard(async () => {
    instances.add(ctx.instanceId)
    try { return await host.open({ instanceId: ctx.instanceId, input: ctx.input }) }
    catch (error) { instances.delete(ctx.instanceId); throw error }
  }),
  onClose: ctx => guard(async () => {
    instances.delete(ctx.instanceId)
    await host.closeInstance(ctx.instanceId)
  }),
})
session = await joinSession({ canvases: [canvas] })
ready.resolve(session)
const stopFollowing = followTodos(session, async () => {
  for (const instanceId of instances) {
    await host.invoke({ instanceId, actionName: 'refresh', source: 'agent' })
  }
}, message => log(message, 'error'))

async function close() {
  stopFollowing()
  await host.close()
}
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void close().then(() => process.exit(0), () => {
      process.stderr.write('session-todos: could not close the canvas cleanly.\n')
      process.exit(1)
    })
  })
}
