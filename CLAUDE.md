# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**Ollie** is a local-first desktop AI assistant for Linux built with Tauri v2 (Rust backend) + React 19 (TypeScript frontend). It supports local LLMs via Ollama and cloud providers (OpenAI, Anthropic, Google Gemini, GroqCloud).

## Commands

### Development

```bash
# Start full dev environment (Tauri launches Vite automatically)
cargo tauri dev

# Frontend only (from app/)
cd app && npm run dev

# Build for production
cargo tauri build
```

### Frontend (from `app/`)

```bash
npm run lint       # ESLint
npm run build      # tsc + vite build
```

### Backend (Rust)

```bash
cargo check        # Type-check without building
cargo clippy       # Lints
cargo test         # Run tests
```

## Architecture

### Monorepo Structure

- `app/` — React 19 + TypeScript frontend (Vite)
- `src-tauri/` — Rust backend (Tauri v2)

### Communication (IPC)

Frontend calls backend via `invoke('command_name', args)`. Real-time streaming uses Tauri events:
- `chat-chunk` — streaming token
- `chat-error` — stream error  
- `chat-complete` — stream finished
- `chat:stream-start` — stream ID assigned
- `chat:cancelled` — stream cancelled

### Backend Layout (`src-tauri/src/`)

- `commands/` — Tauri command handlers: `chat.rs`, `models.rs`, `db.rs`, `settings.rs`, `monitoring.rs`, `sys.rs`, `mcp.rs`
- `providers/` — Multi-provider abstraction: `traits.rs` defines `LLMProvider` trait; `orchestrator.rs` routes to `ollama.rs`, `openai.rs`, `anthropic.rs`, `google.rs`
- `db/` — SQLite connection pool + schema (WAL mode; tables: `chats`, `messages`)
- `mcp/` — Model Context Protocol: `protocol.rs` (message types), `transport.rs` (stdio/SSE)

### Frontend Layout (`app/src/`)

- `store/` — Zustand stores: `chatStore.ts`, `settingsStore.ts`, `modelsStore.ts`, `monitoringStore.ts`, `mcpStore.ts`, `uiStore.ts`, `setupStore.ts`
- `components/` — React UI components
- `routes/` — Page components: `chat.tsx`, `models.tsx`, `settings.tsx`
- `lib/` — Utilities: `markdown.tsx` (rehype pipeline), `pdf.ts`, `shortcuts.ts` (keyboard hook), `export.ts` (Markdown download), `hooks.ts`
- `types/` — TypeScript interfaces

### Key Patterns

- **View routing**: No router library — `uiStore.view` controls which page renders (`chat | models | settings | monitoring`)
- **Provider config**: `ProviderConfig` (id, name, type, credentials, base_url) stored in settings; `ChatOrchestrator` selects provider at runtime
- **Database path**: `~/.config/ollie/app.db`
- **Settings path**: `~/.config/ollie/settings.json` (atomic write: temp file + rename)
- **Streaming cancellation**: `Arc<AtomicBool>` cancel tokens per stream ID; frontend calls `chat_cancel({ streamId })` or omits streamId to cancel all
- **Cancellation ordering**: store with `Ordering::Release`, load with `Ordering::Acquire`
- **Backend results**: Rust commands return `Result<T, String>`; errors propagate as strings to frontend
- **Drip queue**: `chatStore` buffers streaming tokens and releases them at 30ms intervals for smooth animation; on cancel, pending text is discarded (not flushed)
- **File attachments**: Files stored in `meta_json` as `{ files: [{ name, content }] }` (same field as `images`). File content is injected into LLM payload via `buildLlmContent()` helper but never stored in `messages.content`. Rendered as collapsible chips in `Message.tsx`.
- **Sidebar queries**: Uses `db_list_chats_with_preview` (single correlated subquery) — no N+1 fetching
- **Provider persistence**: `settingsStore` uses Zustand `partialize` to exclude provider credentials from localStorage
- **Keyboard shortcuts**: `useKeyboardShortcuts` hook in `lib/shortcuts.ts` — `Ctrl+N` new chat, `Ctrl+K` model picker, `Ctrl+/` focus input, `Ctrl+B` toggle sidebar. Uses `useRef` pattern (single stable listener).
- **Model picker event**: `ModelSelector` listens for `ollie:focus-model-picker` custom window event to open its dropdown
- **Markdown export**: `exportChatAsMarkdown()` in `lib/export.ts` — Blob + anchor click download
- **Monitoring**: Real sysinfo data (CPU, memory, disk, network via `Disks`/`Networks`); Ollama uptime via process lookup; model memory from `/api/ps`
- **WebKit EGL fix**: `WEBKIT_DISABLE_DMABUF_RENDERER=1` set in `main.rs` before `run()` to prevent EGL crashes on Ubuntu 26.04+
- **CSP**: Set in `tauri.conf.json` — `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src ipc: http://ipc.localhost`
- **MCP timeout**: `send_request` has 30s timeout via `tokio::time::timeout`
- **SQLite busy timeout**: `PRAGMA busy_timeout=5000` set on pool connection

### Adding a New Provider

1. Implement `LLMProvider` trait in `src-tauri/src/providers/`
2. Add variant to `ProviderType` enum in `providers/mod.rs`
3. Register in `orchestrator.rs`
4. Add frontend UI in settings store/components
5. Use `x-goog-api-key` header pattern (not query param) for API keys — see `google.rs`
