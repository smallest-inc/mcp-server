# Atoms MCP Server Installer for Windows
$ErrorActionPreference = "Stop"

$InstallDir = "$env:USERPROFILE\.atoms"
$BinName = "atoms-mcp.exe"
$BaseUrl = "https://github.com/smallest-inc/mcp-server/releases/latest/download"

Write-Host ""
Write-Host "  ╔══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║     Atoms MCP Server Installer       ║" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════════╝" -ForegroundColor Cyan

# Detect architecture
$arch = if ([Environment]::Is64BitOperatingSystem) {
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
} else {
    Write-Host "  ✗ 32-bit Windows is not supported." -ForegroundColor Red
    exit 1
}

$platform = "windows-$arch"
$url = "$BaseUrl/atoms-mcp-$platform.exe"

# Get API key
if (-not $env:ATOMS_API_KEY) {
    Write-Host ""
    $apiKey = Read-Host "  Enter your Atoms API key (from console.smallest.ai → API Keys)"
    if (-not $apiKey) {
        Write-Host "  ✗ API key is required." -ForegroundColor Red
        exit 1
    }
} else {
    $apiKey = $env:ATOMS_API_KEY
}

# Download binary
Write-Host ""
Write-Host "  → Downloading atoms-mcp for $platform..." -ForegroundColor Blue
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$dest = Join-Path $InstallDir $BinName

try {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
    Write-Host "  ✓ Installed to $dest" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Download failed. Windows binaries may not be available yet." -ForegroundColor Red
    Write-Host "  ✗ Use the npm approach instead: npx @developer-smallestai/atoms-mcp-server" -ForegroundColor Yellow
    exit 1
}

# Configure Cursor
Write-Host ""
Write-Host "  → Configuring Cursor..." -ForegroundColor Blue
$cursorDir = "$env:USERPROFILE\.cursor"
$cursorConfig = Join-Path $cursorDir "mcp.json"
New-Item -ItemType Directory -Force -Path $cursorDir | Out-Null

$atomsEntry = @{
    command = $dest
    env = @{
        ATOMS_API_KEY = $apiKey
    }
}

if (Test-Path $cursorConfig) {
    $config = Get-Content $cursorConfig -Raw | ConvertFrom-Json
    if (-not $config.mcpServers) {
        $config | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue @{} -Force
    }
    $config.mcpServers | Add-Member -NotePropertyName "atoms" -NotePropertyValue $atomsEntry -Force
    $config | ConvertTo-Json -Depth 10 | Set-Content $cursorConfig
} else {
    @{ mcpServers = @{ atoms = $atomsEntry } } | ConvertTo-Json -Depth 10 | Set-Content $cursorConfig
}
Write-Host "  ✓ Cursor config updated at $cursorConfig" -ForegroundColor Green

# Configure Claude Desktop
$claudeDir = "$env:APPDATA\Claude"
$claudeConfig = Join-Path $claudeDir "claude_desktop_config.json"

if (Test-Path $claudeDir) {
    New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null
    if (-not (Test-Path $claudeConfig)) {
        @{ mcpServers = @{ atoms = $atomsEntry } } | ConvertTo-Json -Depth 10 | Set-Content $claudeConfig
        Write-Host "  ✓ Claude Desktop config created at $claudeConfig" -ForegroundColor Green
    } else {
        Write-Host "  ✓ Claude Desktop config exists — add atoms manually if needed" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "  ┌──────────────────────────────────────┐" -ForegroundColor Cyan
Write-Host "  │  Done! Restart your editor to start. │" -ForegroundColor Cyan
Write-Host "  │                                      │" -ForegroundColor Cyan
Write-Host "  │  Cursor: Ctrl+Shift+P → Reload       │" -ForegroundColor Cyan
Write-Host "  │  Claude: Quit and reopen the app     │" -ForegroundColor Cyan
Write-Host "  │                                      │" -ForegroundColor Cyan
Write-Host "  │  Then type: `"List all my agents`"     │" -ForegroundColor Cyan
Write-Host "  └──────────────────────────────────────┘" -ForegroundColor Cyan
Write-Host ""
