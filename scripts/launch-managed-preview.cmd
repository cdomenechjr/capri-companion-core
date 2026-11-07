@echo off
rem Explicit reviewed external Node, controller, verb, public configuration and pin.
rem No PATH lookup, startup registration, execution-policy change or app overwrite.
if "%~5"=="" exit /b 2
if /I "%~3"=="bootstrap" goto bootstrap
"%~1" "%~2" "%~3" --config "%~4" --config-sha256 "%~5"
exit /b %errorlevel%
:bootstrap
if "%~6"=="" exit /b 2
"%~1" "%~2" bootstrap --config "%~4" --config-sha256 "%~5" --generation "%~6"
exit /b %errorlevel%
