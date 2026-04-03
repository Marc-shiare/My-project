param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$GitArgs
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$gitRoot = Join-Path $repoRoot "tools\git-portable"
$gitExe = Join-Path $gitRoot "cmd\git.exe"

if (-not (Test-Path $gitExe)) {
  Write-Error "Portable Git was not found at $gitExe"
  exit 1
}

$env:GIT_EXEC_PATH = Join-Path $gitRoot "mingw64\bin"
$env:PATH = "$($env:GIT_EXEC_PATH);$(Join-Path $gitRoot 'usr\bin');$(Join-Path $gitRoot 'cmd');$env:PATH"

if (-not $GitArgs -or $GitArgs.Count -eq 0) {
  & $gitExe --version
  exit $LASTEXITCODE
}

& $gitExe @GitArgs
exit $LASTEXITCODE
