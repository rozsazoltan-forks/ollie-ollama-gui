import { Monitor, Moon, Sun } from 'lucide-react'
import { useSettingsStore } from '../store/settingsStore'

export default function ThemeToggle() {
  const { theme, setTheme, saveSettingsToBackend } = useSettingsStore()
  const themeOrder = ['light', 'dark', 'system'] as const

  const toggleTheme = async () => {
    const nextTheme = themeOrder[(themeOrder.indexOf(theme) + 1) % themeOrder.length]
    setTheme(nextTheme)

    try {
      await saveSettingsToBackend()
    } catch (error) {
      console.error('Failed to save theme setting', error)
    }
  }

  const icon = theme === 'light'
    ? <Moon size={18} />
    : theme === 'dark'
      ? <Monitor size={18} />
      : <Sun size={18} />

  const nextThemeLabel = themeOrder[(themeOrder.indexOf(theme) + 1) % themeOrder.length]

  return (
    <button
      onClick={toggleTheme}
      className="p-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors"
      title={`Switch to ${nextThemeLabel} theme`}
      aria-label={`Current theme: ${theme}. Switch to ${nextThemeLabel} theme`}
    >
      {icon}
    </button>
  )
}
