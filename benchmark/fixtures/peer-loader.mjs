export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@earendil-works/pi-coding-agent") {
    return { url: "data:text/javascript,export const CONFIG_DIR_NAME = '.pi';", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
