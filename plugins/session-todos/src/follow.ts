export interface TodoEvents {
  on(type: 'session.todos_changed', handler: () => void): () => void
}

/** Coalesce bursts, but always reread if a change arrives during an in-flight read. */
export function followTodos(events: TodoEvents, refresh: () => Promise<void>, report: (message: string) => void) {
  let active = true
  let running = false
  let dirty = false
  const unsubscribe = events.on('session.todos_changed', () => {
    dirty = true
    void drain()
  })
  async function drain() {
    if (running || !active) return
    running = true
    try {
      while (dirty && active) {
        dirty = false
        await refresh()
      }
    } catch {
      report('Session Todos could not refresh. Reopen the panel to reconnect.')
    } finally {
      running = false
    }
  }
  return () => { active = false; unsubscribe() }
}
