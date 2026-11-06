// Evaluation-only transport seam; the extension, board, and HTTP server stay real.
let registration;

export class CanvasError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CanvasError";
    this.code = code;
  }
}

export const createCanvas = (canvas) => canvas;

export async function joinSession({ canvases }) {
  if (registration) throw new Error("The headless fixture supports one SDK session per process.");
  registration = canvases;
  return {
    log: async (message) => process.stderr.write(`[canvas headless-sdk-contract] ${String(message)}\n`),
  };
}

export function getRegisteredCanvases() {
  if (!registration) throw new Error("The extension has not joined the fixture session. It must call joinSession({ canvases }) when it loads.");
  return registration;
}
