import { defineCanvasConfig } from '@rwoll/canvas-kit/playwright'

export default defineCanvasConfig({
  testDir: './canvases',
  retries: 0,
  use: { viewport: { width: 360, height: 800 } },
})
