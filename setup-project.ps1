$ErrorActionPreference = "Stop"

# ============================================================
#  今日开锅 / Daily Wok —— 项目脚手架与自检脚本
#  用法（在项目根目录）：
#    powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-project.ps1
#  作用：
#    1. 补齐缺失的目录；
#    2. 检查关键文件是否齐全；
#    3. 校验 data\dishes.psv 的行数、字段数与分类分布；
#    4. 检查 Node.js 是否可用，并提示下一步命令。
#  说明：本脚本不会覆盖已有文件，可以重复执行。
# ============================================================

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Write-Title($text) {
  Write-Host ""
  Write-Host "== $text ==" -ForegroundColor Cyan
}

function Write-Ok($text)   { Write-Host "  [OK]   $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "  [警告] $text" -ForegroundColor Yellow }
function Write-Bad($text)  { Write-Host "  [缺失] $text" -ForegroundColor Red }

Write-Title "今日开锅 / Daily Wok · 项目自检"
Write-Host "  项目目录：$root"

# ---------- 1. 目录 ----------
Write-Title "1. 目录结构"
$dirs = @("data", "public", "public\data", "scripts", ".github", ".github\workflows")
foreach ($d in $dirs) {
  $path = Join-Path $root $d
  if (Test-Path $path) {
    Write-Ok $d
  } else {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    Write-Host "  [新建] $d" -ForegroundColor Magenta
  }
}

# ---------- 2. 关键文件 ----------
Write-Title "2. 关键文件"
$required = @(
  "package.json",
  "data\categories.json",
  "data\dishes.psv",
  "data\history.json",
  "scripts\generate-daily.mjs",
  "scripts\preview.mjs",
  "public\index.html",
  ".github\workflows\daily-menu.yml"
)

$missing = @()
foreach ($f in $required) {
  if (Test-Path (Join-Path $root $f)) { Write-Ok $f } else { Write-Bad $f; $missing += $f }
}

# ---------- 3. 菜品库校验 ----------
Write-Title "3. 菜品库校验（data\dishes.psv）"
$psvPath = Join-Path $root "data\dishes.psv"
if (Test-Path $psvPath) {
  $lines = @(Get-Content $psvPath -Encoding UTF8 | Where-Object { $_.Trim() -ne "" })
  $dataLines = $lines | Select-Object -Skip 1

  Write-Host ("  总行数：{0}（表头 1 行 + 菜品 {1} 行）" -f $lines.Count, $dataLines.Count)

  $badField = 0
  $counts = @{}
  $ids = @{}

  foreach ($line in $dataLines) {
    $cells = $line.Split("|")
    if ($cells.Count -ne 8) { $badField++ ; continue }
    $id = $cells[0].Trim()
    $cat = $cells[2].Trim()
    if ($ids.ContainsKey($id)) { Write-Warn2 ("重复 id：{0}" -f $id) } else { $ids[$id] = 1 }
    if ($counts.ContainsKey($cat)) { $counts[$cat]++ } else { $counts[$cat] = 1 }
  }

  if ($badField -eq 0) { Write-Ok "每行字段数均为 8" } else { Write-Bad ("有 {0} 行字段数不是 8" -f $badField) }

  foreach ($key in @("meat", "veg", "soup")) {
    $n = 0
    if ($counts.ContainsKey($key)) { $n = $counts[$key] }
    if ($n -ge 30) { Write-Ok ("分类 {0}：{1} 道" -f $key, $n) } else { Write-Warn2 ("分类 {0}：{1} 道（不足 30 道，去重周期会变短）" -f $key, $n) }
  }

  if ($dataLines.Count -ne 90) { Write-Warn2 ("菜品总数为 {0} 道，设计目标是 90 道" -f $dataLines.Count) }
} else {
  Write-Bad "data\dishes.psv 不存在，无法校验菜品库"
}

# ---------- 4. 历史记录 ----------
Write-Title "4. 推荐历史（data\history.json）"
$historyPath = Join-Path $root "data\history.json"
if (Test-Path $historyPath) {
  try {
    $history = Get-Content $historyPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $days = 0
    if ($null -ne $history.days) { $days = @($history.days).Count }
    Write-Ok ("JSON 可解析；已记录 {0} 天，去重窗口 {1} 天" -f $days, $history.windowDays)
  } catch {
    Write-Bad ("history.json JSON 解析失败：{0}" -f $_.Exception.Message)
  }
} else {
  Write-Bad "data\history.json 不存在"
}

# ---------- 5. Node.js ----------
Write-Title "5. 运行环境"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $nodeVersion = (& node --version).Trim()
  Write-Ok ("Node.js {0}" -f $nodeVersion)
} else {
  Write-Warn2 "未在 PATH 中找到 node，本地生成需要 Node.js 20 或更高版本"
  Write-Host "         GitHub Actions 里由 actions/setup-node 自动安装，不影响线上运行。" -ForegroundColor DarkGray
}

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) {
  $gitVersion = (& git --version).Trim()
  Write-Ok $gitVersion
  $branch = (& git rev-parse --abbrev-ref HEAD 2>$null)
  if ($LASTEXITCODE -eq 0) { Write-Host ("         当前分支：{0}" -f $branch) -ForegroundColor DarkGray }
} else {
  Write-Warn2 "未找到 git，推送 GitHub 前需要安装"
}

# ---------- 6. 下一步 ----------
Write-Title "6. 下一步"
if ($missing.Count -gt 0) {
  Write-Host "  先补齐上面标红的文件，再执行：" -ForegroundColor Yellow
} else {
  Write-Host "  文件齐全，可以执行：" -ForegroundColor Yellow
}
Write-Host "    npm run generate     # 生成 public\data\today.json"
Write-Host "    npm run preview      # 本地预览 http://127.0.0.1:8000"
Write-Host "    git init && git add . && git commit -m `"chore: 初始化今日开锅`""
Write-Host ""
