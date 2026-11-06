export function resolve(specifier, context, nextResolve) {
  if (specifier === "@github/copilot-sdk/extension") {
    return { url: new URL("./canvas-sdk.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
