#!/usr/bin/env bash
# dsh-haavk-boot — macOS / Linux 一键安装脚本
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/ShawSheepSussiah/dsh-haavk-boot/main/install.sh | bash
#
# 幂等：重复跑只会执行「更新」。

set -euo pipefail

REPO="ShawSheepSussiah/dsh-haavk-boot"
BRANCH="main"
PKG="dsh-haavk-boot"

cyan()  { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok()    { printf '    \033[32mOK\033[0m  %s\n' "$1"; }
warn()  { printf '    \033[33m警告\033[0m %s\n' "$1"; }
err()   { printf '    \033[31m错误\033[0m %s\n' "$1"; }

# ---------- 1. 找 profile ----------
cyan "查找 DSH profile"

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILES_ROOT="$DSH_HOME/profiles"

if [ ! -d "$PROFILES_ROOT" ]; then
  err "找不到 $PROFILES_ROOT"
  echo "    请先安装并打开一次 DeepSeek Harness。"
  exit 1
fi

PROFILE_DIR=""
if [ -f "$PROFILES_ROOT/desktop/package.json" ] && grep -q '"bundles"' "$PROFILES_ROOT/desktop/package.json"; then
  PROFILE_DIR="$PROFILES_ROOT/desktop"
else
  for d in "$PROFILES_ROOT"/*/; do
    [ -f "${d}package.json" ] || continue
    if grep -q '"bundles"' "${d}package.json"; then PROFILE_DIR="${d%/}"; break; fi
  done
fi

if [ -z "$PROFILE_DIR" ]; then
  err "没有找到任何有效的 DSH profile"
  exit 1
fi

PROFILE_NAME="$(basename "$PROFILE_DIR")"
ok "profile: $PROFILE_DIR"

# ---------- 2. 放置插件 ----------
cyan "下载 / 更新插件"

PLUGINS_DIR="$PROFILE_DIR/plugins"
TARGET="$PLUGINS_DIR/$PKG"
mkdir -p "$PLUGINS_DIR"

if command -v git >/dev/null 2>&1; then
  if [ -d "$TARGET/.git" ]; then
    echo "    已存在，执行 git pull…"
    if git -C "$TARGET" fetch --depth 1 origin "$BRANCH" >/dev/null 2>&1 \
       && git -C "$TARGET" reset --hard "origin/$BRANCH" >/dev/null 2>&1; then
      ok "已更新到最新"
    else
      warn "更新失败，保留现有版本"
    fi
  else
    rm -rf "$TARGET"
    if git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$TARGET" >/dev/null 2>&1; then
      ok "已克隆"
    else
      err "git clone 失败。网络访问 GitHub 困难时，请配置代理或改用 README 里的手动方式。"
      exit 1
    fi
  fi
else
  warn "未检测到 git，改用压缩包下载"
  TMPZIP="$(mktemp -t haavk).zip"
  TMPDIRX="$(mktemp -d)"
  if curl -fsSL "https://codeload.github.com/$REPO/zip/refs/heads/$BRANCH" -o "$TMPZIP"; then
    unzip -q "$TMPZIP" -d "$TMPDIRX"
    INNER="$(find "$TMPDIRX" -maxdepth 1 -type d | tail -1)"
    rm -rf "$TARGET"
    mv "$INNER" "$TARGET"
    rm -rf "$TMPZIP" "$TMPDIRX"
    ok "已解压"
  else
    err "下载失败。请配置代理或改用 README 里的手动方式。"
    exit 1
  fi
fi

if [ ! -f "$TARGET/lib/index.js" ]; then
  err "插件文件不完整（缺 lib/index.js），安装中止"
  exit 1
fi

# ---------- 3. 登记到 profile ----------
cyan "登记到 profile/package.json"

PKGJSON="$PROFILE_DIR/package.json"

if grep -q '"dsh-haavk-boot"[[:space:]]*:' "$PKGJSON"; then
  ok "dependencies 已登记"
else
  # 在 "dependencies": { 后插入
  if grep -q '"dependencies"[[:space:]]*:[[:space:]]*{' "$PKGJSON"; then
    python3 - "$PKGJSON" "$PKG" <<'PY'
import re, sys
path, pkg = sys.argv[1], sys.argv[2]
s = open(path, encoding='utf-8').read()
if f'"{pkg}"' not in s:
    s = re.sub(r'("dependencies"\s*:\s*\{)',
               rf'\1\n    "{pkg}": "link:./plugins/{pkg}",',
               s, count=1)
    open(path, 'w', encoding='utf-8').write(s)
PY
    ok "已加入 dependencies"
  else
    warn "package.json 里没有 dependencies 字段，请手动添加："
    echo "    \"$PKG\": \"link:./plugins/$PKG\""
  fi
fi

if grep -qE '"bundles"[[:space:]]*:[[:space:]]*\[[^]]*"dsh-haavk-boot"' "$PKGJSON"; then
  ok "bundles 已登记"
else
  if grep -q '"bundles"[[:space:]]*:[[:space:]]*\[' "$PKGJSON"; then
    python3 - "$PKGJSON" "$PKG" <<'PY'
import re, sys
path, pkg = sys.argv[1], sys.argv[2]
s = open(path, encoding='utf-8').read()
# 必须追加到数组末尾：@deepseek-ai/dsh-base 等框架包要先于插件加载
m = re.search(r'"bundles"\s*:\s*\[', s)
if m:
    start = m.end()
    end = s.index(']', start)
    inner = s[start:end]
    if f'"{pkg}"' not in inner:
        trimmed = inner.rstrip()
        sep = '' if trimmed.endswith(',') else ','
        s = s[:start] + trimmed + sep + f'\n        "{pkg}"\n      ' + s[end:]
        open(path, 'w', encoding='utf-8').write(s)
PY
    ok "已追加到 bundles 末尾"
  else
    warn "package.json 里没有 dsh.profile.bundles，无法自动登记"
  fi
fi

# ---------- 4. 链接 ----------
cyan "安装依赖链接"

LINKED=0
if command -v dsh >/dev/null 2>&1; then
  echo "    用 dsh plugin --profile $PROFILE_NAME install"
  if (cd "$PROFILE_DIR" && dsh plugin --profile "$PROFILE_NAME" install) 2>&1 | sed 's/^/    /'; then
    LINKED=1
  fi
fi

if [ "$LINKED" -eq 0 ] && command -v pnpm >/dev/null 2>&1; then
  echo "    用 pnpm install"
  if (cd "$PROFILE_DIR" && pnpm install) 2>&1 | sed 's/^/    /'; then
    LINKED=1
  fi
fi

if [ "$LINKED" -eq 0 ]; then
  warn "依赖链接命令没跑成功，尝试直接放一份到 node_modules"
  rm -rf "$PROFILE_DIR/node_modules/$PKG"
  mkdir -p "$PROFILE_DIR/node_modules"
  cp -R "$TARGET" "$PROFILE_DIR/node_modules/$PKG"
  ok "已直接复制到 node_modules"
else
  ok "依赖已链接"
fi

# ---------- 5. 完成 ----------
printf '\n'
printf '\033[32m============================================\033[0m\n'
printf '\033[32m  安装完成\033[0m\n'
printf '\033[32m============================================\033[0m\n\n'
echo "  插件目录: $TARGET"
echo "  Profile : $PROFILE_DIR"
printf '\n'
printf '\033[33m  下一步：完全退出 DeepSeek Harness，再重新打开。\033[0m\n'
printf '\033[33m  打开后应看到全屏哈夫克启动屏。\033[0m\n\n'
echo "  如果没出现，看这个日志："
echo "    $DSH_HOME/dsh-haavk-boot/boot.log"
printf '\n'
