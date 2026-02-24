# Atoms MCP Server

MCP server for the [Atoms](https://atoms.smallest.ai) voice AI platform. Manage agents, debug calls, view analytics — directly from your IDE.

## Quick start

### Option A: One-line installer (no dependencies)

**Mac / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/smallest-inc/mcp-server/main/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/smallest-inc/mcp-server/main/install.ps1 | iex
```

Downloads a standalone binary, prompts for your API key, and configures Cursor + Claude Desktop automatically.

### Option B: npm

Requires Node.js 18+. Add this to your MCP config (`~/.cursor/mcp.json` for Cursor, `claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "atoms": {
      "command": "npx",
      "args": ["-y", "@developer-smallestai/atoms-mcp-server"],
      "env": {
        "ATOMS_API_KEY": "sk_your_key_here"
      }
    }
  }
}
```

### Option C: One prompt

Open a chat in Cursor or Claude Desktop and type:

```
Set up the Atoms MCP server for me.
The npm package is @developer-smallestai/atoms-mcp-server.
My API key is: sk_paste_your_key_here
```

### Verify

Reload your editor, then type: **"List all my agents"**

---

## Available tools

### Read

| Tool | Description |
|---|---|
| `get_call_logs` | Query call logs with filters for status, type, date range, agent name, or phone number |
| `debug_call` | Deep-dive into a single call — full transcript, errors, timing, cost breakdown, post-call analytics |
| `get_agents` | List agents with their configuration, voice, LLM model, and call stats |
| `get_usage_stats` | Usage statistics — total calls, duration, costs, status breakdown |
| `get_campaigns` | List outbound calling campaigns with status and progress |
| `get_phone_numbers` | List phone numbers owned by your organization |

### Write

| Tool | Description |
|---|---|
| `create_agent` | Create a new AI voice agent |
| `update_agent_prompt` | Update an agent's system prompt / instructions |
| `update_agent_config` | Update agent settings — name, language, voice, first message, etc. |
| `delete_agent` | Archive (soft-delete) an agent |

### Act

| Tool | Description |
|---|---|
| `make_call` | Initiate an outbound phone call using a specific agent |

### Resources

| Resource | URI | Description |
|---|---|---|
| Platform Overview | `atoms://docs/platform-overview` | Key concepts, call types, statuses, and cost breakdown |

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ATOMS_API_KEY` | Yes | — | Your Atoms API key |
| `ATOMS_API_URL` | No | `https://atoms-api.smallest.ai/api/v1` | Override the API base URL |

## Development

```bash
npm install
npm run dev    # run with tsx
npm run build  # bundle to dist/
```

## License

MIT
