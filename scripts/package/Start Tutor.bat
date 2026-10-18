@echo off
rem Start the tutor. The server opens the browser. To stop the tutor, close this window.
title Tutor
set "APP=%~dp0app"

rem Windows can open a zip file as a folder. Then this file runs alone in a temporary folder, with no other files.
if not exist "%APP%\node.exe" (
  echo Extract the zip file first. Right-click the zip file, click "Extract All", and then open the new folder.
  pause
  exit /b 1
)

"%APP%\node.exe" "%APP%\dist\server\main.js" --app
if errorlevel 1 pause
