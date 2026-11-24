@echo off
REM Usage: audit.cmd "D:\path\to\original.jpg" ["D:\path\to\whiteboard-output.jpg"]
REM
REM   arg1 = original photo (baseline, should be the unprocessed shot)
REM   arg2 = whiteboard output produced by the app (optional comparison)
REM Runs the whiteboard-pipeline A/B audit against the local VLM (llama.cpp).
setlocal
set "IMG=%~1"
set "CMP=%~2"
if "%IMG%"=="" (
  echo Usage: audit.cmd "original.jpg" ["whiteboard.jpg"]
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE="
set "EXE=%TEMP%\elec-run\electron.exe"
if not exist "%EXE%" set "EXE=%~dp0node_modules\electron\dist\electron.exe"
if "%CMP%"=="" (
  "%EXE%" "%~dp0." --audit "%IMG%"
) else (
  "%EXE%" "%~dp0." --audit "%IMG%" --compare "%CMP%"
)
endlocal
