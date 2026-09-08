$Root = Split-Path -Parent $PSScriptRoot
$HomeDir = $env:USERPROFILE
New-Item -ItemType Directory -Force -Path "$HomeDir\.local\bin","$HomeDir\.local\daemon\xot","$HomeDir\.pi\agent\extensions","$HomeDir\.pi\agent\skills\xot","$HomeDir\.pi\agent" | Out-Null
Copy-Item "$Root\bin\xot-rotate.ps1" "$HomeDir\.local\bin\xot-rotate.ps1" -Force
Copy-Item "$Root\pi-extensions\*.ts" "$HomeDir\.pi\agent\extensions\" -Force
Copy-Item "$Root\skills\xot\SKILL.md" "$HomeDir\.pi\agent\skills\xot\SKILL.md" -Force
if (-not (Test-Path "$HomeDir\.local\daemon\xot\keys")) {
  Copy-Item "$Root\xot\keys.example" "$HomeDir\.local\daemon\xot\keys"
}
if (-not (Test-Path "$HomeDir\.pi\agent\.env")) {
  Copy-Item "$Root\pi-agent\.env.example" "$HomeDir\.pi\agent\.env"
  Write-Host "Created $HomeDir\.pi\agent\.env (XOT_STRICT_ROTATE=1)"
} elseif (-not (Select-String -Path "$HomeDir\.pi\agent\.env" -Pattern '^XOT_STRICT_ROTATE=' -Quiet)) {
  Add-Content -Path "$HomeDir\.pi\agent\.env" -Value "XOT_STRICT_ROTATE=1"
  Write-Host "Appended XOT_STRICT_ROTATE=1 to existing .env"
}
$cfg = "$HomeDir\.pi\agent\config.yml"
if (-not (Test-Path $cfg)) {
  (Get-Content "$Root\pi-agent\config.example.yml" -Raw).Replace('@HOME@', $HomeDir.Replace('\','/')) | Set-Content $cfg -NoNewline
  Write-Host "Created $cfg from config.example.yml"
}
Write-Host "Fill $HomeDir\.local\daemon\xot\keys then restart omp/pi"
Write-Host "Status bar: live-status.ts installed; footer shows XOT key after restart"
