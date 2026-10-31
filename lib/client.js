/* dsh-haavk-boot — Web 客户端
 *
 * 桌面端 dsh-app://app/index.html 直接读 dist，不经过 Host 的 renderIndex/tapIndex，
 * 所以启动屏必须由本模块自举：自己往 DOM 插入 root、挂 CSS、加载运行时。
 * 资源地址 /plugins/dsh-haavk-boot/* 会被桌面协议层转发给 Host（已验证 200）。
 *
 * 关键：本文件顶层只允许出现 window.__ModuleLoader__.load(...) 一条语句，
 * 其余全部包在 factory 内，否则会和其它插件在同一脚本作用域撞名。
 */
window.__ModuleLoader__.load({
  id: 'dsh-haavk-boot',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    let React
    try { React = require('react') } catch (e) { React = undefined }

    const ROOT_PATH = '/plugins/dsh-haavk-boot'
    const CONFIG_ENDPOINT = ROOT_PATH + '/config'
    const EVENTS_ENDPOINT = ROOT_PATH + '/events'
    const CSS_URL = ROOT_PATH + '/splash.css'
    const JS_URL = ROOT_PATH + '/splash.js'
    const VIDEO_URL = ROOT_PATH + '/asset/boot.mp4'

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

    /* ---------------- 启动屏自举 ---------------- */

    const SPLASH_HTML =
      '<video class="haavk-boot" src="' + VIDEO_URL + '" playsinline preload="auto"></video>' +
      '<div class="haavk-grade"></div><div class="haavk-sweep"></div><canvas class="haavk-fx"></canvas>' +
      '<header><span><b>HAAVK</b> &nbsp;//&nbsp; RELINK NODE · SECURE LINK</span>' +
      '<span>NODE-03 · CN UID 0086</span></header>' +
      '<div class="haavk-cast">' +
      '<p id="haavk-c1">信息与你无限，</p>' +
      '<p id="haavk-c2">Relink 重塑未来。</p>' +
      '<p id="haavk-c3">欢迎使用 Relink 三号体验版。</p>' +
      '<p id="haavk-c4">本设备将持续采集上传您的</p>' +
      '<p id="haavk-c5">生理体征、精神状态相关数据，</p>' +
      '<p id="haavk-c6">请在使用前，检阅并签署用户协议。</p></div>' +
      '<footer><span><b>55 ms</b> &nbsp;·&nbsp; NEURAL SYNC &nbsp;·&nbsp; 天空属于哈夫克</span>' +
      '<span>REAL-TIME TELEMETRY</span></footer>' +
      '<div class="haavk-bar"><i></i></div>'

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

    function unmountSplash() {
      try {
        const doc = document
        const r = doc.getElementById('dsh-startup-root')
        if (r && r.parentNode) r.parentNode.removeChild(r)
        doc.documentElement.classList.remove('dsu-lock')
        doc.documentElement.classList.remove('haavk-offset')
      } catch (e) {}
    }

    function mountSplash() {
      try {
        const doc = document
        if (!doc || !doc.body) return false
        if (doc.getElementById('dsh-startup-root')) return false
        if (window.__DSH_HAAVK_BOOTED__) return false

        ensureCss()

        const root = doc.createElement('div')
        root.id = 'dsh-startup-root'
        root.innerHTML = SPLASH_HTML
        doc.body.appendChild(root)

        try { doc.documentElement.classList.add('dsu-lock') } catch (e) {}
        try { doc.documentElement.classList.add('haavk-offset') } catch (e) {}

        const script = doc.createElement('script')
        script.src = JS_URL
        script.defer = true
        script.onerror = () => { unmountSplash() }
        doc.body.appendChild(script)
        return true
      } catch (e) {
        return false
      }
    }

    function scheduleSplash() {
      try {
        if (!state.config.enabled || !state.config.bootSplash) return
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', () => { mountSplash() }, { once: true })
        } else {
          mountSplash()
        }
      } catch (e) {}
    }

    /* ---------------- Host 通道 ---------------- */

    async function pullConfig() {
      try {
        const r = await fetch(CONFIG_ENDPOINT)
        const b = await r.json()
        if (b && b.config) { state.config = mergeConfig(b.config); notify() }
      } catch (e) {}
    }

    async function patchConfig(patch) {
      state.config = Object.assign({}, state.config, patch)
      notify()
      try {
        const r = await fetch(CONFIG_ENDPOINT, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        const b = await r.json()
        if (b && b.config) state.config = mergeConfig(b.config)
      } catch (e) {}
      notify()
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
        if (ev.kind === 'hello' || ev.kind === 'status') { state.status = ev.status || null; notify() }
        else if (ev.kind === 'offline') {
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
            toggle('热重载后重播', 'replayOnReload')),
          h('button', {
            type: 'button',
            style: { padding: '7px 16px', cursor: 'pointer' },
            onClick: () => {
              try {
                unmountSplash()
                window.__DSH_HAAVK_BOOTED__ = false
                mountSplash()
              } catch (e) {}
            },
          }, '重播启动屏'))
      }
      return Panel
    }

    /* ---------------- apply ---------------- */

    function apply(ctx) {
      /* 启动屏优先 — 不等 Host 配置，先挂上，避免闪一下主界面 */
      scheduleSplash()

      try { void pullConfig() } catch (e) {}
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
                  key: 'dsh-haavk-boot',
                  id: 'dsh-haavk-boot',
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
          }, 'dsh-haavk-boot')
        }
      } catch (e) {}
    }

    module.exports = {
      name: 'dsh-haavk-boot-client',
      inject: ['slots'],
      apply,
    }
    return module.exports
  },
})
