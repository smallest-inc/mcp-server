import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * A failed tool call. isError is how the client knows the call failed, so the
 * model retries or fixes its input instead of reading the error as data.
 */
export function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
