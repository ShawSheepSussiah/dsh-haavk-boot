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
$rawJson = Get-Content $pkgPath -Raw -Encoding UTF8
$changed = $false

# 用 JSON 解析而非正则改写，避免破坏结构
$obj = $null
try { $obj = $rawJson | ConvertFrom-Json } catch {
  Write-Err2 'profile/package.json 不是合法 JSON，无法自动登记'
  Write-Host '    请按 README 手动添加。' -ForegroundColor Gray
  $obj = $null
}

if ($obj) {
  # 3a. dependencies
  if (-not $obj.PSObject.Properties['dependencies']) {
    $obj | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  if ($obj.dependencies.PSObject.Properties[$Pkg]) {
    Write-Ok 'dependencies 已登记'
  } else {
    $obj.dependencies | Add-Member -NotePropertyName $Pkg -NotePropertyValue "link:./plugins/$Pkg" -Force
    $changed = $true
    Write-Ok '已加入 dependencies'
  }

  # 3b. bundles —— 必须追加到末尾（顺序即加载顺序）
  $bundles = $null
  if ($obj.dsh -and $obj.dsh.profile -and $obj.dsh.profile.bundles) {
    $bundles = $obj.dsh.profile.bundles
  }
  if ($bundles) {
    if ($bundles -contains $Pkg) {
      Write-Ok 'bundles 已登记'
    } else {
      $obj.dsh.profile.bundles = @($bundles) + $Pkg
      $changed = $true
      Write-Ok '已追加到 bundles 末尾'
    }
  } else {
    Write-Warn2 'package.json 里没有 dsh.profile.bundles，无法自动登记'
    Write-Host '    请按 README 手动添加。' -ForegroundColor Gray
  }

  if ($changed) {
    Copy-Item $pkgPath "$pkgPath.bak-haavk" -Force -ErrorAction SilentlyContinue
    $out = $obj | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($pkgPath, $out, (New-Object Text.UTF8Encoding($false)))
    Write-Ok 'package.json 已写入（备份：package.json.bak-haavk）'
  }
}

# 3d. 用 node 重新格式化为标准缩进（PowerShell 的 ConvertTo-Json 缩进很丑）
$nodeExe = Get-Command node -ErrorAction SilentlyContinue
if ($nodeExe -and (Test-Path $pkgPath)) {
  $tmpJs = Join-Path $env:TEMP ("haavk-fmt-" + [guid]::NewGuid().ToString('N') + ".cjs")
  $fmtLines = @(
    "const fs=require('fs');const p=process.argv[2];"
    "try{const o=JSON.parse(fs.readFileSync(p,'utf8'));"
    "fs.writeFileSync(p,JSON.stringify(o,null,2)+'\n','utf8');}catch(e){}"
  )
  [IO.File]::WriteAllText($tmpJs, ($fmtLines -join ''), (New-Object Text.UTF8Encoding($false)))
  & $nodeExe.Source $tmpJs $pkgPath *> $null
  Remove-Item $tmpJs -Force -ErrorAction SilentlyContinue
}

# 3c. pnpm-workspace.yaml 放行构建脚本
# pnpm 12 默认拦截 git 依赖的 prepare/postinstall，必须显式 allowBuilds
$wsPath = Join-Path $profileDir 'pnpm-workspace.yaml'
$ws = if (Test-Path $wsPath) { Get-Content $wsPath -Raw -Encoding UTF8 } else { "packages:`r`n  - .`r`n" }
if ($ws -notmatch 'dsh-haavk-boot:\s*true') {
  if ($ws -match '(?m)^allowBuilds:\s*$') {
    $ws = [regex]::Replace($ws, '(?m)^(allowBuilds:\s*)$', "`$1`r`n  dsh-haavk-boot: true", 1)
  } elseif ($ws -match '(?m)^allowBuilds:') {
    # allowBuilds 后面直接跟键值，插在它之后
    $ws = [regex]::Replace($ws, '(?m)^(allowBuilds:\r?\n)', "`$1  dsh-haavk-boot: true`r`n", 1)
  } else {
    $ws = $ws.TrimEnd() + "`r`nallowBuilds:`r`n  dsh-haavk-boot: true`r`n"
  }
  [IO.File]::WriteAllText($wsPath, $ws, (New-Object Text.UTF8Encoding($false)))
  Write-Ok 'pnpm-workspace.yaml 已放行构建脚本'
} else {
  Write-Ok 'allowBuilds 已放行'
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
