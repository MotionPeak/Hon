@echo off
REM Starts Hon's local engine and opens the web app (Windows).
REM Double-click this file, or run it from a terminal. The real launcher is
REM web.mjs — cross-platform Node, no shell quirks.
node "%~dp0web.mjs" %*
