$ErrorActionPreference = "Stop"

$InstallDir = "$env:USERPROFILE\.atoms"
$BinName = "atoms-mcp-windows-x64.exe"
$BaseUrl = "https://github.com/smallest-inc/mcp-server/releases/latest/download"

function Print-Step($msg) { Write-Host "`n→ $msg" -ForegroundColor Cyan }
function Print-Ok($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Print-Err($msg)  { Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  ╔══════════════════════════════════════╗"
Write-Host "  ║     Atoms MCP Server Installer       ║"
Write-Host "  ╚══════════════════════════════════════╝"

if (-not $env:ATOMS_API_KEY) {
    $env:ATOMS_API_KEY = Read-Host "`n  Enter your Atoms API key (from console.smallest.ai → API Keys)"
    if (-not $env:ATOMS_API_KEY) { Print-Err "API key is required." }
}

Print-Step "Downloading atoms-mcp for windows-x64..."
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$dest = Join-Path $InstallDir "atoms-mcp.exe"
Invoke-WebRequest -Uri "$BaseUrl/$BinName" -OutFile $dest -UseBasicParsing
Print-Ok "Installed to $dest"

Print-Step "Configuring editors..."

# Cursor
$cursorDir = "$env:USERPROFILE\.cursor"
$cursorFile = Join-Path $cursorDir "mcp.json"
New-Item -ItemType Directory -Force -Path $cursorDir | Out-Null

if (Test-Path $cursorFile) {
    $content = Get-Content $cursorFile -Raw
    if ($content -match '"atoms"') {
        Print-Ok "Cursor config already has atoms entry"
    } elseif ($content -match '"mcpServers"') {
        $config = $content | ConvertFrom-Json
        $config.mcpServers | Add-Member -NotePropertyName "atoms" -NotePropertyValue ([PSCustomObject]@{
            command = $dest
            env = [PSCustomObject]@{ ATOMS_API_KEY = $env:ATOMS_API_KEY }
        })
        $config | ConvertTo-Json -Depth 10 | Set-Content $cursorFile
        Print-Ok "Added atoms to existing Cursor config"
    }
} else {
    @{
        mcpServers = @{
            atoms = @{
                command = $dest
                env = @{ ATOMS_API_KEY = $env:ATOMS_API_KEY }
            }
        }
    } | ConvertTo-Json -Depth 10 | Set-Content $cursorFile
    Print-Ok "Created Cursor config at $cursorFile"
}

# Claude Desktop
$claudeDir = "$env:APPDATA\Claude"
$claudeFile = Join-Path $claudeDir "claude_desktop_config.json"
New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null

if (-not (Test-Path $claudeFile)) {
    @{
        mcpServers = @{
            atoms = @{
                command = $dest
                env = @{ ATOMS_API_KEY = $env:ATOMS_API_KEY }
            }
        }
    } | ConvertTo-Json -Depth 10 | Set-Content $claudeFile
    Print-Ok "Created Claude Desktop config at $claudeFile"
} else {
    Print-Ok "Claude Desktop config exists — check atoms entry manually if needed"
}

Write-Host ""
Write-Host "  ┌──────────────────────────────────────┐"
Write-Host "  │  Done! Restart your editor to start. │"
Write-Host "  │                                      │"
Write-Host "  │  Cursor: Ctrl+Shift+P → Reload       │"
Write-Host "  │  Claude: Quit and reopen the app     │"
Write-Host "  │                                      │"
Write-Host '  │  Then type: "List all my agents"      │'
Write-Host "  └──────────────────────────────────────┘"
Write-Host ""
