# dsh-haavk-boot — Windows 一键安装脚本
#
# 用法（PowerShell 里粘贴这一行）：
#   irm https://raw.githubusercontent.com/ShawSheepSussiah/dsh-haavk-boot/main/install.ps1 | iex
#
# 做什么：
#   1. 找到 DSH profile 目录
#   2. 把插件放（或更新）到 <profile>/plugins/dsh-haavk-boot
#   3. 自动往 package.json 的 dependencies 和 dsh.profile.bundles 里登记
#   4. 跑 pnpm install 建立链接
#   5. 提示重启 DSH
#
# 幂等：重复跑只会执行「更新」。

# 注意：Windows PowerShell 5.1 在 $ErrorActionPreference='Stop' 时，
# 外部命令（git / pnpm）往 stderr 写任何东西都会被当成终止错误。
# 这里保持 Continue，成败一律用 $LASTEXITCODE 判断。
$ErrorActionPreference = 'Continue'

$Repo   = 'ShawSheepSussiah/dsh-haavk-boot'
$Branch = 'main'
$Pkg    = 'dsh-haavk-boot'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK   $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    警告 $msg" -ForegroundColor Yellow }
function Write-Err2($msg) { Write-Host "    错误 $msg" -ForegroundColor Red }

# ---------- 1. 找 profile ----------
Write-Step '查找 DSH profile'

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profilesRoot = Join-Path $dshHome 'profiles'

if (-not (Test-Path $profilesRoot)) {
  Write-Err2 "找不到 $profilesRoot"
  Write-Host '    请先安装并打开一次 DeepSeek Harness。'
  exit 1
}

$candidates = @()
foreach ($d in Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue) {
  $pj = Join-Path $d.FullName 'package.json'
  if (Test-Path $pj) {
    $raw = Get-Content $pj -Raw -Encoding UTF8
    if ($raw -match '"bundles"') { $candidates += $d.FullName }
  }
}

if ($candidates.Count -eq 0) {
  Write-Err2 '没有找到任何有效的 DSH profile（package.json 里缺 dsh.profile.bundles）'
  exit 1
}

$profileDir = $candidates | Where-Object { $_ -match '\\desktop$' } | Select-Object -First 1
if (-not $profileDir) { $profileDir = $candidates[0] }
$profileName = Split-Path $profileDir -Leaf

Write-Ok "profile: $profileDir"

# ---------- 2. 放置插件 ----------
Write-Step '下载 / 更新插件'

$pluginsDir = Join-Path $profileDir 'plugins'
$target     = Join-Path $pluginsDir $Pkg

if (-not (Test-Path $pluginsDir)) { New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null }

$git = Get-Command git -ErrorAction SilentlyContinue
$gotIt = $false

if ($git) {
  if (Test-Path (Join-Path $target '.git')) {
    Write-Host '    已存在，执行 git pull…'
    Push-Location $target
    & git fetch --depth 1 origin $Branch *> $null
    $fetchCode = $LASTEXITCODE
    if ($fetchCode -eq 0) {
      & git reset --hard "origin/$Branch" *> $null
      if ($LASTEXITCODE -eq 0) { $gotIt = $true; Write-Ok '已更新到最新' }
    }
    Pop-Location
    if (-not $gotIt) { Write-Warn2 '更新失败，保留现有版本' ; $gotIt = $true }
  } else {
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    & git clone --depth 1 --branch $Branch "https://github.com/$Repo.git" $target *> $null
    if ($LASTEXITCODE -eq 0) { $gotIt = $true; Write-Ok '已克隆' }
  }
}

if (-not $gotIt) {
  Write-Warn2 'git 不可用或克隆失败，改用压缩包下载'

  $zip = Join-Path $env:TEMP "$Pkg-$([guid]::NewGuid().ToString('N')).zip"
  $url = "https://codeload.github.com/$Repo/zip/refs/heads/$Branch"
  $dl = $false
  try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 180
    $dl = $true
  } catch {
    Write-Err2 "下载失败：$($_.Exception.Message)"
  }

  if ($dl) {
    $ext = Join-Path $env:TEMP "$Pkg-extract-$([guid]::NewGuid().ToString('N'))"
    try {
      Expand-Archive -Path $zip -DestinationPath $ext -Force -ErrorAction Stop
      $inner = Get-ChildItem $ext -Directory | Select-Object -First 1
      if (Test-Path $target) { Remove-Item $target -Recurse -Force }
      Move-Item $inner.FullName $target
      $gotIt = $true
      Write-Ok '已解压'
    } catch {
      Write-Err2 "解压失败：$($_.Exception.Message)"
    }
    Remove-Item $zip, $ext -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if (-not $gotIt) {
  Write-Host ''
  Write-Err2 '插件下载失败，安装中止。'
  Write-Host '    常见原因：网络访问 GitHub 受限。' -ForegroundColor Gray
  Write-Host '    解决办法：开代理后重跑，或用 README 里的手动安装方式。' -ForegroundColor Gray
  exit 1
}

if (-not (Test-Path (Join-Path $target 'lib\index.js'))) {
  Write-Err2 '插件文件不完整（缺 lib/index.js），安装中止'
  exit 1
}

# ---------- 3. 登记到 profile ----------
Write-Step '登记到 profile/package.json'

$pkgPath = Join-Path $profileDir 'package.json'
$json    = Get-Content $pkgPath -Raw -Encoding UTF8
$changed = $false
$pkgForJson = '"' + $Pkg + '"'

# 3a. dependencies
if ($json -match [regex]::Escape($pkgForJson) + '\s*:') {
  Write-Ok 'dependencies 已登记'
} elseif ($json -match '(?s)"dependencies"\s*:\s*\{') {
  $ins = "`r`n    `"$Pkg`": `"link:./plugins/$Pkg`","
  $json = [regex]::Replace($json, '(?s)("dependencies"\s*:\s*\{)', "`$1$ins", 1)
  $changed = $true
  Write-Ok '已加入 dependencies'
} else {
  $ins = "`r`n  `"dependencies`": {`r`n    `"$Pkg`": `"link:./plugins/$Pkg`"`r`n  },"
  $json = [regex]::Replace($json, '(?s)(\{\s*\r?\n)', "`$1$ins`r`n", 1)
  $changed = $true
  Write-Ok '已新建 dependencies 并加入'
}

# 3b. bundles —— 必须追加到末尾，不能插到最前。
# 顺序有意义：@deepseek-ai/dsh-base / dsh-web-app 要先于任何插件加载。
if ($json -match '"bundles"\s*:\s*\[[^\]]*"dsh-haavk-boot"') {
  Write-Ok 'bundles 已登记'
} else {
  $bi = $json.IndexOf('"bundles"')
  $lb = if ($bi -ge 0) { $json.IndexOf('[', $bi) } else { -1 }
  $rb = if ($lb -ge 0) { $json.IndexOf(']', $lb) } else { -1 }

  if ($lb -ge 0 -and $rb -gt $lb) {
    $inner = $json.Substring($lb + 1, $rb - $lb - 1)
    $trim  = $inner.TrimEnd()
    $sep   = if ($trim.EndsWith(',')) { '' } else { ',' }
    $ins   = $trim + $sep + "`r`n        `"$Pkg`"`r`n      "
    $json  = $json.Substring(0, $lb + 1) + $ins + $json.Substring($rb)
    $changed = $true
    Write-Ok '已追加到 bundles 末尾'
  } else {
    Write-Warn2 'package.json 里没有 dsh.profile.bundles，无法自动登记'
    Write-Host '    请按 README 手动添加。'
  }
}

if ($changed) {
  Copy-Item $pkgPath "$pkgPath.bak-haavk" -Force -ErrorAction SilentlyContinue
  [IO.File]::WriteAllText($pkgPath, $json, (New-Object Text.UTF8Encoding($false)))
  Write-Ok 'package.json 已写入（备份：package.json.bak-haavk）'
}

# ---------- 4. 链接 ----------
Write-Step '安装依赖链接'

$dsh = Get-Command dsh -ErrorAction SilentlyContinue
$linked = $false

if ($dsh) {
  Write-Host "    用 dsh plugin --profile $profileName install"
  Push-Location $profileDir
  & $dsh.Source plugin --profile $profileName install *> $null
  if ($LASTEXITCODE -eq 0) { $linked = $true }
  Pop-Location
}

if (-not $linked) {
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($pnpm) {
    Write-Host '    用 pnpm install'
    Push-Location $profileDir
    & $pnpm.Source install *> $null
    if ($LASTEXITCODE -eq 0) { $linked = $true }
    Pop-Location
  }
}

$nm = Join-Path $profileDir "node_modules\$Pkg"
if ($linked -and (Test-Path $nm)) {
  Write-Ok '依赖已链接'
} else {
  Write-Warn2 '依赖链接未成功，直接复制一份到 node_modules'
  if (Test-Path $nm) { Remove-Item $nm -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Path (Join-Path $profileDir 'node_modules') -Force | Out-Null
  Copy-Item $target $nm -Recurse -Force
  Write-Ok '已直接复制到 node_modules'
}

# ---------- 5. 完成 ----------
Write-Host ''
Write-Host '============================================' -ForegroundColor Green
Write-Host '  安装完成' -ForegroundColor Green
Write-Host '============================================' -ForegroundColor Green
Write-Host ''
Write-Host "  插件目录: $target"
Write-Host "  Profile : $profileDir"
Write-Host ''
Write-Host '  下一步：完全退出 DeepSeek Harness（托盘也退），再重新打开。' -ForegroundColor Yellow
Write-Host '  打开后应看到全屏哈夫克启动屏。' -ForegroundColor Yellow
Write-Host ''
Write-Host '  如果没出现，看这个日志：' -ForegroundColor Gray
Write-Host "    $(Join-Path $dshHome 'dsh-haavk-boot')\boot.log" -ForegroundColor Gray
Write-Host ''
