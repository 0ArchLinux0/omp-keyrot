$Root = Split-Path -Parent $PSScriptRoot
$HomeDir = $env:USERPROFILE
New-Item -ItemType Directory -Force -Path "$HomeDir\.local\bin","$HomeDir\.local\daemon\xot","$HomeDir\.pi\agent\extensions","$HomeDir\.pi\agent\skills\xot" | Out-Null
Copy-Item "$Root\bin\xot-rotate.ps1" "$HomeDir\.local\bin\xot-rotate.ps1" -Force
Copy-Item "$Root\pi-extensions\*.ts" "$HomeDir\.pi\agent\extensions\" -Force
Copy-Item "$Root\skills\xot\SKILL.md" "$HomeDir\.pi\agent\skills\xot\SKILL.md" -Force
if (-not (Test-Path "$HomeDir\.local\daemon\xot\keys")) {
  Copy-Item "$Root\xot\keys.example" "$HomeDir\.local\daemon\xot\keys"
}
Write-Host "Fill $HomeDir\.local\daemon\xot\keys then restart omp/pi"
