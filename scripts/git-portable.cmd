@echo off
setlocal

set "REPO_ROOT=%~dp0.."
set "GIT_ROOT=%REPO_ROOT%\tools\git-portable"
set "GIT_EXE=%GIT_ROOT%\cmd\git.exe"

if not exist "%GIT_EXE%" (
  echo Portable Git was not found at "%GIT_EXE%"
  exit /b 1
)

set "GIT_EXEC_PATH=%GIT_ROOT%\mingw64\bin"
set "PATH=%GIT_EXEC_PATH%;%GIT_ROOT%\usr\bin;%GIT_ROOT%\cmd;%PATH%"

"%GIT_EXE%" %*
exit /b %ERRORLEVEL%
