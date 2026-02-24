#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="$HOME/.atoms"
BIN_NAME="atoms-mcp"
BASE_URL="https://github.com/smallest-inc/mcp-server/releases/latest/download"

print_step() { printf "\n\033[1;34m→\033[0m %s\n" "$1"; }
print_ok()   { printf "  \033[1;32m✓\033[0m %s\n" "$1"; }
print_err()  { printf "  \033[1;31m✗\033[0m %s\n" "$1" >&2; }

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *)      print_err "Unsupported OS: $os"; exit 1 ;;
  esac

  case "$arch" in
    x86_64|amd64)  arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)             print_err "Unsupported architecture: $arch"; exit 1 ;;
  esac

  echo "${os}-${arch}"
}

get_api_key() {
  if [ -n "${ATOMS_API_KEY:-}" ]; then
    return
  fi

  printf "\n  Enter your Atoms API key (from console.smallest.ai → API Keys): "
  read -r ATOMS_API_KEY

  if [ -z "$ATOMS_API_KEY" ]; then
    print_err "API key is required."
    exit 1
  fi
}

download_binary() {
  local platform="$1"
  local url="${BASE_URL}/${BIN_NAME}-${platform}"
  local dest="${INSTALL_DIR}/${BIN_NAME}"

  mkdir -p "$INSTALL_DIR"

  print_step "Downloading atoms-mcp for ${platform}..."

  if command -v curl &>/dev/null; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget &>/dev/null; then
    wget -qO "$dest" "$url"
  else
    print_err "Neither curl nor wget found. Install one and try again."
    exit 1
  fi

  chmod +x "$dest"
  print_ok "Installed to ${dest}"
}

configure_cursor() {
  local config_dir config_file
  config_dir="$HOME/.cursor"
  config_file="${config_dir}/mcp.json"

  mkdir -p "$config_dir"

  if [ -f "$config_file" ]; then
    if grep -q '"atoms"' "$config_file" 2>/dev/null; then
      print_ok "Cursor config already has atoms entry — updating API key"
      local tmp
      tmp=$(mktemp)
      sed "s|ATOMS_API_KEY.*|ATOMS_API_KEY\": \"${ATOMS_API_KEY}\"|" "$config_file" > "$tmp"
      mv "$tmp" "$config_file"
      return
    fi

    if grep -q '"mcpServers"' "$config_file" 2>/dev/null; then
      local tmp
      tmp=$(mktemp)
      sed 's/"mcpServers"[[:space:]]*:[[:space:]]*{/"mcpServers": {\
    "atoms": {\
      "command": "INSTALL_DIR_PLACEHOLDER\/atoms-mcp",\
      "env": {\
        "ATOMS_API_KEY": "API_KEY_PLACEHOLDER"\
      }\
    },/' "$config_file" \
        | sed "s|INSTALL_DIR_PLACEHOLDER|${INSTALL_DIR}|g" \
        | sed "s|API_KEY_PLACEHOLDER|${ATOMS_API_KEY}|g" > "$tmp"
      mv "$tmp" "$config_file"
      print_ok "Added atoms to existing Cursor config"
      return
    fi
  fi

  cat > "$config_file" << JSONEOF
{
  "mcpServers": {
    "atoms": {
      "command": "${INSTALL_DIR}/atoms-mcp",
      "env": {
        "ATOMS_API_KEY": "${ATOMS_API_KEY}"
      }
    }
  }
}
JSONEOF
  print_ok "Created Cursor config at ${config_file}"
}

configure_claude() {
  local config_dir config_file

  case "$(uname -s)" in
    Darwin) config_dir="$HOME/Library/Application Support/Claude" ;;
    Linux)  config_dir="$HOME/.config/claude" ;;
    *)      return ;;
  esac

  config_file="${config_dir}/claude_desktop_config.json"
  mkdir -p "$config_dir"

  if [ -f "$config_file" ] && grep -q '"atoms"' "$config_file" 2>/dev/null; then
    print_ok "Claude Desktop config already has atoms entry"
    return
  fi

  if [ ! -f "$config_file" ] || [ ! -s "$config_file" ]; then
    cat > "$config_file" << JSONEOF
{
  "mcpServers": {
    "atoms": {
      "command": "${INSTALL_DIR}/atoms-mcp",
      "env": {
        "ATOMS_API_KEY": "${ATOMS_API_KEY}"
      }
    }
  }
}
JSONEOF
    print_ok "Created Claude Desktop config at ${config_file}"
  else
    print_ok "Claude Desktop config exists — add atoms manually if needed"
  fi
}

main() {
  echo ""
  echo "  ╔══════════════════════════════════════╗"
  echo "  ║     Atoms MCP Server Installer       ║"
  echo "  ╚══════════════════════════════════════╝"

  local platform
  platform="$(detect_platform)"

  get_api_key
  download_binary "$platform"

  print_step "Configuring editors..."
  configure_cursor
  configure_claude

  echo ""
  echo "  ┌──────────────────────────────────────┐"
  echo "  │  Done! Restart your editor to start. │"
  echo "  │                                      │"
  echo "  │  Cursor: Cmd+Shift+P → Reload Window │"
  echo "  │  Claude: Quit and reopen the app     │"
  echo "  │                                      │"
  echo "  │  Then type: \"List all my agents\"      │"
  echo "  └──────────────────────────────────────┘"
  echo ""
}

main "$@"
