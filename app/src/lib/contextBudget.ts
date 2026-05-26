// Provider floors — safe minimum context limits per API, used when model is unknown.
// Values are in tokens. We target 80% to leave headroom for the response.
const PROVIDER_FLOORS: Record<string, number> = {
  ollama:    8_192,
  openai:   16_385,
  anthropic: 200_000,
  google:    128_000,
  groq:      8_192,
  other:     4_096,
}

// Model name pattern overrides — only raises the floor, never lowers it.
// Matched via substring (case-insensitive). First match wins.
const MODEL_OVERRIDES: Array<{ pattern: string; limit: number }> = [
  { pattern: 'gemini-2',       limit: 1_000_000 },
  { pattern: 'gemini-1.5',     limit: 1_000_000 },
  { pattern: 'gemini-1.0',     limit: 32_768    },
  { pattern: 'claude-3-5',     limit: 200_000   },
  { pattern: 'claude-3',       limit: 200_000   },
  { pattern: 'claude-4',       limit: 200_000   },
  { pattern: 'gpt-4o',         limit: 131_072   },
  { pattern: 'gpt-4-turbo',    limit: 131_072   },
  { pattern: 'gpt-4',          limit: 8_192     },
  { pattern: 'gpt-3.5',        limit: 16_385    },
  { pattern: 'o1',             limit: 131_072   },
  { pattern: 'o3',             limit: 200_000   },
  { pattern: 'llama3.3',       limit: 131_072   },
  { pattern: 'llama3.2',       limit: 131_072   },
  { pattern: 'llama3.1',       limit: 131_072   },
  { pattern: 'llama3',         limit: 8_192     },
  { pattern: 'llama2',         limit: 4_096     },
  { pattern: 'mistral-large',  limit: 131_072   },
  { pattern: 'mistral-nemo',   limit: 131_072   },
  { pattern: 'mistral',        limit: 32_768    },
  { pattern: 'mixtral',        limit: 32_768    },
  { pattern: 'deepseek-r1',    limit: 131_072   },
  { pattern: 'deepseek-v3',    limit: 131_072   },
  { pattern: 'deepseek',       limit: 32_768    },
  { pattern: 'qwen2.5',        limit: 131_072   },
  { pattern: 'qwen2',          limit: 32_768    },
  { pattern: 'qwen',           limit: 32_768    },
  { pattern: 'phi4',           limit: 16_384    },
  { pattern: 'phi3.5',         limit: 131_072   },
  { pattern: 'phi3',           limit: 131_072   },
  { pattern: 'phi',            limit: 4_096     },
  { pattern: 'command-r-plus', limit: 131_072   },
  { pattern: 'command-r',      limit: 131_072   },
  { pattern: 'gemma2',         limit: 8_192     },
  { pattern: 'gemma',          limit: 8_192     },
  { pattern: 'kimi',           limit: 131_072   },
  { pattern: 'moonshot',       limit: 131_072   },
  { pattern: 'yi-',            limit: 32_768    },
  { pattern: 'codestral',      limit: 32_768    },
  { pattern: 'solar',          limit: 32_768    },
  { pattern: 'aya',            limit: 8_192     },
  // Generic size hints in model names — lowest priority
  { pattern: '1m',             limit: 1_000_000 },
  { pattern: '128k',           limit: 131_072   },
  { pattern: '32k',            limit: 32_768    },
  { pattern: '16k',            limit: 16_384    },
]

// Rough token estimate: 1 token ≈ 4 chars (standard approximation)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function resolveContextLimit(providerType: string, modelName: string): number {
  const floor = PROVIDER_FLOORS[providerType] ?? PROVIDER_FLOORS.other
  const model = modelName.toLowerCase()

  for (const { pattern, limit } of MODEL_OVERRIDES) {
    if (model.includes(pattern.toLowerCase())) {
      return Math.max(floor, limit)
    }
  }
  return floor
}

export interface ApiMessage {
  role: string
  content: string
  images?: string[]
}

// Trims messages to fit within 80% of the context limit.
// Always keeps: system prompt (already excluded from messages array),
// and the last message (current user turn).
// Drops from the oldest end first.
export function trimToContextBudget(
  messages: ApiMessage[],
  systemPrompt: string | null,
  providerType: string,
  modelName: string,
): ApiMessage[] {
  const limit = resolveContextLimit(providerType, modelName)
  const budget = Math.floor(limit * 0.8)

  const systemTokens = systemPrompt ? estimateTokens(systemPrompt) : 0
  let available = budget - systemTokens

  if (available <= 0) return messages.slice(-1)

  // Estimate tokens for each message
  const costs = messages.map(m => estimateTokens(m.content))
  const total = costs.reduce((a, b) => a + b, 0)

  if (total <= available) return messages // fits fine, no trimming needed

  // Drop from the front (oldest) until we fit, always keeping the last message
  const result: ApiMessage[] = []
  let remaining = available

  // Reserve tokens for the last message (current user turn)
  const lastCost = costs[costs.length - 1] ?? 0
  remaining -= lastCost

  // Walk from second-to-last backwards to find how many we can keep
  const kept: ApiMessage[] = [messages[messages.length - 1]]
  for (let i = messages.length - 2; i >= 0; i--) {
    if (costs[i] <= remaining) {
      kept.unshift(messages[i])
      remaining -= costs[i]
    }
    // Once we can't fit the next message, stop (don't skip to try smaller ones)
    // This preserves conversation order integrity
  }

  return kept.length > 0 ? kept : result
}
