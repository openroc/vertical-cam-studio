# Launch "Vertical Cam Studio"
#
# Self-healing logic:
#   1) Clear ELECTRON_RUN_AS_NODE (it turns electron into plain node -> crash at startup)
#   2) Health-check candidates: project node_modules -> %TEMP%\elec-run mirror
#   3) If none works, copy project dist to %TEMP%\elec-run and retry
#      (electron.exe may crash when launched from a monitored/overlay drive)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

function Test-Electron([string]$exe) {
    if (-not $exe -or -not (Test-Path $exe)) { return $false }
    $outFile = Join-Path $env:TEMP 'vcs-electron-check.txt'
    try {
        # cmd + file redirection: reliable under restricted shells where a piped
        # child process cannot write to an anonymous pipe
        cmd /c "`"$exe`" --version > `"$outFile`" 2>&1"
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

$mirrorDir = Join-Path $env:TEMP 'elec-run'
$candidates = @(
    (Join-Path $root 'node_modules\electron\dist\electron.exe'),
    (Join-Path $mirrorDir 'electron.exe')
)

$exe = $null
foreach ($c in $candidates) {
    if (Test-Electron $c) {
        $exe = $c
        break
    }
}

if (-not $exe) {
    $src = Join-Path $root 'node_modules\electron\dist'
    if (Test-Path $src) {
        Write-Host 'Local electron failed the health check, copying to temp and retrying...' -ForegroundColor Yellow
        New-Item -ItemType Directory -Force -Path $mirrorDir | Out-Null
        Copy-Item "$src\*" -Destination $mirrorDir -Recurse -Force
        $mirrorExe = Join-Path $mirrorDir 'electron.exe'
        if (Test-Electron $mirrorExe) { $exe = $mirrorExe }
    }
}

if (-not $exe) {
    Write-Host 'Failed to launch: no usable electron. Run "npm install" in the project folder first.' -ForegroundColor Red
    exit 1
}

Write-Host "Using electron: $exe" -ForegroundColor DarkGray
Write-Host 'Launching...' -ForegroundColor Green
Start-Process -FilePath $exe -ArgumentList "`"$root`""
