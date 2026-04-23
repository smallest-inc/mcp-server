# Smallest MCP Server

MCP server for the [Smallest AI](https://smallest.ai) platform. Manage agents, debug calls, view analytics — directly from your IDE.

## Quick start

### Option A: npm (recommended)

Requires Node.js 18+. Add this to your MCP config (`~/.cursor/mcp.json` for Cursor, `claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "smallest": {
      "command": "npx",
      "args": ["-y", "@developer-smallestai/smallest-mcp-server"],
      "env": {
        "ATOMS_API_KEY": "sk_your_key_here"
      }
    }
  }
}
```

Auto-updates to the latest version every time your editor restarts.

### Option B: One-line installer (no dependencies)

**Mac / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/smallest-inc/mcp-server/main/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/smallest-inc/mcp-server/main/install.ps1 | iex
```

Downloads a standalone binary, prompts for your API key, and configures Cursor + Claude Desktop automatically. Re-run to update.

### Option C: One prompt

Open a chat in Cursor or Claude Desktop and type:

```
Set up the Smallest MCP server for me.
The npm package is @developer-smallestai/smallest-mcp-server.
My API key is: sk_paste_your_key_here
```

### Verify

Reload your editor, then type: **"List all my agents"**

---

## Available tools

### Read

| Tool | Description |
|---|---|
| `list_calls` | Search and list calls with filters for status, type, date range, agent, phone number |
| `debug_call` | Get detailed info about a single call — status, transcript, errors, analytics, latency |
| `get_agents` | List agents with their configuration, voice, LLM model, and call stats |
| `get_agent` | Get full details for a single agent |
| `get_agent_prompt` | Read an agent's current system prompt and tools |
| `get_usage_stats` | Usage statistics — total calls, duration, costs, status breakdown |
| `get_campaigns` | List outbound calling campaigns with status and progress |
| `get_phone_numbers` | List phone numbers owned by your organization |
| `get_voices` | List available voices with gender, language, and model filters |

### Write

| Tool | Description |
|---|---|
| `create_agent` | Create a new AI voice agent |
| `update_agent_prompt` | Update an agent's system prompt / instructions |
| `update_agent_config` | Update agent settings — name, language, voice, first message, etc. |
| `delete_agent` | Archive (soft-delete) or unarchive an agent |
| `publish_draft` | Publish or discard a draft on a versioned agent |

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

| Variable | Required | Description |
|---|---|---|
| `ATOMS_API_KEY` | Yes | Your Smallest AI API key |

## Development

```bash
npm install
npm run dev    # run with tsx
npm run build  # bundle to dist/
```

## Releases

Merging to `main` automatically publishes a new version to npm and GitHub Releases.

**Version bumps are automatic** based on commit messages:

| Commit message contains | Bump | Example |
|---|---|---|
| `new tool`, `new resource`, `add tool`, `add resource` | **minor** (0.2.0 → 0.3.0) | `feat: add new tool for knowledge bases` |
| `BREAKING CHANGE` or `feat!:` | **major** (0.2.0 → 1.0.0) | `feat!: redesign agent config schema` |
| Anything else | **patch** (0.2.0 → 0.2.1) | `fix: handle empty call logs` |

## License

MIT
