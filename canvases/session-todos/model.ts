import { CanvasKitError, z } from '@rwoll/canvas-kit'

const rowSchema = z.object({
  id: z.string().min(1).max(1024),
  title: z.string().max(100_000).optional(),
  description: z.string().max(1_000_000).optional(),
  status: z.string().max(1024).optional(),
  createdAt: z.string().max(128).optional(),
})
const edgeSchema = z.object({ todoId: z.string().max(1024), dependsOn: z.string().max(1024) })
const resultSchema = z.object({
  rows: z.array(rowSchema).max(100_000),
  dependencies: z.array(edgeSchema).max(1_000_000),
})
export const todoSchema = rowSchema.extend({
  changedAt: z.number().nullable(),
  change: z.enum(['added', 'edited', 'started', 'completed', 'blocked', 'reopened']).nullable(),
})
export const snapshotSchema = z.object({
  sessionId: z.string().nullable(),
  rows: z.array(todoSchema),
  dependencies: z.array(edgeSchema),
  changedAt: z.number().nullable(),
  revision: z.number(),
  removed: z.object({ count: z.number(), at: z.number() }).nullable(),
  error: z.string().nullable(),
})
export type Todo = z.infer<typeof todoSchema>
export type Snapshot = z.infer<typeof snapshotSchema>

export function emptySnapshot(sessionId?: string): Snapshot {
  return { sessionId: sessionId ?? null, rows: [], dependencies: [], changedAt: null, revision: 0, removed: null, error: null }
}

const edgeKey = (edge: z.infer<typeof edgeSchema>) => JSON.stringify([edge.todoId, edge.dependsOn])

export function mergeSnapshot(previous: Snapshot, input: unknown, now: number | null): Snapshot {
  const parsed = resultSchema.safeParse(input)
  if (!parsed.success) throw new CanvasKitError('invalid_todos', 'The runtime returned an unsupported todo snapshot.')
  const { rows, dependencies } = parsed.data
  if (new Set(rows.map(row => row.id)).size !== rows.length) {
    throw new CanvasKitError('invalid_todos', 'The runtime returned duplicate todo IDs.')
  }
  const baseline = previous.revision === 0
  const old = new Map(previous.rows.map(row => [row.id, row]))
  const edges = [...new Set(dependencies.map(edgeKey))].sort()
  const oldEdges = [...new Set(previous.dependencies.map(edgeKey))].sort()
  const edgeChanged = JSON.stringify(edges) !== JSON.stringify(oldEdges)
  let changed = edgeChanged || rows.length !== previous.rows.length
  const next = rows.map((row, index): Todo => {
    const before = old.get(row.id)
    const ownEdges = (list: string[]) => list.filter(key => JSON.parse(key)[0] === row.id)
    const edited = !before || row.title !== before.title || row.description !== before.description ||
      row.status !== before.status || row.createdAt !== before.createdAt ||
      (edgeChanged && JSON.stringify(ownEdges(edges)) !== JSON.stringify(ownEdges(oldEdges)))
    changed ||= edited || previous.rows[index]?.id !== row.id
    let change: Todo['change'] = before?.change ?? null
    if (edited && !baseline) {
      change = !before ? 'added' : row.status !== before.status
        ? row.status === 'done' ? 'completed'
          : row.status === 'in_progress' ? 'started'
            : row.status === 'blocked' ? 'blocked'
              : before.status === 'done' ? 'reopened' : 'edited'
        : 'edited'
    }
    return { ...row, changedAt: baseline ? null : edited ? now : before?.changedAt ?? null, change }
  })
  const ids = new Set(rows.map(row => row.id))
  const removed = previous.rows.filter(row => !ids.has(row.id)).length
  return {
    ...previous, rows: next, dependencies, error: null,
    revision: previous.revision + (changed || baseline ? 1 : 0),
    changedAt: !baseline && changed ? now : previous.changedAt,
    removed: removed && now !== null ? { count: removed, at: now } : previous.removed,
  }
}

export function waitingOn(todo: Todo, state: Snapshot): string[] {
  const byId = new Map(state.rows.map(row => [row.id, row]))
  return state.dependencies.filter(edge => edge.todoId === todo.id)
    .filter(edge => byId.get(edge.dependsOn)?.status !== 'done')
    .map(edge => byId.get(edge.dependsOn)?.title || edge.dependsOn)
}

export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}
