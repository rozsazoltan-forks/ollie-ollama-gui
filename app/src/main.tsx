import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { invoke } from '@tauri-apps/api/core'
import { useSettingsStore } from './store/settingsStore'
import { useChatStore } from './store/chatStore'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Tauri window global type augmentation — __TAURI__ is injected at runtime
declare global {
  interface Window {
    __TAURI__?: { core?: { invoke?: unknown } }
  }
}

// Dev/HMR + window unload cleanup: ensure any running streams are aborted to avoid callback warnings
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (window.__TAURI__?.core?.invoke) {
      invoke('abort_chat').catch(() => {})
    }
  })
}

window.addEventListener('beforeunload', () => {
  if (window.__TAURI__?.core?.invoke) {
    invoke('abort_chat').catch(() => {})
  }
})

// Helper: wait for Tauri bridge to be ready (WebKit may inject a tad later)
async function waitForTauriReady(timeoutMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (window.__TAURI__?.core?.invoke) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !!(window.__TAURI__?.core?.invoke)
}

// Initial settings load and default model bootstrap
;(async () => {
  try {
    await waitForTauriReady()
    await useSettingsStore.getState().loadSettingsFromBackend()
    const { defaultModel } = useSettingsStore.getState()
    if (defaultModel) {
      useChatStore.getState().setCurrentModel(defaultModel)
    }
  } catch {
    // best-effort: ignore startup errors
  }
})()
