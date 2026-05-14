@echo off
rem Use %~dp0 (this script's directory) instead of CLAUDE_PLUGIN_ROOT env var,
rem which Claude Code sets with a trailing space on Windows.
set "PLUGIN_ROOT=%~dp0"
if "%PLUGIN_ROOT:~-1%"=="\" set "PLUGIN_ROOT=%PLUGIN_ROOT:~0,-1%"
set "CLAUDE_PLUGIN_ROOT=%PLUGIN_ROOT%"
bun "%PLUGIN_ROOT%\server.ts"
