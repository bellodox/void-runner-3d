@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%"

start "Void Runner Relay" "%SCRIPT_DIR%leaderboard-relay.exe"
start "Void Runner Game" "%SCRIPT_DIR%index.html"

popd
endlocal
