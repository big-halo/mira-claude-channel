@echo off
rem %~dp0 is the directory of this script (no trailing-space issue from CLAUDE_PLUGIN_ROOT env var)
set "PLUGIN_ROOT=%~dp0"
rem Remove trailing backslash so paths join cleanly
if "%PLUGIN_ROOT:~-1%"=="\" set "PLUGIN_ROOT=%PLUGIN_ROOT:~0,-1%"
set "CLAUDE_PLUGIN_ROOT=%PLUGIN_ROOT%"
bun "%PLUGIN_ROOT%\server.ts"
