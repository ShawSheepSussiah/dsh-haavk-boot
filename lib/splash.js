/* HAAVK Relink 启动屏运行时（v2 · 6 段字幕）
 * 由 Host 通过 tapIndex 注入 index.html。
 * 职责：播放原生开机视频 → 按视频真实时间轴点亮 6 条字幕 → 视频结束后溶解并移除 root、解锁滚动。
 * 任何一步失败都必须放行页面（绝不锁死黑屏）。 */
(() => {
  const ROOT = 'dsh-startup-root'
  const root = document.getElementById(ROOT)
  if (!root) return
  if (window.__DSH_HAAVK_BOOTED__) return
  window.__DSH_HAAVK_BOOTED__ = true

  const FALLBACK_MS = 15000   /* 视频若始终不开始，15s 后放行 */
  let finished = false

  /* 6 条字幕区间（秒，与配音严格对齐） */
  const CUES = [
    [0.00, 1.43],
    [1.53, 3.03],
    [3.03, 5.37],
    [5.60, 8.00],
    [8.00, 10.33],
    [10.53, 13.63],
  ]
  const nodes = CUES.map((_, i) => root.querySelector('#haavk-c' + (i + 1)))

  function release() {
    if (finished) return
    finished = true
    restoreTitlebar()
    try {
      root.classList.add('haavk-out')
      setTimeout(() => {
        try {
          if (root.parentNode) root.parentNode.removeChild(root)
          document.documentElement.classList.remove('dsu-lock')
          document.documentElement.classList.remove('haavk-offset')
          if (document.body) document.body.style.overflow = ''
        } catch (e) { /* 放行失败也不再抛 */ }
      }, 900)
    } catch (e) {
      try {
        if (root.parentNode) root.parentNode.removeChild(root)
        document.documentElement.classList.remove('dsu-lock')
      } catch (e2) { /* ignore */ }
    }
  }

  const guard = setTimeout(release, FALLBACK_MS)

  /* 若无法全屏（fullscreenable:false），顶栏避让原生标题栏 */
  try { document.documentElement.classList.add('haavk-offset') } catch (e) {}

  /* ── 隐藏 Windows 原生标题栏的三个按钮（最小化/最大化/关闭）──
   *
   * 桌面端 preload 会插入一个隐藏探针，读取它的计算色再走 IPC：
   *   probe.style.cssText = "...background-color:var(--dsw-specific-sidebar-fill);
   *                           color:var(--dsw-alias-label-primary)"
   *   getComputedStyle(probe) → ipcRenderer.send('dsh-desktop:windows-appearance', ...)
   *   → mainWindow.setTitleBarOverlay({ color, symbolColor })
   *
   * 只改 CSS 变量不可靠（主题的作用域可能压过 :root 内联值），
   * 因此直接找到那个探针 span，把它的内联色改成全透明，再 poke 一下
   * 触发 preload 的 MutationObserver 重发 IPC。 */
  let savedProbeCss = null
  let tbHidden = false

  function pokeTitlebar() {
    try {
      const body = document.body
      if (!body) return
      /* body 的 style 属性变化才在 preload 的 attributeFilter 里 */
      body.style.setProperty('--haavk-tb-poke', String(Date.now()))
    } catch (e) {}
  }

  function findCaptionProbe() {
    try {
      const body = document.body
      if (!body || !body.children) return null
      for (const el of body.children) {
        if (!el || el.tagName !== 'SPAN') continue
        const css = el.getAttribute('style') || ''
        if (css.indexOf('--dsw-specific-sidebar-fill') !== -1) return el
      }
    } catch (e) {}
    return null
  }

  function hideTitlebar() {
    try {
      /* 主题把这两个变量定义在 body / body[data-ds-dark-theme] 上，
       * 所以必须写在 body 的内联样式里才能压过去（写 html 无效）。 */
      const body = document.body
      if (body) {
        try {
          body.style.setProperty('--dsw-specific-sidebar-fill', 'rgba(0, 0, 0, 0)')
          body.style.setProperty('--dsw-alias-label-primary', 'rgba(0, 0, 0, 0)')
        } catch (e) {}
      }
      const de = document.documentElement
      try {
        de.style.setProperty('--dsw-specific-sidebar-fill', 'rgba(0, 0, 0, 0)')
        de.style.setProperty('--dsw-alias-label-primary', 'rgba(0, 0, 0, 0)')
      } catch (e) {}

      /* 主手段：直接改探针元素的内联色 */
      const probe = findCaptionProbe()
      if (probe) {
        savedProbeCss = probe.getAttribute('style')
        try {
          probe.style.backgroundColor = 'rgba(0, 0, 0, 0)'
          probe.style.color = 'rgba(0, 0, 0, 0)'
        } catch (e) {}
      }
      tbHidden = true
      pokeTitlebar()

      /* 探针可能晚于本脚本挂载，补几次 */
      let tries = 0
      const retry = () => {
        if (!tbHidden || tries > 12) return
        tries++
        const p = findCaptionProbe()
        if (p) {
          if (savedProbeCss === null) savedProbeCss = p.getAttribute('style')
          try {
            p.style.backgroundColor = 'rgba(0, 0, 0, 0)'
            p.style.color = 'rgba(0, 0, 0, 0)'
          } catch (e) {}
        }
        pokeTitlebar()
        setTimeout(retry, 150)
      }
      setTimeout(retry, 150)
    } catch (e) {}
  }

  function restoreTitlebar() {
    if (!tbHidden) return
    try {
      const body = document.body
      const de = document.documentElement
      if (body) {
        body.style.removeProperty('--dsw-specific-sidebar-fill')
        body.style.removeProperty('--dsw-alias-label-primary')
      }
      de.style.removeProperty('--dsw-specific-sidebar-fill')
      de.style.removeProperty('--dsw-alias-label-primary')
      const probe = findCaptionProbe()
      if (probe && savedProbeCss !== null) {
        try { probe.setAttribute('style', savedProbeCss) } catch (e) {}
      }
      tbHidden = false
      pokeTitlebar()
    } catch (e) {}
  }

  hideTitlebar()

  const video = root.querySelector('.haavk-boot')
  const bar = root.querySelector('.haavk-bar i')

  /* ---- 字幕驱动：以视频 currentTime 为准 ---- */
  let activeIdx = -1
  function syncCaptions() {
    if (finished) return
    const t = video && isFinite(video.currentTime) ? video.currentTime : 0
    let idx = -1
    for (let i = 0; i < CUES.length; i++) {
      if (t >= CUES[i][0] && t < CUES[i][1]) { idx = i; break }
    }
    if (idx !== activeIdx) {
      if (activeIdx >= 0 && nodes[activeIdx]) nodes[activeIdx].classList.remove('on')
      if (idx >= 0 && nodes[idx]) nodes[idx].classList.add('on')
      activeIdx = idx
    }
  }

  /* ---- 无视频时的兜底：按墙钟时间点亮 ---- */
  let t0 = 0
  function syncByClock() {
    if (finished) return
    const t = (Date.now() - t0) / 1000
    let idx = -1
    for (let i = 0; i < CUES.length; i++) {
      if (t >= CUES[i][0] && t < CUES[i][1]) { idx = i; break }
    }
    if (idx !== activeIdx) {
      if (activeIdx >= 0 && nodes[activeIdx]) nodes[activeIdx].classList.remove('on')
      if (idx >= 0 && nodes[idx]) nodes[idx].classList.add('on')
      activeIdx = idx
    }
    if (bar) bar.style.width = Math.min(100, (t / 13.72) * 100).toFixed(2) + '%'
    if (t < 13.72) requestAnimationFrame(syncByClock)
  }

  function tick() {
    if (finished) return
    syncCaptions()
    if (video && video.duration && isFinite(video.duration)) {
      if (bar) bar.style.width = Math.min(100, (video.currentTime / video.duration) * 100).toFixed(2) + '%'
    }
    requestAnimationFrame(tick)
  }

  if (video) {
    /* 自动播放策略：先静音起播（必然允许），起播后立刻取消静音拿回声音 */
    video.muted = true
    video.playsInline = true
    try { video.volume = 1 } catch (e) {}
    const unmute = () => {
      try {
        video.muted = false
        video.volume = 1
      } catch (e) {}
    }
    const start = () => {
      const p = video.play()
      if (p && p.then) {
        p.then(() => { setTimeout(unmute, 60) }).catch(() => {
          try { video.muted = true; video.play().catch(() => {}) } catch (e) {}
        })
      } else {
        setTimeout(unmute, 60)
      }
    }
    if (video.readyState >= 2) start()
    else video.addEventListener('loadeddata', start, { once: true })
    /* 用户任何一次点击也能恢复声音 */
    const once = () => { unmute(); window.removeEventListener('pointerdown', once) }
    window.addEventListener('pointerdown', once, { once: true })
    video.addEventListener('ended', release, { once: true })
    video.addEventListener('error', () => {
      /* 视频拿不到：改用墙钟驱动，不锁死 */
      t0 = Date.now()
      requestAnimationFrame(syncByClock)
      setTimeout(release, 13800)
    }, { once: true })
    requestAnimationFrame(tick)
    /* 若视频 1.2s 内仍未开始，切墙钟兜底 */
    setTimeout(() => {
      if (finished) return
      if (!video || video.paused || video.currentTime === 0) {
        t0 = Date.now()
        requestAnimationFrame(syncByClock)
        setTimeout(release, 13800)
      }
    }, 1200)
  } else {
    t0 = Date.now()
    requestAnimationFrame(syncByClock)
    setTimeout(release, 13800)
  }

  /* ── 粒子层：星尘 + 绕标光尘 ── */
  const cv = root.querySelector('.haavk-fx')
  if (!cv) return
  const g = cv.getContext('2d')
  if (!g) return

  let W = 0, H = 0, DPR = Math.min(2, window.devicePixelRatio || 1)
  function fit() {
    W = window.innerWidth; H = window.innerHeight
    cv.width = W * DPR; cv.height = H * DPR
    g.setTransform(DPR, 0, 0, DPR, 0, 0)
  }
  fit()
  window.addEventListener('resize', fit)

  const rnd = (a, b) => a + Math.random() * (b - a)
  const STARS = Array.from({ length: 220 }, () => ({
    x: Math.random(), y: Math.random(), r: rnd(0.4, 1.5), a: rnd(0.15, 0.7),
    vy: rnd(-0.01, -0.003), vx: rnd(-0.003, 0.003), tw: rnd(0.6, 2.2), ph: Math.random() * 6.28,
  }))

  const tStart = performance.now()
  function frame(now) {
    if (finished) return
    const t = (now - tStart) / 1000
    g.clearRect(0, 0, W, H)
    g.globalCompositeOperation = 'lighter'
    for (const s of STARS) {
      s.x += s.vx * 0.016; s.y += s.vy * 0.016
      if (s.y < -0.02) { s.y = 1.02; s.x = Math.random() }
      if (s.x < -0.02) s.x = 1.02
      if (s.x > 1.02) s.x = -0.02
      const tw = 0.55 + 0.45 * Math.sin(t * s.tw + s.ph)
      g.fillStyle = 'rgba(214,240,255,' + (s.a * tw).toFixed(3) + ')'
      g.beginPath(); g.arc(s.x * W, s.y * H, s.r, 0, 6.283); g.fill()
    }
    g.globalCompositeOperation = 'source-over'
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  window.addEventListener('beforeunload', () => {
    clearTimeout(guard)
    finished = true
  })
})()
