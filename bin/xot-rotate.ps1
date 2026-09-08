# xot-rotate.ps1 — simplest possible key rotator for Windows.
# Rule: (current+1) % N every request.
# On real-daily-limit 429: mark key as cooling (skip until cooldown expires).
# On transient 429: rotate normally.
#
# State file: $env:USERPROFILE\.local\daemon\xot\state
#   ACTIVE_IDX=N
#   ROTATED_AT=<epoch>
#   COOL_<fingerprint>=<epoch>
#
# Usage:
#   xot-rotate.ps1 pick
#   xot-rotate.ps1 cool <fingerprint>
#   xot-rotate.ps1 status

param(
  [Parameter(Position=0)]
  [ValidateSet('pick','cool','status')]
  [string]$Command = 'pick'
)

$Script:KEY_FILE   = "$env:USERPROFILE\.local\daemon\xot\keys"
$Script:STATE_FILE = "$env:USERPROFILE\.local\daemon\xot\state"
$Script:COOL_SECS  = if ($env:XOT_COOL_SECS) { [int]$env:XOT_COOL_SECS } else { 28800 }

function Get-StateValue($key) {
  if (-not (Test-Path $Script:STATE_FILE)) { return $null }
  $m = Select-String -Path $Script:STATE_FILE -Pattern "^${key}=" | Select-Object -First 1
  if ($m) { return $m.Line.Split('=',2)[1] } else { return $null }
}

function Set-State($idx) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $coolLines = @()
  if (Test-Path $Script:STATE_FILE) {
    foreach ($line in Get-Content $Script:STATE_FILE) {
      if ($line -match '^COOL_') {
        $parts = $line -split '=', 2
        $ts = $parts[1] -as [long]
        if ($ts -gt $now) { $coolLines += $line }
      }
    }
  }
  $lines = @("ACTIVE_IDX=$idx", "ROTATED_AT=$now") + $coolLines
  [System.IO.File]::WriteAllLines($Script:STATE_FILE, $lines, [System.Text.UTF8Encoding]::new($false))
}

function Add-CoolEntry($fp) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $until = $now + $Script:COOL_SECS
  $lines = @()
  if (Test-Path $Script:STATE_FILE) {
    foreach ($line in Get-Content $Script:STATE_FILE) {
      if ($line -notmatch "^COOL_${fp}=") { $lines += $line }
    }
  }
  $lines += "COOL_${fp}=${until}"
  [System.IO.File]::WriteAllLines($Script:STATE_FILE, $lines, [System.Text.UTF8Encoding]::new($false))
}

function Get-KeyFingerprint($key) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($key)
  $hash = $sha.ComputeHash($bytes)
  $sha.Dispose()
  return [BitConverter]::ToString($hash).Replace('-','').Substring(0,16).ToLower()
}

function Invoke-Pick {
  if (-not (Test-Path $Script:KEY_FILE)) {
    Write-Error "xot-rotate: no keys file: $Script:KEY_FILE"
    exit 1
  }

  $keys = @(Get-Content $Script:KEY_FILE | Where-Object { $_ -match '^sk-or-' })
  $N = $keys.Count
  if ($N -eq 0) {
    Write-Error "xot-rotate: no keys"
    exit 1
  }

  $activeIdx = 0
  $s = Get-StateValue "ACTIVE_IDX"
  if ($s) { $activeIdx = [Math]::Max(0, [int]$s) }

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $start = ($activeIdx + 1) % $N
  $idx = $start
  $found = $false

  for ($i = 0; $i -lt $N; $i++) {
    $fp = Get-KeyFingerprint $keys[$idx]
    $coolTs = Get-StateValue "COOL_${fp}"
    if (-not $coolTs -or ($now -gt [long]$coolTs)) {
      $found = $true
      break
    }
    $idx = ($idx + 1) % $N
  }

  if (-not $found) {
    Write-Error "xot-rotate: all keys cooling — forcing next"
    $idx = $start
  }

  $key = $keys[$idx]
  Set-State $idx

  Write-Output "export OPENROUTER_API_KEY='${key}'"
  if ($idx -ne $activeIdx) {
    Write-Host "xot-rotate: key #$activeIdx -> #$idx (of $N)" -ForegroundColor Cyan
  } else {
    Write-Host "xot-rotate: active key #$idx (of $N)" -ForegroundColor Gray
  }
}

function Invoke-CoolEntry($fp) {
  Add-CoolEntry $fp
  Write-Host "xot-rotate: cooled key $fp" -ForegroundColor Yellow
}

function Invoke-Status {
  $activeIdx = Get-StateValue "ACTIVE_IDX"
  $rotatedAt = Get-StateValue "ROTATED_AT"
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  Write-Host "ACTIVE_IDX=$activeIdx"
  Write-Host "ROTATED_AT=${rotatedAt}"
  Write-Host "COOL_SECS=$Script:COOL_SECS"
  Write-Host "--- cooling keys ---"
  if (Test-Path $Script:STATE_FILE) {
    $cool = Get-Content $Script:STATE_FILE | Where-Object { $_ -match '^COOL_' }
    foreach ($line in $cool) {
      $parts = $line -split '=', 2
      $ts = [long]$parts[1]
      $remain = $ts - $now
      if ($remain -gt 0) {
        Write-Host ("  {0}: cools in {1}s" -f $parts[0], $remain)
      }
    }
  }
}

# ---- entry point ----
switch ($Command) {
  'pick'   { Invoke-Pick }
  'cool'   { if ($args.Count -lt 1) { Write-Error "usage: xot-rotate.ps1 cool <fingerprint>" } else { Invoke-CoolEntry $args[0] } }
  'status' { Invoke-Status }
}
