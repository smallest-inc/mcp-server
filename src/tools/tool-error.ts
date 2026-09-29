/**
 * A failed tool call. isError is how the client knows the call failed, so the
 * model retries or fixes its input instead of reading the error as data.
 */
export function toolError(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
