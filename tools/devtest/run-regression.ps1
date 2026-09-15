# End-to-end regression: run every mock portal shape through Phase 1 login.
#
# Usage (from project root, needs Electron permission):
#   .\tools\devtest\run-regression.ps1
#
# NOTE: this file is intentionally ASCII-only.
# Windows PowerShell 5.1 reads BOM-less files as ANSI, which corrupts non-ASCII
# text and breaks the script. Keep all Chinese docs in tools\README.md instead.
#
# NOTE: a Node runner would be nicer, but in this environment Node cannot spawn
# child processes with piped stdio (EPERM under the sandbox), so PowerShell must
# launch Electron itself.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$port = 18080
$base = "http://127.0.0.1:$port"

function Set-Variant($v, $forget) {
  Invoke-RestMethod "$base/__variant?v=$v" | Out-Null
  if ($forget) { Invoke-RestMethod "$base/__forget" | Out-Null }
  Start-Sleep -Milliseconds 400
}

function Invoke-Case($label, $adapter, $isp, $expectService) {
  $out = & node_modules\.bin\electron.cmd tools\phase1-login.js `
      --adapter-file "tools\devtest\adapters\$adapter.json" `
      --probes-file tools\devtest\mock-probes.json `
      --user student --pass "correct-horse-9" --isp $isp 2>&1
  $code = $LASTEXITCODE
  $ok = ($out | Select-String -Pattern '^\s+成功: (.+)$').Matches.Groups[1].Value
  $reason = ($out | Select-String -Pattern '^\s+原因: (.+)$').Matches.Groups[1].Value
  $r1 = ($out | Select-String -Pattern '1\) 登录请求完成: (.+)$').Matches.Groups[1].Value
  # 可选步骤有两种日志：自身失败但继续（"可选步骤，继续"）、以及同组后续步骤被带过（"已跳过："）
  $skip = ($out | Select-String -Pattern '可选步骤，继续|已跳过：' | Measure-Object).Count

  $svc = '-'
  try {
    $state = Invoke-RestMethod "$base/__state"
    if ($state.lastService) { $svc = $state.lastService }
  } catch { }

  $verdict = if ($code -eq 0) { 'PASS' } else { 'FAIL' }
  if ($expectService -and $svc -ne $expectService) { $verdict = 'FAIL' }

  [pscustomobject]@{
    Case    = $label
    Result  = $verdict
    Ok      = $ok
    Crit1   = $r1
    Skipped = $skip
    Exit    = $code
    Service = $svc
    Reason  = $reason
  }
}

$results = @()

# generic shapes
foreach ($v in @('srun', 'iframe', 'radio', 'spa', 'simple')) {
  Set-Variant $v $true
  $results += Invoke-Case "$v" $v '中国移动' $null
}

# real topology: CAS SSO only, no service page
Set-Variant 'yzu' $true
$results += Invoke-Case 'yzu-sso-only' 'yzu' '中国联通' $null

# real topology + service page with <select>, explicit selector
Set-Variant 'yzusvc' $true
$results += Invoke-Case 'yzu-service-select-explicit' 'yzu-2step' '中国联通' 'unicom'

# real topology + service page with <select>, heuristic detection
Set-Variant 'yzusvc' $true
$results += Invoke-Case 'yzu-service-select-heuristic' 'yzu-heuristic' '中国联通' 'unicom'

# real topology + service page with radio buttons, heuristic detection
Set-Variant 'yzusvcradio' $true
$results += Invoke-Case 'yzu-service-radio-heuristic' 'yzu-heuristic' '中国联通' 'unicom'

# pick a different carrier
Set-Variant 'yzusvc' $true
$results += Invoke-Case 'yzu-service-pick-telecom' 'yzu-heuristic' '中国电信' 'telecom'

# service page does NOT appear (portal remembered the previous choice)
Set-Variant 'yzusvc' $false
$results += Invoke-Case 'yzu-service-page-absent' 'yzu-heuristic' '中国联通' $null

$results | Format-Table -AutoSize -Wrap

$failed = ($results | Where-Object { $_.Result -ne 'PASS' }).Count
Write-Host ''
if ($failed -eq 0) {
  Write-Host "ALL $($results.Count) CASES PASSED" -ForegroundColor Green
} else {
  Write-Host "$failed CASE(S) FAILED" -ForegroundColor Red
}
exit $failed
