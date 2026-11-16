import { canvasTest, expect } from '@rwoll/canvas-kit/playwright'
import { createTodoCanvas } from './canvas.ts'
import { fileURLToPath } from 'node:url'

const original = {
  rows: [
    { id: 'active', title: 'Wire the session events', description: 'Subscribe before the first read.\nKeep the last good state if the connection drops.', status: 'in_progress' },
    { id: 'blocked', title: 'Check the host connection', description: 'Waiting for host access.', status: 'blocked' },
    { id: 'next', title: 'Verify the narrow-panel layout', status: 'pending' },
    { id: 'long', title: 'Handle a long task title without squeezing out the status or adding horizontal scrolling', status: 'pending' },
    { id: 'done', title: 'Read the SDK contract', status: 'done' },
  ],
  dependencies: [{ todoId: 'next', dependsOn: 'active' }],
}
let result = structuredClone(original)
let unavailable = false
const test = canvasTest(createTodoCanvas({ read: async () => {
  if (unavailable) throw new Error('Disconnected')
  return result
} }), { uiDir: fileURLToPath(new URL('../../plugins/session-todos/com.github.copilot/extensions/session-todos/ui', import.meta.url)) })
test.beforeEach(() => { result = structuredClone(original); unavailable = false })

test('live edits, completion, age and reopen work in a compact read-only panel', async ({ openCanvas, agent }) => {
  const { page, instanceId } = await openCanvas()
  await expect(page.getByRole('heading', { name: 'In progress' })).toBeVisible()
  await expect(page.getByText('After Wire the session events', { exact: true })).toBeVisible()
  await expect(page.getByText('Read the SDK contract')).not.toBeVisible()
  await page.getByText('Wire the session events', { exact: true }).click()
  await expect(page.getByText('Subscribe before the first read.', { exact: false })).toBeVisible()
  result.rows[0]!.title = '<script>not executable</script>'
  await agent.invoke('refresh')
  await expect(page.getByText('<script>not executable</script>', { exact: true })).toBeVisible()
  await expect(page.getByText('After <script>not executable</script>', { exact: true })).toBeVisible()
  await expect(page.getByText('Edited just now')).toBeVisible()
  result.rows[0]!.status = 'done'
  await agent.invoke('refresh')
  await expect(page.getByRole('heading', { name: 'Just finished' })).toBeVisible()
  await expect(page.getByText('After <script>not executable</script>', { exact: true })).not.toBeVisible()
  await openCanvas(undefined, { instanceId })
  await expect(page.getByRole('heading', { name: 'Just finished' })).toBeVisible()
  expect(agent.messages).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('shows a recoverable read error without blanking the todo list', async ({ openCanvas, agent }) => {
  const { page } = await openCanvas()
  unavailable = true
  await agent.invoke('refresh')
  await expect(page.getByRole('alert')).toContainText('Showing the last read.')
  await expect(page.getByText('Wire the session events', { exact: true })).toBeVisible()
  unavailable = false
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByRole('alert')).not.toBeVisible()
})

test('fits sidebar and maximized widths with keyboard details and reduced motion', async ({ openCanvas }, testInfo) => {
  const { page } = await openCanvas()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const width of [320, 1100]) {
    await page.setViewportSize({ width, height: 800 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`todos-${width}.png`), fullPage: true })
  }
  await page.keyboard.press('Tab')
  await expect(page.getByRole('region', { name: 'In progress' }).locator('summary')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Subscribe before the first read.', { exact: false })).toBeVisible()
})
