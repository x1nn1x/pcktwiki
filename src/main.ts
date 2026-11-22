import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { pinia } from './pinia'
import { useAuthStore } from './stores/auth'
import { setupInternalLinkNavigation } from './lib/internal-link-navigation'
import { loadLocalTheme, applyWikiTheme, initSystemThemeListener } from './lib/theme'
import './styles/theme.css'
import './styles/wiki-visual-editor.css'

const app = createApp(App)

app.use(pinia)
app.use(router)

applyWikiTheme(loadLocalTheme())
initSystemThemeListener()

const auth = useAuthStore(pinia)

Promise.all([auth.initialize(), router.isReady()])
  .catch((err) => {
    console.error('Failed to initialize app', err)
  })
  .finally(() => {
    app.mount('#app')
    setupInternalLinkNavigation(router)
  })

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    const updateSW = registerSW({
      immediate: true,
      // A new deploy is staged in the service worker; without this toast a
      // returning visitor can stay on the old bundle for a whole session.
      onNeedRefresh() {
        if (document.querySelector('.pckt-update-toast')) return
        const host = document.createElement('div')
        host.className = 'pckt-update-toast'
        host.setAttribute('role', 'status')
        host.innerHTML = `
          <span>New version ready.</span>
          <button type="button">Reload</button>`
        document.body.appendChild(host)
        host.querySelector('button')?.addEventListener('click', () => updateSW(true))
        window.setTimeout(() => host.remove(), 45_000)
      },
    })
  }).catch(() => {
    // PWA registration is optional
  })
}
