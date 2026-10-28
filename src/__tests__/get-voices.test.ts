import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { wavesApi } = vi.hoisted(() => ({ wavesApi: vi.fn() }));
vi.mock("../waves-api.js", () => ({
  wavesApi,
  formatWavesApiError: () => "upstream error",
}));

import { registerGetVoices } from "../tools/get-voices.js";

function tool() {
  let schema!: z.ZodRawShape;
  let handler!: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
  registerGetVoices({
    registerTool: (_name: string, config: { inputSchema: z.ZodRawShape }, fn: typeof handler) => {
      schema = config.inputSchema;
      handler = fn;
    },
  } as never);
  return async (args: Record<string, unknown> = {}) => {
    const result = await handler(z.object(schema).parse(args));
    return JSON.parse(result.content[0].text);
  };
}

const voices = Array.from({ length: 600 }, (_, i) => ({
  voiceId: `voice-${i}`,
  displayName: `Voice ${i}`,
  description: "x".repeat(1000),
  audioPreview: "x".repeat(1000),
  tags: { gender: i % 2 ? "male" : "female", language: [i % 2 ? "Hindi" : "English"] },
  modelIds: [i % 2 ? "model-a" : "model-b"],
}));

beforeEach(() => {
  wavesApi.mockReset();
  wavesApi.mockResolvedValue({ ok: true, data: { voices } });
});

describe("get_voices", () => {
  it("applies pagination through the MCP protocol", async () => {
    const server = new McpServer({ name: "test", version: "1" });
    registerGetVoices(server);
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({ name: "get_voices", arguments: { limit: 2, offset: 1 } });
      const content = response.content as Array<{ text: string }>;
      const body = JSON.parse(content[0].text);
      expect(body.voices.map((v: { voiceId: string }) => v.voiceId)).toEqual(["voice-1", "voice-2"]);
      expect(body.total).toBe(600);
      expect(body.hasMore).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("bounds the default response and pages disjoint results", async () => {
    const call = tool();
    const first = await call();
    const second = await call({ offset: 50 });
    expect(first.total).toBe(600);
    expect(first.hasMore).toBe(true);
    expect(first.voices).toHaveLength(50);
    expect(JSON.stringify(first).length).toBeLessThan(50_000);
    expect(new Set([...first.voices, ...second.voices].map((v: { voiceId: string }) => v.voiceId)).size).toBe(100);
    const last = await call({ offset: 590, limit: 50 });
    expect(last.voices).toHaveLength(10);
    expect(last.hasMore).toBe(false);
  });

  it("combines filters before counting and slicing", async () => {
    const result = await tool()({ name: "VOICE-1", model: "MODEL-A", gender: "male", language: "hin", limit: 2 });
    expect(result.total).toBeGreaterThan(2);
    expect(result.voices).toHaveLength(2);
    expect(result.voices.every((v: { voiceId: string }) => v.voiceId.includes("voice-1"))).toBe(true);
    const allMatching = voices.filter((v) => v.voiceId.includes("voice-1") && v.tags.gender === "male").length;
    expect(result.total).toBe(allMatching);
    const empty = await tool()({ name: "no such voice" });
    expect(empty).toMatchObject({ total: 0, hasMore: false, voices: [] });
    const pastEnd = await tool()({ offset: 601 });
    expect(pastEnd).toMatchObject({ total: 600, hasMore: false, voices: [] });
  });

  it("bounds cloned voices in the same pagination and preserves errors", async () => {
    const clones = Array.from({ length: 80 }, (_, i) => ({ voiceId: `clone-${i}`, displayName: `Clone ${i}`, status: "ready", modelIds: ["model-a"] }));
    wavesApi.mockImplementation(async (_method: string, path: string) => path === "/voice-cloning"
      ? { ok: true, data: { data: clones } } : { ok: true, data: { voices: voices.slice(0, 2) } });
    const call = tool();
    const first = await call({ include_cloned: true, limit: 3 });
    expect(first.total).toBe(82);
    expect(first.voices).toHaveLength(2);
    expect(first.clonedVoices).toHaveLength(1);
    expect((await call({ include_cloned: true, offset: 3, limit: 3 })).clonedVoices).toHaveLength(3);
    const filtered = await call({ include_cloned: true, name: "clone-1", model: "MODEL-A" });
    expect(filtered.total).toBe(11);
    expect(filtered.voices).toEqual([]);
    expect(filtered.clonedVoices).toHaveLength(11);
    wavesApi.mockImplementation(async (_method: string, path: string) => path === "/voice-cloning"
      ? { ok: false } : { ok: true, data: { voices: [] } });
    expect((await call({ include_cloned: true })).clonedVoicesError).toContain("upstream error");
  });

  it("rejects invalid pagination", async () => {
    await expect(tool()({ limit: 201 })).rejects.toThrow();
    await expect(tool()({ offset: -1 })).rejects.toThrow();
    await expect(tool()({ limit: 1.5 })).rejects.toThrow();
  });
});
