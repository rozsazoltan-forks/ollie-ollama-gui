import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { persist } from 'zustand/middleware'

// Module-level cleanup handle (avoids window any-casting)
interface MonitoringCleanup {
  unlistenSystem: () => void
  unlistenModel: () => void
  unlistenStatus: () => void
}
let monitoringCleanupHandle: MonitoringCleanup | null = null

// Types for monitoring data
export interface SystemMetrics {
  cpuUsage: number
  memoryUsage: number
  memoryTotal: number
  diskUsage: number
  diskTotal: number
  networkRx: number
  networkTx: number
  timestamp: number
}

export interface ModelMetrics {
  modelName: string
  tokenRate: number // tokens per second
  responseTime: number // milliseconds
  memoryUsage: number // bytes
  activeConnections: number
  totalRequests: number
  errorRate: number
  timestamp: number
}

export interface OllamaStatus {
  version: string
  uptime: number
  modelsLoaded: string[]
  activeStreams: number
  queueLength: number
  serverHealth: 'healthy' | 'warning' | 'error'
  lastHealthCheck: number
}

interface MonitoringState {
  // System monitoring
  systemMetrics: SystemMetrics[]
  currentSystemMetrics: SystemMetrics | null

  // Model performance
  modelMetrics: ModelMetrics[]
  currentModelMetrics: Record<string, ModelMetrics>

  // Ollama status
  ollamaStatus: OllamaStatus | null

  // Monitoring controls
  isMonitoring: boolean // Active connection state (not persisted)
  monitoringEnabled: boolean // User preference (persisted)
  monitoringInterval: number // milliseconds
  maxHistoryLength: number

  // Actions
  startMonitoring: () => Promise<void>
  stopMonitoring: () => Promise<void>
  setMonitoringInterval: (interval: number) => void
  clearHistory: () => void
  getSystemHealth: () => Promise<void>
  getModelPerformance: (modelName?: string) => Promise<void>
  getOllamaStatus: () => Promise<void>

  // Running models
  runningModels: OllamaProcess[]
  getRunningModels: () => Promise<void>
  stopModel: (name: string) => Promise<boolean>
}

export interface OllamaProcess {
  name: string
  model: string
  size: number
  digest: string
  details: {
    parent_model: string
    format: string
    family: string
    families: string[]
    parameter_size: string
    quantization_level: string
  }
  expires_at: string
  size_vram: number
}

// Helpers to normalize backend snake_case to frontend camelCase and coerce numbers
type RawMetrics = Record<string, unknown>

function toNumber(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function normalizeSystemMetrics(obj: RawMetrics): SystemMetrics {
  return {
    cpuUsage: toNumber(obj?.cpu_usage ?? obj?.cpuUsage),
    memoryUsage: toNumber(obj?.memory_usage ?? obj?.memoryUsage),
    memoryTotal: toNumber(obj?.memory_total ?? obj?.memoryTotal),
    diskUsage: toNumber(obj?.disk_usage ?? obj?.diskUsage),
    diskTotal: toNumber(obj?.disk_total ?? obj?.diskTotal),
    networkRx: toNumber(obj?.network_rx ?? obj?.networkRx),
    networkTx: toNumber(obj?.network_tx ?? obj?.networkTx),
    timestamp: toNumber(obj?.timestamp)
  }
}

function normalizeModelMetrics(obj: RawMetrics): ModelMetrics {
  return {
    modelName: String(obj?.model_name ?? obj?.modelName ?? 'unknown'),
    tokenRate: toNumber(obj?.token_rate ?? obj?.tokenRate),
    responseTime: toNumber(obj?.response_time ?? obj?.responseTime),
    memoryUsage: toNumber(obj?.memory_usage ?? obj?.memoryUsage),
    activeConnections: toNumber(obj?.active_connections ?? obj?.activeConnections),
    totalRequests: toNumber(obj?.total_requests ?? obj?.totalRequests),
    errorRate: toNumber(obj?.error_rate ?? obj?.errorRate),
    timestamp: toNumber(obj?.timestamp)
  }
}

function normalizeOllamaStatus(obj: RawMetrics): OllamaStatus {
  const rawModels = obj?.models_loaded ?? obj?.modelsLoaded
  const models = Array.isArray(rawModels) ? rawModels : []
  return {
    version: String(obj?.version ?? 'unknown'),
    uptime: toNumber(obj?.uptime),
    modelsLoaded: models.map((m: unknown) => String(m)),
    activeStreams: toNumber(obj?.active_streams ?? obj?.activeStreams),
    queueLength: toNumber(obj?.queue_length ?? obj?.queueLength),
    serverHealth: (obj?.server_health ?? obj?.serverHealth ?? 'error') as OllamaStatus['serverHealth'],
    lastHealthCheck: toNumber(obj?.last_health_check ?? obj?.lastHealthCheck)
  }
}

export const useMonitoringStore = create<MonitoringState>()(persist((set, get) => ({

  // Initial state
  systemMetrics: [],
  currentSystemMetrics: null,
  modelMetrics: [],
  currentModelMetrics: {},
  ollamaStatus: null,
  runningModels: [],
  isMonitoring: false,
  monitoringEnabled: false,
  monitoringInterval: 2000, // 2 seconds
  maxHistoryLength: 100, // Keep last 100 data points

  // Start monitoring system and model metrics
  startMonitoring: async () => {
    const state = get()
    if (state.isMonitoring) return

    set({ isMonitoring: true, monitoringEnabled: true })

    try {
      // Start system monitoring via Rust backend
      await invoke('start_system_monitoring', {
        interval_ms: state.monitoringInterval
      })

      // Listen for system metrics events
      const unlistenSystem = await listen<RawMetrics>('monitoring:system-metrics', (event) => {
        const metrics = normalizeSystemMetrics(event.payload)
        set(state => ({
          currentSystemMetrics: metrics,
          systemMetrics: [...state.systemMetrics.slice(-state.maxHistoryLength + 1), metrics]
        }))
      })

      // Listen for model metrics events
      const unlistenModel = await listen<RawMetrics>('monitoring:model-metrics', (event) => {
        const metrics = normalizeModelMetrics(event.payload)
        set(state => ({
          currentModelMetrics: {
            ...state.currentModelMetrics,
            [metrics.modelName]: metrics
          },
          modelMetrics: [...state.modelMetrics.slice(-state.maxHistoryLength + 1), metrics]
        }))
      })

      // Listen for Ollama status updates
      const unlistenStatus = await listen<RawMetrics>('monitoring:ollama-status', (event) => {
        const status = normalizeOllamaStatus(event.payload)
        set({ ollamaStatus: status })
      })

        // Store cleanup functions for stopping
        monitoringCleanupHandle = {
          unlistenSystem,
          unlistenModel,
          unlistenStatus
        }

      console.log('📊 Monitoring started successfully')
    } catch (error) {
      console.error('Failed to start monitoring:', error)
      set({ isMonitoring: false })
    }
  },

  // Stop monitoring
  stopMonitoring: async () => {
    try {
      await invoke('stop_system_monitoring')

      // Clean up event listeners
      if (monitoringCleanupHandle) {
        monitoringCleanupHandle.unlistenSystem()
        monitoringCleanupHandle.unlistenModel()
        monitoringCleanupHandle.unlistenStatus()
        monitoringCleanupHandle = null
      }

      console.log('📊 Monitoring stopped')
    } catch (error) {
      console.error('Failed to stop monitoring:', error)
    } finally {
      set({ isMonitoring: false, monitoringEnabled: false })
    }
  },

  // Set monitoring interval
  setMonitoringInterval: (interval: number) => {
    set({ monitoringInterval: interval })

    // Restart monitoring with new interval if currently active
    const state = get()
    if (state.isMonitoring) {
      state.stopMonitoring().then(() => {
        state.startMonitoring()
      })
    }
  },

  // Clear monitoring history
  clearHistory: () => {
    set({
      systemMetrics: [],
      modelMetrics: [],
      currentModelMetrics: {}
    })
  },

  // Get current system health
  getSystemHealth: async () => {
    try {
      const raw = await invoke<RawMetrics>('get_system_metrics')
      const metrics = normalizeSystemMetrics(raw)
      set(state => ({
        currentSystemMetrics: metrics,
        // Add snapshot to history so charts aren't empty
        systemMetrics: [...state.systemMetrics, metrics].slice(-state.maxHistoryLength)
      }))
    } catch (error) {
      console.error('Failed to get system health:', error)
    }
  },

  // Get model performance data
  getModelPerformance: async (modelName?: string) => {
    try {
      const raw = await invoke<RawMetrics[]>('get_model_metrics', {
        model_name: modelName
      })
      const normalized: ModelMetrics[] = (raw || []).map((m) => normalizeModelMetrics(m))
      const metricsMap: Record<string, ModelMetrics> = {}
      normalized.forEach(metric => { metricsMap[metric.modelName] = metric })

      set(state => ({
        currentModelMetrics: { ...state.currentModelMetrics, ...metricsMap },
        modelMetrics: [...state.modelMetrics, ...normalized].slice(-state.maxHistoryLength)
      }))
    } catch (error) {
      console.error('Failed to get model performance:', error)
    }
  },

  // Get Ollama server status
  getOllamaStatus: async () => {
    try {
      const raw = await invoke<RawMetrics>('get_ollama_status')
      const status = normalizeOllamaStatus(raw)
      set({ ollamaStatus: status })
    } catch (error) {
      console.error('Failed to get Ollama status:', error)
    }
  },

  // Running models (ollama ps)
  getRunningModels: async () => {
    try {
      const raw = await invoke<{ models?: OllamaProcess[] }>('ollama_ps')
      const models = raw?.models || []
      set({ runningModels: models })
    } catch (error) {
      console.error('Failed to get running models:', error)
      set({ runningModels: [] })
    }
  },

  // Stop running model
  stopModel: async (name: string) => {
    try {
      await invoke('stop_model', { name })
      // Refresh list
      await get().getRunningModels()
      return true
    } catch (error) {
      console.error('Failed to stop model:', error)
      return false
    }
  },


}), {
  name: 'monitoring-storage',
  partialize: (state) => ({
    monitoringEnabled: state.monitoringEnabled,
    monitoringInterval: state.monitoringInterval,
    maxHistoryLength: state.maxHistoryLength
  })
}))

// Auto-cleanup on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (monitoringCleanupHandle) {
      monitoringCleanupHandle.unlistenSystem()
      monitoringCleanupHandle.unlistenModel()
      monitoringCleanupHandle.unlistenStatus()
    }
  })
}
