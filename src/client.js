// 九层之台（dsh-sandman）客户端入口 —— 在 DSH 桌面端主界面注册 UI。
// 配方对照 dsh-memory-eternal（已验证可用）：
//   槽位 sidebar.footer.action = 左侧栏底部（头像上方区域）→ 按钮 + 全屏弹窗（iframe 面板）。
// 本文件不参与 esbuild 打包，由 build.mjs 原样拷贝到 lib/client.js。
window.__ModuleLoader__.load({
  id: 'dsh-sandman',
  factory: (require) => {
    var module = { exports: {} }
    const React = require('react')
    const h = (type, props, ...children) => React.createElement(type, props, ...children)

    const NS = 'dsh-sandman'
    const PANEL_SRC = '/dsh-sandman/api/ui/panel'
    const TITLE = '九层之台'

    const LOCALE_ZH = { nav: TITLE, subtitle: '记忆 · 总览 / 梦境 / 审核 / 馆长' }
    const LOCALE_EN = { nav: TITLE, subtitle: 'Memory · overview / dreams / review / curator' }

    // ---- 只此青绿 · 样式（浅色，跟随宿主 dsw 变量兜底）----
    const CSS = `
.sandman-footer { width: 100%; flex: 1 1 100%; }
[class*="footerActions"]:has(.sandman-footer), :has(> .sandman-footer) { flex-wrap: wrap; width: 100%; }
.sandman-btn { display: flex; align-items: center; gap: 9px; width: 100%; padding: 7px 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.14));
  background: var(--dsw-alias-bg-layer-1, rgba(62,124,107,0.06));
  color: var(--dsw-alias-label-secondary, #5f6b66); font: inherit; font-size: 13.5px; line-height: 18px;
  border-radius: 8px; cursor: pointer; text-align: left; transition: background .15s ease, color .15s ease; }
.sandman-btn:hover { background: rgba(62,124,107,0.14); color: #3E7C6B; }
.sandman-btn:active { transform: translateY(0.5px); }
.sandman-ico { display: inline-flex; flex: none; width: 18px; height: 18px; align-items: center; justify-content: center; }
.sandman-ico svg { width: 18px; height: 18px; display: block; }
.sandman-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.sandman-footer.rail .sandman-btn { justify-content: center; padding: 7px 0; }
.sandman-footer.rail .sandman-label { display: none; }
.sandman-overlay { position: fixed; inset: 0; z-index: 1001; background: rgba(30,36,33,0.42);
  backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; padding: 28px; }
.sandman-modal { width: min(1380px, 98vw); height: min(98vh, 1080px); display: flex; flex-direction: column;
  background: #FAF7F0; color: #2B3230; border: 1px solid #D8CFB4; border-radius: 18px;
  box-shadow: 0 34px 90px rgba(20,30,26,0.35); overflow: hidden;
  animation: sandman-pop 0.22s cubic-bezier(0.2,0.8,0.2,1); }
@keyframes sandman-pop { from { opacity: 0; transform: translateY(12px) scale(0.985); } }
.sandman-modal-bar { display: flex; align-items: center; gap: 12px; padding: 12px 18px;
  border-bottom: 1px solid #E4DCC6; background: #F5F1E6; }
.sandman-modal-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; flex: 1; }
.sandman-modal-title b { font-size: 15px; font-weight: 700; color: #2B3230; white-space: nowrap; }
.sandman-modal-title span { font-size: 12px; color: #8A8778; white-space: nowrap; }
.sandman-modal-bar .sandman-seal { width: 22px; height: 22px; flex: none; align-self: center; }
.sandman-close { border: 1px solid #D8CFB4; background: transparent; color: #5F6B66; border-radius: 8px;
  width: 30px; height: 30px; line-height: 1; font-size: 16px; cursor: pointer; }
.sandman-close:hover { color: #C0392B; border-color: #C0392B; }
.sandman-frame { flex: 1; width: 100%; border: 0; background: #FAF7F0; }
`

    // 图标：三层叠层（层级结构），石绿
    function LayerIcon() {
      return h('svg', { viewBox: '0 0 20 20', 'aria-hidden': true },
        h('path', { d: 'M10 2.5 L17 5.5 L10 8.5 L3 5.5 Z', fill: '#3E7C6B' }),
        h('path', { d: 'M10 7 L17 10 L10 13 L3 10 Z', fill: '#3E7C6B', opacity: 0.62 }),
        h('path', { d: 'M10 11.5 L17 14.5 L10 17.5 L3 14.5 Z', fill: '#3E7C6B', opacity: 0.34 }))
    }
    function SealIcon() {
      return h('svg', { viewBox: '0 0 22 22', 'aria-hidden': true },
        h('rect', { x: 2, y: 2, width: 18, height: 18, rx: 4, fill: 'none', stroke: '#B8934A', 'stroke-width': 1.6 }),
        h('path', { d: 'M6 7.5 L11 5.5 L16 7.5 L11 9.5 Z', fill: '#B8934A' }),
        h('rect', { x: 7, y: 11, width: 8, height: 1.6, rx: 0.8, fill: '#B8934A' }),
        h('rect', { x: 7, y: 14, width: 8, height: 1.6, rx: 0.8, fill: '#B8934A', opacity: 0.55 }))
    }

    function FooterButton(props) {
      const wide = !(props && props.wide === false)
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])
      return h('div', { className: 'sandman-footer' + (wide ? '' : ' rail') },
        h('style', null, CSS),
        h('button', { type: 'button', className: 'sandman-btn', onClick: () => setOpen(true), title: TITLE },
          h('span', { className: 'sandman-ico' }, h(LayerIcon)),
          h('span', { className: 'sandman-label' }, TITLE)),
        open && h('div', {
          className: 'sandman-overlay',
          onClick: (e) => { if (e.target === e.currentTarget) setOpen(false) },
        },
          h('div', { className: 'sandman-modal' },
            h('div', { className: 'sandman-modal-bar' },
              h('span', { className: 'sandman-seal' }, h(SealIcon)),
              h('div', { className: 'sandman-modal-title' },
                h('b', null, TITLE),
                h('span', null, '总览 · 梦境 · 审核 · 馆长 · 设置')),
              h('button', { type: 'button', className: 'sandman-close', onClick: () => setOpen(false), 'aria-label': '关闭' }, '×')),
            h('iframe', { className: 'sandman-frame', src: PANEL_SRC, title: TITLE }))))
    }

    function apply(t) {
      // 注册词表（label 走 locale，宿主切换语言时显示对应标题）
      try {
        t.effect(() => t.locale.register(NS, { zh: LOCALE_ZH, en: LOCALE_EN }), 'dsh-sandman: locale')
      } catch (_) { /* locale 不可用时 label 直接返回中文 */ }
      let l = (k) => (LOCALE_ZH[k] || k)
      try { if (t.locale && typeof t.locale.bind === 'function') l = t.locale.bind(NS) } catch (_) { /* keep fallback */ }

      t.effect(() => t.slots.inject('sidebar.footer.action', () => t.slots.register({
        name: 'sidebar.footer.action',
        id: NS + ':footer',
        order: 101,
        label: () => l('nav'),
        locale: NS,
        inject: () => ({}),
      }, (props) => h(FooterButton, props))), 'dsh-sandman: sidebar footer action')
    }

    module.exports = { apply, inject: ['slots', 'locale'] }
    return module.exports
  },
})
