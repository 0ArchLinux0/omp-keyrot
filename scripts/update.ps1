# Pull latest overlay and reinstall (Windows). Does not overwrite keys.
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
if (Test-Path (Join-Path $Root ".git")) {
  git pull --ff-only
} else {
  Write-Error "Not a git clone. git clone https://github.com/0ArchLinux0/omp-keyrot.git"
  exit 1
}
& (Join-Path $Root "scripts\install.ps1")
