<#
.SYNOPSIS
    把本仓库同步到 DSH profile 的插件位置（默认 desktop profile）。

.DESCRIPTION
    代码目录（lib/、scripts/）在 profile 侧是 junction，改动即时生效，
    无需本脚本。本脚本负责：
      1. 校验 junction 是否健康（断了就重建）；
      2. 对齐剩余静态文件（package.json / README.md / LICENSE /
         cordis.patch.yml）—— 文件级 symlink 在 Windows 需要管理员或
         开发者模式，硬链接又不能跨卷，所以这几个文件只能复制。

    可重复运行，幂等。

.EXAMPLE
    pwsh -File scripts\sync-to-profile.ps1
    pwsh -File scripts\sync-to-profile.ps1 -Profile web
#>
[CmdletBinding()]
param(
    # profile 名（~/.dsh/profiles/<name>）
    [string]$Profile = "desktop",
    # 只报告不写入
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$work = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
$target = Join-Path $profileDir "local-plugins\dsh-next-step-suggest"

if (-not (Test-Path $target)) {
    throw "目标不存在：$target`n请先按 README 的「本地开发安装」把插件装到该 profile。"
}

Write-Host "工作目录 : $work"
Write-Host "目标     : $target"
Write-Host ""

# ── 1) junction 健康检查 ─────────────────────────────────────
$linked = @("lib", "scripts")
$broken = @()
foreach ($name in $linked) {
    $p = Join-Path $target $name
    $item = Get-Item $p -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) {
        $broken += $name
        Write-Host "[缺失] $name"
        continue
    }
    if ($item.LinkType -ne "Junction") {
        $broken += $name
        Write-Host "[非链接] $name（当前为实体目录，需改为 junction）"
        continue
    }
    $want = Join-Path $work $name
    if ($item.Target -ne $want) {
        $broken += $name
        Write-Host "[指向错误] $name -> $($item.Target)（应为 $want）"
        continue
    }
    Write-Host "[OK] $name -> $($item.Target)"
}

if ($broken.Count -gt 0) {
    Write-Host ""
    Write-Host "需要修复的链接：$($broken -join ', ')"
    if ($DryRun) {
        Write-Host "（-DryRun：跳过修复）"
    } else {
        foreach ($name in $broken) {
            $p = Join-Path $target $name
            $src = Join-Path $work $name
            if (-not (Test-Path $src)) { throw "源目录不存在：$src" }

            # 先备份既有实体目录（带时间戳），再建 junction
            if (Test-Path $p) {
                $item = Get-Item $p -Force
                if ($item.LinkType -eq "Junction") {
                    # 断链或指错：删掉链接本身（不影响其目标）
                    cmd /c rmdir "`"$p`"" | Out-Null
                } else {
                    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
                    $bakRoot = Join-Path $env:USERPROFILE ".dsh\_plugin-backups"
                    New-Item -ItemType Directory -Force -Path $bakRoot | Out-Null
                    $bak = Join-Path $bakRoot "$name-$stamp"
                    Move-Item $p $bak
                    Write-Host "  已备份 $name -> $bak"
                }
            }
            cmd /c mklink /J "`"$p`"" "`"$src`"" | Out-Null
            $ok = (Get-Item $p -Force).LinkType -eq "Junction"
            Write-Host "  重建 $name : $(if ($ok) { 'OK' } else { '失败' })"
        }
    }
}

# ── 2) 静态文件对齐 ──────────────────────────────────────────
Write-Host ""
Write-Host "静态文件（文件级 symlink 需管理员，故采用复制对齐）："
$static = @("package.json", "README.md", "LICENSE", "cordis.patch.yml")
$drift = 0
foreach ($f in $static) {
    $src = Join-Path $work $f
    $dst = Join-Path $target $f
    if (-not (Test-Path $src)) { Write-Host "  [跳过] $f（源不存在）"; continue }

    $same = (Test-Path $dst) -and
            ((Get-FileHash $src).Hash -eq (Get-FileHash $dst).Hash)
    if ($same) { Write-Host "  [一致] $f"; continue }

    $drift += 1
    if ($DryRun) {
        Write-Host "  [需同步] $f"
    } else {
        if (Test-Path $dst) {
            $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
            $bakRoot = Join-Path $env:USERPROFILE ".dsh\_plugin-backups"
            New-Item -ItemType Directory -Force -Path $bakRoot | Out-Null
            Copy-Item $dst (Join-Path $bakRoot "$f-$stamp") -Force
        }
        Copy-Item $src $dst -Force
        $ok = (Get-FileHash $src).Hash -eq (Get-FileHash $dst).Hash
        Write-Host "  [已同步] $f $(if ($ok) { 'OK' } else { '校验失败!' })"
    }
}

Write-Host ""
if ($broken.Count -eq 0 -and $drift -eq 0) {
    Write-Host "全部同步完成：代码目录走 junction，静态文件已对齐。"
} elseif ($DryRun) {
    Write-Host "（-DryRun 结束：$($broken.Count) 个链接、$drift 个文件待处理）"
} else {
    Write-Host "同步完成：修复 $($broken.Count) 个链接，对齐 $drift 个文件。"
}
Write-Host ""
Write-Host "注意：lib/ 与 scripts/ 的改动由 DSH 的 HMR 自动生效，无需重启；"
Write-Host "      静态文件（尤其 package.json）改动可能需要重启 DSH 才会重新读取。"
