import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { contextFromEnv, setProcessDefault } from "./context.js";
import { registerResources } from "./resources/index.js";
import { registerTools } from "./tools/index.js";

// One process, one user: resolve the caller once and let every tool read it
// through requireContext(). A hosted server sets this per request instead.
setProcessDefault(contextFromEnv());

const server = new McpServer(
  {
    name: "smallest",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

registerTools(server, { localFilesystem: true });
registerResources(server);

const transport = new StdioServerTransport();
await server.connect(transport);
