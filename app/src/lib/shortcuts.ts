import { useEffect } from 'react'

interface ShortcutHandlers {
  onNewChat: () => void
  onFocusModelPicker: () => void
  onFocusInput: () => void
  onToggleSidebar: () => void
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      if (!ctrl) return

      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      const inInput = tag === 'input' || tag === 'textarea'

      if (e.key === 'n' && !inInput) {
        e.preventDefault()
        handlers.onNewChat()
        return
      }
      if (e.key === 'k' && !inInput) {
        e.preventDefault()
        handlers.onFocusModelPicker()
        return
      }
      if (e.key === '/') {
        e.preventDefault()
        handlers.onFocusInput()
        return
      }
      if (e.key === 'b') {
        e.preventDefault()
        handlers.onToggleSidebar()
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handlers])
}
