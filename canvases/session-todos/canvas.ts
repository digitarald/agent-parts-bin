import { CanvasKitError, defineCanvas, z } from '@rwoll/canvas-kit'
import { emptySnapshot, mergeSnapshot, snapshotSchema } from './model.ts'

export interface TodoSource {
  read(): Promise<unknown>
}

export function createTodoCanvas(source: TodoSource) {
  return defineCanvas({
    id: 'parts-bin-session-todos',
    title: 'Session Todos',
    description: 'Follow the current session todos, dependencies, and recent changes without model calls.',
    state: snapshotSchema,
    versionFooter: false,
    init: async ({ sessionId }) => mergeSnapshot(emptySnapshot(sessionId), await source.read(), null),
    reopen: async ({ state }) => mergeSnapshot(state, await source.read(), Date.now()),
    actions: ({ action }) => ({
      refresh: action({
        description: 'Reread this session’s todos from the runtime, without a model call or SQL tool invocation.',
        run: async (ctx) => {
          try {
            ctx.setState(mergeSnapshot(ctx.state, await source.read(), ctx.now()))
          } catch (error) {
            ctx.log(error instanceof CanvasKitError ? error.message : 'Could not read session todos.', 'error')
            // Preserve the last good list and make stale data explicit to every view.
            ctx.setState({ ...ctx.state, error: 'Could not read todos. Retry to reconnect.' })
          }
          return ctx.state
        },
      }),
    }),
  })
}

export default createTodoCanvas({
  async read() {
    throw new CanvasKitError('session_required', 'Open Session Todos in a Copilot session. The standalone preview has no session.')
  },
})
