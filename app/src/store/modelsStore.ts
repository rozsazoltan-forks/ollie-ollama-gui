import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export interface OllamaModel {
  name: string
  modified_at: string
  size: number
  digest: string
  details?: {
    format: string
    family: string
    families?: string[]
    parameter_size: string
    quantization_level: string
  }
}

export interface ModelInfo {
  license: string
  modelfile: string
  parameters: string
  template: string
  system: string
  details: {
    format: string
    family: string
    families: string[]
    parameter_size: string
    quantization_level: string
  }
}

export interface PullProgress {
  status?: string
  completed?: number
  downloaded?: number
  total?: number
  size?: number
}

export interface PullState {
  name: string
  status: string
  progress?: PullProgress
  error?: string
}

interface ModelsState {
  models: OllamaModel[]
  isLoading: boolean
  error: string | null
  // Pull progress keyed by pull_id
  pulls: Record<string, PullState>

  // Actions
  fetchModels: () => Promise<void>
  pullModel: (name: string) => Promise<string | null>
  cancelPull: (pullId: string) => Promise<void>
  deleteModel: (name: string) => Promise<boolean>
  showModel: (name: string) => Promise<ModelInfo | null>
  clearError: () => void
}

export const useModelsStore = create<ModelsState>((set) => ({
  models: [],
  isLoading: false,
  error: null,
  pulls: {},

  fetchModels: async () => {
    set({ isLoading: true, error: null })

    try {
      // For now, we'll implement a basic models list
      // This will be connected to the actual Ollama API later
      const result = await invoke('models_list') as { models: OllamaModel[] }
      set({ models: result.models || [], isLoading: false })
    } catch (error) {
      console.error('Failed to fetch models:', error)
      set({
        models: [],
        isLoading: false,
        error: error as string
      })
    }
  },
  pullModel: async (name: string) => {
    try {
      const pullId = `pull_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

      // OPTIMISTIC UPDATE: Immediately show in UI
      set((s) => ({ pulls: { ...s.pulls, [pullId]: { name, progress: { status: 'starting' }, status: 'starting' } } }))

      // Attach listeners lazily per pull
      const unlistenStart = await listen<{ pull_id: string }>('models:pull-start', (e) => {
        const { pull_id } = e.payload
        if (pull_id !== pullId) return
        set((s) => ({ pulls: { ...s.pulls, [pull_id]: { ...s.pulls[pull_id], status: 'starting' } } }))
      })
      const unlistenProgress = await listen<{ pull_id: string; progress: PullProgress }>('models:pull-progress', (e) => {
        const { pull_id, progress } = e.payload
        if (pull_id !== pullId) return
        set((s) => ({ pulls: { ...s.pulls, [pull_id]: { ...(s.pulls[pull_id] || { name, status: 'in-progress' }), progress, status: 'in-progress' } } }))
      })
      const unlistenError = await listen<{ pull_id: string; error: string }>('models:pull-error', (e) => {
        const { pull_id, error } = e.payload
        if (pull_id !== pullId) return
        set((s) => ({ pulls: { ...s.pulls, [pull_id]: { ...(s.pulls[pull_id] || { name, status: 'error' }), error, status: 'error' } } }))
        setTimeout(() => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          set((s) => { const { [pull_id]: _removed, ...rest } = s.pulls; return { pulls: rest } })
          cleanupListeners()
        }, 5000)
      })
      const unlistenCancelled = await listen<{ pull_id: string }>('models:pull-cancelled', (e) => {
        const { pull_id } = e.payload
        if (pull_id !== pullId) return
        set((s) => ({ pulls: { ...s.pulls, [pull_id]: { ...(s.pulls[pull_id] || { name, status: 'cancelled' }), status: 'cancelled' } } }))
        setTimeout(() => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          set((s) => { const { [pull_id]: _removed, ...rest } = s.pulls; return { pulls: rest } })
          cleanupListeners()
        }, 1500)
      })
      const cleanupListeners = () => {
        unlistenStart(); unlistenProgress(); unlistenError(); unlistenCancelled(); unlistenComplete()
      }
      const unlistenComplete = await listen<{ pull_id: string }>('models:pull-complete', (e) => {
        const { pull_id } = e.payload
        if (pull_id !== pullId) return
        set((s) => ({ pulls: { ...s.pulls, [pull_id]: { ...(s.pulls[pull_id] || { name, status: 'complete' }), status: 'complete' } } }))
        useModelsStore.getState().fetchModels().catch(() => { })
        setTimeout(() => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          set((s) => { const { [pull_id]: _removed, ...rest } = s.pulls; return { pulls: rest } })
          cleanupListeners()
        }, 2000)
      })

      const res = await invoke('model_pull', { name, pullId }) as { success: boolean, error?: string }
      if (!res.success) {
        throw new Error(res.error || 'Pull failed')
      }
      return pullId
    } catch (e) {
      set({ error: String(e) })
      return null
    }
  },

  cancelPull: async (pullId: string) => {
    try {
      set((s) => ({
        pulls: {
          ...s.pulls,
          [pullId]: { ...(s.pulls[pullId] || {}), status: 'cancelling' }
        }
      }))
      await invoke('model_pull_cancel', { pullId })
    } catch (e) {
      console.error('Failed to cancel pull:', e)
    }
  },
  deleteModel: async (name: string) => {
    try {
      const res = await invoke('model_delete', { name }) as { success: boolean, error?: string }
      if (!res.success) throw new Error(res.error || 'Delete failed')
      await useModelsStore.getState().fetchModels()
      return true
    } catch (e) {
      set({ error: String(e) })
      return false
    }
  },
  showModel: async (name: string) => {
    try {
      const res = await invoke('model_show', { name }) as ModelInfo
      return res
    } catch (e) {
      set({ error: String(e) })
      return null
    }
  },

  clearError: () => set({ error: null }),
}))
