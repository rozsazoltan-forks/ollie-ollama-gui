# Ollie — Architecture Analysis & Roadmap

> Last updated: 2026-05-26  
> Version surveyed: v0.2.6  
> Purpose: Track architectural weaknesses and the path to a solid foundation.

---

## What the App Is

Desktop AI chat client bridging local (Ollama) and cloud (OpenAI, Anthropic, Google, Groq) LLMs.

**Core concerns:**
- Conversation persistence (SQLite, user data must survive upgrades)
- Streaming rendering (smooth, cancellable, resilient)
- Tool execution via MCP (bounded, observable, recoverable)
- System monitoring (Ollama health, model VRAM, system metrics)

**Statefulness is the hard problem.** LLM conversations accumulate history, hit context limits, switch providers mid-session, and run tool loops. Every architectural decision must account for this.

---

## Critical Issues (fix first)

### C1 — `chatStore.ts` is a God Object

**956 lines. One store handles:**
- In-memory message state
- All SQLite persistence (direct `invoke()` calls)
- Provider selection logic
- Streaming event orchestration (6 listeners per stream)
- Drip queue animation (30ms timer)
- Tool call state tracking
- Auto-title generation
- Message edit + regeneration (~200 lines duplicated from `sendMessage`)

`sendMessage` and `editUserMessage` are nearly identical 200-line functions. They will diverge. Any bug fixed in one will be missed in the other.

**For an AI chat app, conversation management is the core domain.** It must be isolated, testable, and composable. Right now it is none of these.

**Target architecture:**
```
conversationService.ts   — pure business logic (no React, no Tauri imports)
streamingPipeline.ts     — drip queue, cancellation, event wiring (shared by send + edit)
persistenceService.ts    — all DB invoke() calls, one place
chatStore.ts             — thin Zustand slice: UI state only, delegates to services
```

**Files to touch:** `app/src/store/chatStore.ts`, new `app/src/services/` directory.

---

### C2 — No conversation context window management

The app sends **the entire conversation history** to the LLM on every message. For a 50-message conversation with 3 attached files, this can be hundreds of thousands of tokens — hitting provider limits and causing silent API failures.

There is no truncation strategy. Long conversations fail at the API level with a generic error string.

**Required strategies:**
- Sliding window: keep last N turns
- Budget guard: estimate token count before sending, truncate oldest turns
- Summary injection (future): compress old turns into a system message

**Files to touch:** `conversationService.ts` (new), `app/src/store/chatStore.ts`.

---

### C3 — No DB migration framework

Schema changes are done with inline SQL and a bare `ALTER TABLE ... ADD COLUMN` that silently swallows errors:

```rust
let _ = sqlx::query("ALTER TABLE chats ADD COLUMN title TEXT").execute(&pool).await;
```

When a future version changes the schema non-additively (rename column, restructure `meta_json`, add constraint), there is no migration path. User data can be silently broken on upgrade.

`sqlx::migrate!()` is already in the dependency tree — it is not used.

**Fix:**
1. Create `src-tauri/migrations/` directory with numbered `.sql` files
2. Replace inline `CREATE TABLE` with `sqlx::migrate!("../migrations").run(&pool).await?`
3. Move all schema to migration files

**Files to touch:** `src-tauri/src/db/mod.rs`, new `src-tauri/migrations/` files.

---

## High Priority Issues

### H1 — API keys stored plaintext

`~/.config/ollie/settings.json` contains all provider API keys in plaintext. Any process running as the user can read them.

**Fix:** Store keys in OS keychain (libsecret on Linux, Keychain on macOS, Credential Manager on Windows). Reference by a non-sensitive ID in settings.json. Tauri has `tauri-plugin-stronghold` for encrypted local storage as an alternative.

**Files to touch:** `src-tauri/src/commands/settings.rs`, `app/src/store/settingsStore.ts`.

---

### H2 — Global `lazy_static` state instead of Tauri managed state

`ACTIVE_STREAMS`, `MONITORING_ACTIVE`, `ACTIVE_MCP_CLIENTS` are all `lazy_static` globals:

```rust
lazy_static! {
    static ref ACTIVE_STREAMS: Mutex<HashMap<String, Arc<AtomicBool>>> = ...;
    static ref ACTIVE_MCP_CLIENTS: Mutex<HashMap<String, McpClient>> = ...;
}
static MONITORING_ACTIVE: AtomicBool = AtomicBool::new(false);
```

Problems:
- No lifecycle (no cleanup on app exit)
- Untestable (state bleeds between tests)
- Bypass Tauri's dependency injection model

Tauri v2 has `app.manage(T)` and `State<T>` in commands — designed exactly for this.

**Fix:** Replace all globals with managed state structs registered in `setup()`.

**Files to touch:** `src-tauri/src/commands/chat.rs`, `src-tauri/src/commands/monitoring.rs`, `src-tauri/src/mcp/mod.rs`, `src-tauri/src/lib.rs`.

---

### H3 — No provider capability abstraction

Vision support detected by string-matching model names in `openai.rs`:
```rust
model.contains("vision") || model.contains("gpt-4o") || model.contains("gpt-4-turbo")
```

Tool support assumed for all providers. Breaks silently when:
- New models release that don't match patterns
- User configures a custom OpenAI-compatible endpoint
- Provider adds/removes capabilities

**Fix:** Add `capabilities()` to the `LLMProvider` trait:
```rust
fn capabilities(&self, model: &str) -> ProviderCapabilities
```
```rust
pub struct ProviderCapabilities {
    pub vision: bool,
    pub tools: bool,
    pub streaming: bool,
    pub max_context_tokens: usize,
}
```

UI decisions (show image button, enable tools, context budget) driven by capability queries.

**Files to touch:** `src-tauri/src/providers/traits.rs`, all provider implementations.

---

### H4 — Dual settings persistence (two sources of truth)

Settings exist in:
1. Backend JSON: `~/.config/ollie/settings.json`
2. Frontend localStorage: via Zustand `persist` middleware

On app start, frontend loads from localStorage, then backend overwrites. If these diverge (corrupted file, version upgrade, manual edit), behavior is undefined.

**Rule:** Backend is single source of truth. Frontend is a read cache. `settingsStore` should be non-persisted — mount reads from backend, all writes go to backend only. `localStorage` adds zero value here and creates split-brain risk.

**Files to touch:** `app/src/store/settingsStore.ts`.

---

## Medium Priority Issues

### M1 — HTTP clients not pooled

Every command creates a new `reqwest::Client`:
```rust
let client = reqwest::Client::builder().timeout(...).build().unwrap_or_default();
```

`reqwest::Client` holds a connection pool, TLS session cache, and HTTP/2 multiplexer. Creating one per command discards all of this. Under simultaneous load (monitoring + streaming + model pull), 3 independent pools open to the same host.

**Fix:** Single `reqwest::Client` as Tauri managed state, injected via `State<HttpClient>`.

**Files to touch:** `src-tauri/src/lib.rs`, all commands that build a client.

---

### M2 — Errors are untyped strings

All Rust commands return `Result<T, String>`. Frontend receives an opaque string and can only display it. Cannot distinguish:
- Network error → retry
- Auth error → open settings
- Model not found → open model picker
- Rate limit → backoff + inform user
- Context too long → truncate + retry

**Fix:** Typed error enum serialized to JSON with a `type` discriminator field. Frontend pattern-matches on type for intelligent recovery.

```rust
#[derive(Serialize)]
#[serde(tag = "type")]
pub enum OllieError {
    Network { message: String },
    Auth { message: String, provider: String },
    ModelNotFound { model: String },
    ContextTooLong { tokens: usize, limit: usize },
    // ...
}
```

**Files to touch:** New `src-tauri/src/error.rs`, all command return types.

---

### M3 — MCP servers have no reconnection or health check

MCP servers are subprocess connections or SSE streams. Either can die. The app has no reconnection mechanism — tool calls silently fail. The "connected" badge never goes to "disconnected" once set.

**Fix:**
- Heartbeat ping on MCP connections (30s interval)
- Auto-reconnect with exponential backoff on failure
- Frontend status driven by live health checks, not connection-time snapshot

**Files to touch:** `src-tauri/src/mcp/mod.rs`, `src-tauri/src/mcp/transport.rs`.

---

### M4 — No content size limits at attachment boundaries

Files read fully into memory via `FileReader.readAsText()` and stored in `meta_json`. A 50MB log file will:
1. OOM the renderer process
2. Get stored fully in SQLite
3. Get sent to the LLM API every turn (API rejects it)

Tool result truncation exists at 8000 chars in orchestrator. File attachments have nothing.

**Fix:** Enforce limits at the attachment point:
- 500KB per file hard limit (show error if exceeded)
- 2MB total per message
- Truncation warning in UI

**Files to touch:** `app/src/components/MainPanel.tsx`.

---

## Low Priority / Future

### L1 — No pagination in chat list

`db_list_chats_with_preview` loads up to 200 chats. Will scale poorly at 1000+ chats. Needs cursor-based pagination.

### L2 — Auto-title uses full streaming infrastructure

The auto-title LLM call uses the same streaming pipeline as chat. It should use a simple one-shot completion, not a streaming call with event listeners.

### L3 — No MCP tool validation

Tool `input_schema` is raw JSON passed through without validation. Invalid arguments sent to tools crash silently.

### L4 — No connection pooling for SQLite writes

All DB writes go through a 5-connection pool. Heavy concurrent writes (monitoring + chat) can queue. WAL mode helps but doesn't eliminate this.

### L5 — MCP client info hardcoded to v0.2.1

`src-tauri/src/mcp/mod.rs` sends `"version": "0.2.1"` in the MCP initialize handshake regardless of actual app version. Should read from `Cargo.toml` at compile time via `env!("CARGO_PKG_VERSION")`.

---

## Implementation Priority Order

```
Phase 1 — Foundation (data safety + testability)
  C3  DB migration framework
  H2  Tauri managed state (replace lazy_static globals)
  H4  Settings single source of truth

Phase 2 — Core domain (correctness)
  C1  Split chatStore (extract streaming pipeline + persistence service)
  C2  Context window management
  M1  Shared HTTP client

Phase 3 — Reliability
  M2  Typed errors
  M3  MCP reconnection
  M4  File size limits

Phase 4 — Security
  H1  OS keychain for API keys

Phase 5 — Polish
  H3  Provider capability abstraction
  L1  Chat list pagination
  L2  Auto-title one-shot completion
  L5  MCP version from Cargo
```

---

## Current State Summary

| Area | State |
|---|---|
| Provider abstraction | Good trait, missing capabilities |
| Streaming pipeline | Works, dangerously duplicated |
| DB persistence | Works, no migrations |
| Error handling | Opaque strings throughout |
| Security | API keys plaintext |
| State management | God object + global statics |
| Context management | None |
| MCP reliability | No reconnection |
| Testing | Zero tests |
| Performance | No HTTP pooling, no pagination |
