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
  read -r ATOMS_API_KEY < /dev/tty

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

upsert_json_config() {
  local config_file="$1"
  local bin_path="${INSTALL_DIR}/${BIN_NAME}"

  python3 -c "
import json, sys, os

path = sys.argv[1]
cmd  = sys.argv[2]
key  = sys.argv[3]

atoms_entry = {
    'command': cmd,
    'env': {'ATOMS_API_KEY': key}
}

if os.path.isfile(path) and os.path.getsize(path) > 0:
    with open(path) as f:
        try:
            cfg = json.load(f)
        except json.JSONDecodeError:
            cfg = {}
else:
    cfg = {}

cfg.setdefault('mcpServers', {})
cfg['mcpServers']['atoms'] = atoms_entry

with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
" "$config_file" "$bin_path" "$ATOMS_API_KEY"
}

configure_cursor() {
  local config_dir="$HOME/.cursor"
  local config_file="${config_dir}/mcp.json"
  mkdir -p "$config_dir"

  upsert_json_config "$config_file"
  print_ok "Cursor config ready at ${config_file}"
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

  upsert_json_config "$config_file"
  print_ok "Claude Desktop config ready at ${config_file}"
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
