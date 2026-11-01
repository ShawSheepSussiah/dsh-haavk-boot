/* dsh-haavk-boot — Web 客户端
 *
 * 桌面端 dsh-app://app/index.html 直接读 dist，不经过 Host 的 renderIndex/tapIndex，
 * 所以启动屏必须由本模块自举：自己往 DOM 插入 root、挂 CSS、加载运行时。
 * 资源地址 /plugins/dsh-haavk-boot/* 会被桌面协议层转发给 Host（已验证 200）。
 *
 * 关键：本文件顶层只允许出现 window.__ModuleLoader__.load(...) 一条语句，
 * 其余全部包在 factory 内，否则会和其它插件在同一脚本作用域撞名 → 整个 WebUI 白屏。
 *
 * 注意：load 的 id 必须是 package.json 的完整包名（含 scope）。
 * Host 的 client-modules 用包名匹配注册项；id 不带 scope 会导致
 * "duplicate factory registration" 并把整条 boot entry 卡死（应用无法启动）。
 */
window.__ModuleLoader__.load({
  id: '@shawsheepsussiah/dsh-haavk-boot',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    let React
    try { React = require('react') } catch (e) { React = undefined }

    const PKG_ID = '@shawsheepsussiah/dsh-haavk-boot'
    const ROOT_PATH = '/plugins/dsh-haavk-boot'
    const CONFIG_ENDPOINT = ROOT_PATH + '/config'
    const EVENTS_ENDPOINT = ROOT_PATH + '/events'
    const PREVIEW_ENDPOINT = ROOT_PATH + '/preview'
    const CSS_URL = ROOT_PATH + '/splash.css'
    const JS_URL = ROOT_PATH + '/splash.js'
    const SCRIPT_ID = 'dsh-haavk-splash-js'
    const CACHE_KEY = 'dsh-haavk-boot:lastConfig'

    const DEFAULTS = {
      enabled: true,
      bootSplash: true,
      visualEnabled: true,
      glowIntensity: 1,
      replayOnReload: true,
      audioEnabled: true,
      audioVolume: 1,
      audioMode: 'file',
      bootDelayMs: 300,
    }

    const state = { config: Object.assign({}, DEFAULTS), status: null }
    const listeners = new Set()

    function notify() {
      for (const fn of Array.from(listeners)) {
        try { fn() } catch (e) {}
      }
    }

    function mergeConfig(raw) {
      const src = (raw && typeof raw === 'object') ? raw : {}
      const out = Object.assign({}, DEFAULTS)
      for (const k of Object.keys(out)) if (src[k] !== undefined) out[k] = src[k]
      return out
    }

    /* 上次已知配置的本地缓存：让「关掉启动屏」的决策在首帧就生效，不闪主界面 */
    function readCachedConfig() {
      try {
        const raw = window.localStorage.getItem(CACHE_KEY)
        if (!raw) return null
        return mergeConfig(JSON.parse(raw))
      } catch (e) { return null }
    }

    function writeCachedConfig(cfg) {
      try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(cfg)) } catch (e) {}
    }

    /* ---------------- 启动屏自举 ---------------- */

    function ensureCss() {
      try {
        const doc = document
        if (doc.getElementById('dsh-haavk-splash-css')) return
        const link = doc.createElement('link')
        link.id = 'dsh-haavk-splash-css'
        link.rel = 'stylesheet'
        link.href = CSS_URL
        doc.head.appendChild(link)
      } catch (e) {}
    }

    function splashConfigPayload() {
      const c = state.config
      return {
        glowIntensity: c.glowIntensity,
        audioVolume: c.audioVolume,
        audioMuted: c.audioEnabled === false || c.audioMode !== 'file',
        visualEnabled: c.visualEnabled,
      }
    }

    function unmountSplash() {
      try {
        const doc = document
        const r = doc.getElementById('dsh-startup-root')
        if (r && r.parentNode) r.parentNode.removeChild(r)
        const s = doc.getElementById(SCRIPT_ID)
        if (s && s.parentNode) s.parentNode.removeChild(s)
        doc.documentElement.classList.remove('dsu-lock')
        doc.documentElement.classList.remove('haavk-offset')
        if (doc.body) doc.body.style.overflow = ''
      } catch (e) {}
      try { window.__DSH_HAAVK_BOOTED__ = false } catch (e) {}
      /* 关键：scheduleSplash 的幂等位必须一起复位。
       * 否则「缓存说关 / 服务端说开」时再调 scheduleSplash() 会被这道 guard 直接 return，
       * 启动屏永远不再出现（手动预览重挂也一样）。 */
      splashScheduled = false
    }

    function mountSplash() {
      try {
        const doc = document
        if (!doc || !doc.body) return false
        if (doc.getElementById('dsh-startup-root')) return false
        if (window.__DSH_HAAVK_BOOTED__) return false

        ensureCss()

        /* root 是空壳：markup 由 splash.js 单一构建，避免两处漂移 */
        const root = doc.createElement('div')
        root.id = 'dsh-startup-root'
        doc.body.appendChild(root)

        try { doc.documentElement.classList.add('dsu-lock') } catch (e) {}
        try { doc.documentElement.classList.add('haavk-offset') } catch (e) {}
        try { window.__DSH_HAAVK_CFG__ = splashConfigPayload() } catch (e) {}

        const script = doc.createElement('script')
        script.id = SCRIPT_ID
        script.src = JS_URL
        script.defer = true
        script.onerror = () => { unmountSplash() }
        doc.body.appendChild(script)
        return true
      } catch (e) {
        return false
      }
    }

    function shouldPlay() {
      const c = state.config
      return c.enabled !== false && c.bootSplash !== false
    }

    let splashScheduled = false
    function scheduleSplash() {
      if (splashScheduled) return
      splashScheduled = true
      try {
        if (!shouldPlay()) return
        /* 立刻挂，不加延时：启动屏的作用就是首帧盖住主界面。
         * 旧版读 bootDelayMs(300) 再挂，会先闪一下主界面。 */
        const run = () => { if (shouldPlay()) mountSplash() }
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', run, { once: true })
        } else {
          run()
        }
      } catch (e) {}
    }

    /* ---------------- Host 通道 ---------------- */

    function fetchWithTimeout(url, init, ms) {
      const AC = typeof AbortController === 'function' ? AbortController : null
      if (!AC) return fetch(url, init)
      const ctl = new AC()
      const timer = setTimeout(() => { try { ctl.abort() } catch (e) {} }, ms)
      return fetch(url, Object.assign({}, init, { signal: ctl.signal }))
        .finally(() => { clearTimeout(timer) })
    }

    async function pullConfig(ms) {
      try {
        const r = await fetchWithTimeout(CONFIG_ENDPOINT, {}, ms || 4000)
        const b = await r.json()
        if (b && b.config) {
          state.config = mergeConfig(b.config)
          writeCachedConfig(state.config)
          notify()
          return true
        }
      } catch (e) {}
      return false
    }

    async function patchConfig(patch) {
      state.config = Object.assign({}, state.config, patch)
      writeCachedConfig(state.config)
      notify()
      try {
        const r = await fetch(CONFIG_ENDPOINT, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        const b = await r.json()
        if (b && b.config) {
          state.config = mergeConfig(b.config)
          writeCachedConfig(state.config)
        }
      } catch (e) {}
      notify()
    }

    async function postPreview() {
      try {
        await fetch(PREVIEW_ENDPOINT, { method: 'POST' })
        return true
      } catch (e) { return false }
    }

    function connectEvents() {
      const ES = globalThis.EventSource
      if (typeof ES !== 'function') return null
      let src
      try { src = new ES(EVENTS_ENDPOINT) } catch (e) { return null }
      const onMsg = (raw) => {
        const data = typeof raw === 'string' ? raw : (raw && raw.data)
        if (typeof data !== 'string' || !data) return
        let ev
        try { ev = JSON.parse(data) } catch (e) { return }
        if (ev.kind === 'hello' || ev.kind === 'status') {
          state.status = ev.status || null
          notify()
        } else if (ev.kind === 'offline') {
          state.status = Object.assign({}, state.status || {}, { online: false })
          notify()
        }
      }
      if (typeof src.addEventListener === 'function') src.addEventListener('message', onMsg)
      else src.onmessage = onMsg
      return () => { try { src.close() } catch (e) {} }
    }

    /* ---------------- 设置面板 ---------------- */

    function createPanel() {
      if (!React) return null
      const h = React.createElement

      const row = (label, control, hint) =>
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '6px 0' } },
          h('div', null,
            h('label', null, label),
            hint ? h('div', { style: { fontSize: 11, opacity: 0.5, marginTop: 2 } }, hint) : null),
          control)

      const toggle = (label, key, hint) => row(label,
        h('input', {
          type: 'checkbox',
          checked: Boolean(state.config[key]),
          onChange: (e) => void patchConfig({ [key]: Boolean(e.target.checked) }),
        }), hint)

      function Panel() {
        const pair = React.useState(0)
        const setTick = pair[1]
        React.useEffect(() => {
          const rerender = () => setTick((t) => t + 1)
          listeners.add(rerender)
          return () => { listeners.delete(rerender) }
        }, [])
        const st = state.status
        const online = !!(st && st.online === true)
        return h('div', { style: { padding: '16px 18px', display: 'grid', gap: 12 } },
          h('h2', { style: { fontSize: 16, margin: 0 } }, '哈夫克 Relink 节点固件'),
          h('div', { style: { fontSize: 11, letterSpacing: '.24em', opacity: 0.5 } }, 'HAAVK // RELINK NODE · SECURE LINK'),
          h('div', { style: { fontFamily: 'monospace', fontSize: 12 } },
            'NODE ', h('b', null, online ? 'ONLINE' : 'OFFLINE'),
            ' · CLIENTS ', h('b', null, String((st && st.clients) || 0))),
          h('section', { style: { border: '1px solid rgba(120,190,240,.2)', padding: '10px 12px' } },
            h('h3', { style: { fontSize: 12, margin: '0 0 8px' } }, '启动屏'),
            toggle('启用节点', 'enabled', '关闭后无开机动画'),
            toggle('开机启动屏', 'bootSplash', '进入后全屏播放'),
            toggle('视觉层（粒子 / HUD）', 'visualEnabled'),
            toggle('音频', 'audioEnabled', '关闭后静音播放'),
            toggle('热重载后重播', 'replayOnReload')),
          h('button', {
            type: 'button',
            style: { padding: '7px 16px', cursor: 'pointer' },
            onClick: () => {
              void postPreview()
              try {
                unmountSplash()
                mountSplash()
              } catch (e) {}
            },
          }, '重播启动屏'))
      }
      return Panel
    }

    /* ---------------- apply ---------------- */

    function apply(ctx) {
      /* 首帧决策：先用本地缓存（上次已知配置）决定要不要立刻挂启动屏，
       * 避免「已关闭启动屏却仍然播一次」和「等 HTTP 回来导致主界面先闪一下」。 */
      const cached = readCachedConfig()
      if (cached) state.config = cached
      scheduleSplash()

      /* Host 配置以服务端为准；结果与首帧决策不一致时纠正 */
      void (async () => {
        const ok = await pullConfig(4000)
        if (!ok) return
        try {
          const root = document.getElementById('dsh-startup-root')
          if (!shouldPlay() && root) unmountSplash()
          else if (shouldPlay() && !root && !window.__DSH_HAAVK_BOOTED__) scheduleSplash()
        } catch (e) {}
      })()

      let closeEvents = null
      try { closeEvents = connectEvents() } catch (e) {}

      try {
        const slots = ctx && ctx.slots
        if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
          const Panel = createPanel()
          if (Panel) {
            const register = () => {
              try {
                slots.register({
                  name: 'settings.plugins.tab',
                  key: PKG_ID,
                  id: PKG_ID,
                  order: 90,
                  label: () => '哈夫克Relink',
                  inject: () => ({}),
                }, () => React.createElement(Panel, {}))
              } catch (err) {
                if (typeof console !== 'undefined' && console.error) {
                  console.error('[dsh-haavk-boot] 设置分页注册失败（不影响其它功能）:', err)
                }
              }
            }
            try { slots.inject('settings.plugins.tab', register) } catch (err) {
              if (typeof console !== 'undefined' && console.error) {
                console.error('[dsh-haavk-boot] inject 失败:', err)
              }
            }
          }
        }
      } catch (e) {}

      try {
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(() => () => {
            if (closeEvents) closeEvents()
            listeners.clear()
          }, PKG_ID)
        }
      } catch (e) {}
    }

    module.exports = {
      name: PKG_ID + '-client',
      inject: ['slots'],
      apply,
    }
    return module.exports
  },
})
