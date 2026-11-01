/* HAAVK Relink 启动屏运行时（v3）
 *
 * 单一职责：本文件是启动屏 DOM 的唯一来源。
 *   - 自己构建 markup（client.js / tapIndex 只放一个空 <div id="dsh-startup-root">）
 *   - 播放原生开机视频 → 按视频真实时间轴点亮 6 条字幕 → 结束溶解并移除 root
 *   - 标题栏按钮隐身（Windows 原生 overlay）
 *
 * 三条铁律：
 *   1. 只有一个驱动回路。视频可用时用 video.currentTime，失败才整体切到墙钟，
 *      绝不允许两个回路同时改 activeIdx（旧版 v2 就是这个 bug：字幕闪/不亮）。
 *   2. 任何一步失败都必须放行页面，绝不锁死黑屏。
 *   3. 不依赖任何外部脚本的执行顺序，本文件自己幂等。
 *
 * 上层可选注入 window.__DSH_HAAVK_CFG__ = { glowIntensity, audioVolume, audioMuted }
 */
(() => {
  'use strict'

  const ROOT_ID = 'dsh-startup-root'
  const root = document.getElementById(ROOT_ID)
  if (!root) return
  if (window.__DSH_HAAVK_BOOTED__) return
  window.__DSH_HAAVK_BOOTED__ = true

  const CFG = (() => {
    const raw = window.__DSH_HAAVK_CFG__
    const src = raw && typeof raw === 'object' ? raw : {}
    const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d)
    return {
      glowIntensity: Math.min(2, Math.max(0.2, num(src.glowIntensity, 1))),
      audioVolume: Math.min(1, Math.max(0, num(src.audioVolume, 1))),
      audioMuted: src.audioMuted === true,
      visualEnabled: src.visualEnabled !== false,
    }
  })()

  /* 6 条字幕区间（秒，与视频配音严格对齐） */
  const CUES = [
    [0.00, 1.43],
    [1.53, 3.03],
    [3.03, 5.37],
    [5.60, 8.00],
    [8.00, 10.33],
    [10.53, 13.63],
  ]
  const CAPTIONS = [
    '信息与你无限，',
    'Relink 重塑未来。',
    '欢迎使用 Relink 三号体验版。',
    '本设备将持续采集上传您的',
    '生理体征、精神状态相关数据，',
    '请在使用前，检阅并签署用户协议。',
  ]
  /* 视频真实时长（秒）；兜底墙钟也用它，保证进度条一致 */
  const VIDEO_DURATION = 13.72
  /* 视频起播宽限期：超过就整体切墙钟驱动 */
  const START_GRACE_MS = 1600
  /* 最外层兜底：无论如何 17s 后必须放行 */
  const HARD_RELEASE_MS = 17000

  const ASSET = '/plugins/dsh-haavk-boot/asset/boot.mp4'

  /* ── markup（唯一来源） ── */
  const STREAM_LINES = [
    '<b>NEURAL</b> 55ms',
    'SYNC 98.7%',
    'LINK SECURE',
    'NODE-03 ACTIVE',
    'UPLINK STABLE',
    'TELEMETRY ON',
  ]
  const buildMarkup = () =>
    '<video class="haavk-boot" playsinline preload="auto" muted></video>' +
    '<div class="haavk-grade"></div>' +
    '<div class="haavk-sweep"></div>' +
    '<canvas class="haavk-fx"></canvas>' +
    '<div class="haavk-hud" aria-hidden="true">' +
    '<i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i>' +
    '<div class="scanline"></div>' +
    '<div class="stream">' + STREAM_LINES.map((l) => '<span>' + l + '</span>').join('') + '</div>' +
    '<div class="ticks">' + '<i></i>'.repeat(12) + '</div>' +
    '</div>' +
    '<header><span><b>HAAVK</b> &nbsp;//&nbsp; RELINK NODE · SECURE LINK</span>' +
    '<span>NODE-03 · CN UID 0086</span></header>' +
    '<div class="haavk-cast">' +
    CAPTIONS.map((text, i) => '<p id="haavk-c' + (i + 1) + '">' + text + '</p>').join('') +
    '</div>' +
    '<footer><span><b>55 ms</b> &nbsp;·&nbsp; NEURAL SYNC &nbsp;·&nbsp; 天空属于哈夫克</span>' +
    '<span>REAL-TIME TELEMETRY</span></footer>' +
    '<div class="haavk-bar"><i></i></div>'

  if (!root.querySelector('.haavk-boot')) {
    try {
      root.innerHTML = buildMarkup()
    } catch (e) {
      /* 构建失败也要放行，不能留一个空黑屏 */
      try { root.parentNode.removeChild(root) } catch (e2) {}
      return
    }
  }

  const nodes = CUES.map((_, i) => root.querySelector('#haavk-c' + (i + 1)))
  const video = root.querySelector('.haavk-boot')
  const bar = root.querySelector('.haavk-bar i')

  /* ── 锁滚动 & 辉光强度 ── */
  try { document.documentElement.classList.add('dsu-lock') } catch (e) {}
  try { document.documentElement.classList.add('haavk-offset') } catch (e) {}
  try { root.style.setProperty('--haavk-glow', String(CFG.glowIntensity)) } catch (e) {}

  /* ------------------------------------------------------------------ *
   * 驱动回路：唯一一个
   * ------------------------------------------------------------------ */
  let finished = false
  let driver = null          /* 'video' | 'clock' */
  let clockStart = 0
  let rafId = 0
  let activeIdx = -1
  let hardTimer = 0
  let graceTimer = 0

  function release() {
    if (finished) return
    finished = true
    try { if (rafId) cancelAnimationFrame(rafId) } catch (e) {}
    rafId = 0
    try { if (hardTimer) clearTimeout(hardTimer) } catch (e) {}
    try { if (graceTimer) clearTimeout(graceTimer) } catch (e) {}
    hardTimer = 0
    graceTimer = 0
    try { if (video && !video.paused) video.pause() } catch (e) {}
    restoreTitlebar()
    try {
      root.classList.add('haavk-out')
      setTimeout(() => {
        try {
          if (root.parentNode) root.parentNode.removeChild(root)
          const de = document.documentElement
          de.classList.remove('dsu-lock')
          de.classList.remove('haavk-offset')
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

  hardTimer = setTimeout(release, HARD_RELEASE_MS)

  function elapsed() {
    if (driver === 'video' && video && isFinite(video.currentTime)) return video.currentTime
    return (Date.now() - clockStart) / 1000
  }

  function duration() {
    if (driver === 'video' && video && isFinite(video.duration) && video.duration > 1) return video.duration
    return VIDEO_DURATION
  }

  function paint(t) {
    let idx = -1
    for (let i = 0; i < CUES.length; i++) {
      if (t >= CUES[i][0] && t < CUES[i][1]) { idx = i; break }
    }
    if (idx !== activeIdx) {
      if (activeIdx >= 0 && nodes[activeIdx]) nodes[activeIdx].classList.remove('on')
      if (idx >= 0 && nodes[idx]) nodes[idx].classList.add('on')
      activeIdx = idx
    }
    if (bar) {
      const d = duration()
      const pct = d > 0 ? Math.min(100, Math.max(0, (t / d) * 100)) : 0
      bar.style.width = pct.toFixed(2) + '%'
    }
  }

  function loop() {
    if (finished) return
    paint(elapsed())
    rafId = requestAnimationFrame(loop)
  }

  function useVideo() {
    if (finished || driver === 'video') return
    driver = 'video'
    try { if (graceTimer) clearTimeout(graceTimer) } catch (e) {}
    graceTimer = 0
    if (!rafId) rafId = requestAnimationFrame(loop)
  }

  function useClock() {
    if (finished || driver === 'clock') return
    driver = 'clock'
    clockStart = Date.now()
    try { if (graceTimer) clearTimeout(graceTimer) } catch (e) {}
    graceTimer = 0
    if (!rafId) rafId = requestAnimationFrame(loop)
  }

  /* ------------------------------------------------------------------ *
   * 视频：静音起播（必然允许）→ 立刻取消静音；失败整体切墙钟
   * ------------------------------------------------------------------ */
  if (video) {
    try { video.setAttribute('src', ASSET) } catch (e) {}
    video.muted = true
    video.playsInline = true
    try { video.volume = CFG.audioMuted ? 0 : CFG.audioVolume } catch (e) {}

    const unmute = () => {
      if (finished) return
      if (CFG.audioMuted) { try { video.volume = 0 } catch (e) {} ; return }
      try {
        video.muted = false
        video.volume = CFG.audioVolume
      } catch (e) {}
    }

    const start = () => {
      if (finished) return
      let p
      try { p = video.play() } catch (e) { useClock(); return }
      if (p && typeof p.then === 'function') {
        p.then(() => {
          if (finished) return
          useVideo()
          setTimeout(unmute, 60)
        }).catch(() => {
          /* 带声起播被拒：保持静音再试一次，仍失败则走墙钟 */
          try {
            video.muted = true
            const p2 = video.play()
            if (p2 && typeof p2.then === 'function') {
              p2.then(() => {
                if (finished) return
                useVideo()
                setTimeout(unmute, 60)
              }).catch(() => { useClock() })
            } else {
              useVideo()
            }
          } catch (e) { useClock() }
        })
      } else {
        useVideo()
        setTimeout(unmute, 60)
      }
    }

    if (video.readyState >= 2) start()
    else video.addEventListener('loadeddata', start, { once: true })

    video.addEventListener('ended', release, { once: true })
    video.addEventListener('error', () => useClock(), { once: true })

    /* 用户任何一次点击也能恢复声音（自动播放策略兜底） */
    try {
      const once = () => { unmute() }
      window.addEventListener('pointerdown', once, { once: true })
    } catch (e) {}

    /* 宽限期到点还没起播 → 切墙钟，不再等视频 */
    graceTimer = setTimeout(() => {
      if (finished) return
      const started = !video.paused && video.currentTime > 0
      if (!started) useClock()
    }, START_GRACE_MS)
  } else {
    useClock()
  }

  if (!driver) driver = 'clock'
  if (driver === 'clock' && !clockStart) clockStart = Date.now()
  if (!rafId) rafId = requestAnimationFrame(loop)

  /* ------------------------------------------------------------------ *
   * 标题栏隐身（Windows 原生 overlay）
   * ------------------------------------------------------------------ */
  let savedProbeCss = null
  let tbHidden = false
  let tbRetryTimer = 0

  function pokeTitlebar() {
    try {
      const body = document.body
      if (!body) return
      /* 只有 body 的 style 属性变化在 preload 的 attributeFilter 里 */
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
       * 必须写在 body 内联样式里才压得过（写 html 无效）。 */
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
        if (!tbHidden || finished || tries > 12) return
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
        tbRetryTimer = setTimeout(retry, 150)
      }
      tbRetryTimer = setTimeout(retry, 150)
    } catch (e) {}
  }

  function restoreTitlebar() {
    if (!tbHidden) return
    tbHidden = false
    try { if (tbRetryTimer) clearTimeout(tbRetryTimer) } catch (e) {}
    tbRetryTimer = 0
    try {
      const body = document.body
      const de = document.documentElement
      if (body) {
        body.style.removeProperty('--dsw-specific-sidebar-fill')
        body.style.removeProperty('--dsw-alias-label-primary')
        body.style.removeProperty('--haavk-tb-poke')
      }
      de.style.removeProperty('--dsw-specific-sidebar-fill')
      de.style.removeProperty('--dsw-alias-label-primary')
      const probe = findCaptionProbe()
      if (probe && savedProbeCss !== null) {
        try { probe.setAttribute('style', savedProbeCss) } catch (e) {}
      }
      pokeTitlebar()
    } catch (e) {}
  }

  hideTitlebar()

  /* ------------------------------------------------------------------ *
   * 粒子层：星尘
   * ------------------------------------------------------------------ */
  function startParticles() {
    if (!CFG.visualEnabled) return
    const cv = root.querySelector('.haavk-fx')
    if (!cv) return
    let g = null
    try { g = cv.getContext('2d') } catch (e) { return }
    if (!g) return

    const reduce = (() => {
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch (e) { return false }
    })()

    let W = 0
    let H = 0
    const DPR = Math.min(2, window.devicePixelRatio || 1)

    function fit() {
      W = window.innerWidth
      H = window.innerHeight
      cv.width = Math.max(1, Math.floor(W * DPR))
      cv.height = Math.max(1, Math.floor(H * DPR))
      g.setTransform(DPR, 0, 0, DPR, 0, 0)
    }
    fit()
    try { window.addEventListener('resize', fit) } catch (e) {}

    const rnd = (a, b) => a + Math.random() * (b - a)
    const COUNT = reduce ? 80 : 220
    const stars = Array.from({ length: COUNT }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: rnd(0.4, 1.5),
      a: rnd(0.15, 0.7),
      vy: rnd(-0.01, -0.003),
      vx: rnd(-0.003, 0.003),
      tw: rnd(0.6, 2.2),
      ph: Math.random() * 6.28,
    }))

    const t0 = performance.now()
    function frame(now) {
      if (finished) return
      const t = (now - t0) / 1000
      g.clearRect(0, 0, W, H)
      g.globalCompositeOperation = 'lighter'
      for (const s of stars) {
        s.x += s.vx * 0.016
        s.y += s.vy * 0.016
        if (s.y < -0.02) { s.y = 1.02; s.x = Math.random() }
        if (s.x < -0.02) s.x = 1.02
        if (s.x > 1.02) s.x = -0.02
        const tw = 0.55 + 0.45 * Math.sin(t * s.tw + s.ph)
        g.fillStyle = 'rgba(214,240,255,' + (s.a * tw * CFG.glowIntensity).toFixed(3) + ')'
        g.beginPath()
        g.arc(s.x * W, s.y * H, s.r, 0, 6.283)
        g.fill()
      }
      g.globalCompositeOperation = 'source-over'
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }
  startParticles()

  try {
    window.addEventListener('beforeunload', () => {
      finished = true
      try { if (rafId) cancelAnimationFrame(rafId) } catch (e) {}
      try { if (hardTimer) clearTimeout(hardTimer) } catch (e) {}
      try { if (graceTimer) clearTimeout(graceTimer) } catch (e) {}
      try { if (tbRetryTimer) clearTimeout(tbRetryTimer) } catch (e) {}
    })
  } catch (e) {}
})()
