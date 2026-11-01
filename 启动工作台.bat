@echo off
cd /d "%~dp0"
rem 注意：应用路径结尾加 "."，避免 %~dp0 尾部反斜杠把闭引号转义掉
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
