<#
.SYNOPSIS
    dsh-next-step-suggest 一键自检：宿主路由、客户端注册状态、诊断日志。
.USAGE
    powershell -ExecutionPolicy Bypass -File scripts\check.ps1
.NOTES
    需 DSH 正在运行（127.0.0.1:19387）。插件更新后需重启 DSH 才生效。
#>
$ErrorActionPreference = "SilentlyContinue"
$base = "http://127.0.0.1:19387"

Write-Host "=== 1) 宿主路由存活（期望 400 = 已注册）==="
try {
    $r = Invoke-WebRequest -Uri "$base/api/dsh-next-step-suggest" -Method POST -ContentType "application/json" -Body '{}' -UseBasicParsing -TimeoutSec 10
    Write-Host "  status=$($r.StatusCode) body=$($r.Content)"
} catch {
    $resp = $_.Exception.Response
    if ($resp) { Write-Host "  status=$([int]$resp.StatusCode) body=$((New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd())" }
    else { Write-Host "  无法连接 DSH：$($_.Exception.Message)" }
}

Write-Host "=== 2) 客户端注册状态（GET /status）==="
try {
    $r = Invoke-WebRequest -Uri "$base/api/dsh-next-step-suggest/status" -UseBasicParsing -TimeoutSec 10
    Write-Host "  $($r.Content)"
} catch {
    $resp = $_.Exception.Response
    if ($resp) { Write-Host "  status=$([int]$resp.StatusCode) —— 404 表示宿主还是旧版本（未含 status 路由），请重启 DSH" }
    else { Write-Host "  无法连接 DSH：$($_.Exception.Message)" }
}

Write-Host "=== 3) 诊断日志（宿主侧文件直读）==="
$log = Join-Path $env:USERPROFILE ".dsh\next-step-suggest-diag.log"
if (Test-Path $log) {
    Get-Content $log -Tail 30 | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Host "  （$log 不存在：浏览器半边尚未上报过任何事件）"
}
