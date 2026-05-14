@echo off
echo PATH=%PATH% > C:\Users\charl\mira-launch-debug.txt
echo USERPROFILE=%USERPROFILE% >> C:\Users\charl\mira-launch-debug.txt
echo CLAUDE_PLUGIN_ROOT=%CLAUDE_PLUGIN_ROOT% >> C:\Users\charl\mira-launch-debug.txt
where bun >> C:\Users\charl\mira-launch-debug.txt 2>&1
set "PATH=%PATH%;%USERPROFILE%\.bun\bin"
bun "%CLAUDE_PLUGIN_ROOT%\server.ts"
