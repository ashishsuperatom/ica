// What a person is told when something they asked for did not happen: the plain words the screen chose. The reason the
// platform or the engine gave goes to the console, for whoever looks into it — people never see internals.
export function plainly(plain: string, reason?: unknown): string {
  if (reason) console.warn(`[refused] ${plain} —`, reason)
  return plain
}

/** A refused form: a 400 or 409 says what to change in what the person wrote, so its words are theirs to read; any other
 *  refusal (no permission, the platform failing) is said plainly and its reason logged. */
export function formRefusal(status: number, error: string | undefined, plain: string): string {
  return (status === 400 || status === 409) && error ? error : plainly(plain, error ?? `HTTP ${status}`)
}
