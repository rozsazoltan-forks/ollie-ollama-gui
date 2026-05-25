# Design: File Attachments Cleanup, Keyboard Shortcuts, Export

**Date:** 2026-05-25  
**Status:** Approved

---

## 1. File Attachments — Clean Storage (Option B)

### Problem

`MainPanel.tsx` line 114 injects raw file content directly into the message string before sending:

```
\n\n--- File: name ---\n${content}\n---------------------\n
```

This means the full file text is stored in `messages.content` in SQLite and rendered verbatim in the chat bubble, making conversations unreadably long.

### Solution

Store file metadata in `meta_json` (same pattern as `images`). Send file content to the LLM in the API payload only — never in the persisted message content.

### Data Model

`ChatMessage` interface gains:

```ts
files?: { name: string; content: string }[]
```

`meta_json` schema (already flexible JSON, no migration needed):

```json
{
  "images": ["base64..."],
  "files": [{ "name": "Cargo.toml", "content": "..." }]
}
```

### Changes

**`app/src/store/chatStore.ts`**
- `ChatMessage.files?: { name: string; content: string }[]`
- `sendMessage(content, options, images, files?)` — new param
- When building API messages: append file blocks to the LLM payload string (not to stored content):
  ```
  ${userText}\n\n--- File: name ---\n${fileContent}\n---
  ```
- `db_append_message`: serialize `{ images, files }` into `metaJson`
- `loadMessages`: deserialize `meta_json` → populate `msg.files`
- Same changes in `editUserMessage`

**`app/src/components/MainPanel.tsx`**
- Remove file content injection from `handleSendMessage`
- Pass `files` array separately to `sendMessage`

**`app/src/components/Message.tsx`**
- Render `message.files` as collapsible chips above message text
- Chip: file icon + filename + expand/collapse toggle
- Expanded: scrollable `<pre>` block, max 300px height

### Error Handling

- File read failure already handled in MainPanel (try/catch per file)
- Malformed `meta_json` already silently ignored (existing try/catch)

---

## 2. Keyboard Shortcuts

### Shortcuts

| Keys | Action |
|---|---|
| `Ctrl+N` | New chat (`chatStore.createChat`) |
| `Ctrl+K` | Focus model picker (trigger dropdown open) |
| `Ctrl+/` | Focus message textarea |
| `Ctrl+B` | Toggle sidebar (`uiStore.toggleSidebar` or equivalent) |

Skip if focus is inside `<input>` or `<textarea>` (except `Ctrl+/` which always works, and `Ctrl+N` which always works).

### Implementation

**`app/src/lib/shortcuts.ts`** — currently empty, add:

```ts
export function useKeyboardShortcuts(handlers: {
  onNewChat: () => void
  onFocusModelPicker: () => void
  onFocusInput: () => void
  onToggleSidebar: () => void
}) { ... }
```

Single `useEffect` with `keydown` listener on `window`. Cleanup on unmount.

**`app/src/App.tsx`** (or root layout component) — invoke the hook, wire handlers to existing store actions.

No new UI needed. Shortcuts work silently.

---

## 3. Export Conversation — Markdown

### Trigger

Download icon button in the chat header (top-right area, next to existing controls). Only visible when a chat is active and has messages.

### Output Format

Filename: `{chat-title or "chat"}-{YYYY-MM-DD}.md`

```markdown
# {Chat Title}

**Model:** {model name}  
**Date:** {YYYY-MM-DD}

---

**You:** {message content}

**Assistant:** {message content}

---
```

File attachments rendered as a note under the user message:
```
> 📎 File: Cargo.toml
```

Images noted as:
```
> 🖼️ Image attached
```

### Implementation

Pure frontend — no backend command needed.

```ts
function exportChatAsMarkdown(title, model, messages): void {
  const md = buildMarkdown(title, model, messages)
  const blob = new Blob([md], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${slug}-${date}.md`
  a.click()
  URL.revokeObjectURL(url)
}
```

Lives in `app/src/lib/export.ts` (new file).

Button wired in `app/src/components/MainPanel.tsx` or the chat header component.

---

## Scope

Out of scope for this iteration:
- JSON export
- PDF export
- Import from ChatGPT/Claude
- Image/SVG artifact download

---

## File Touch List

| File | Change |
|---|---|
| `app/src/store/chatStore.ts` | Add `files` to `ChatMessage`, `sendMessage`, load/save |
| `app/src/components/MainPanel.tsx` | Remove injection, pass files separately, add export button |
| `app/src/components/Message.tsx` | Render file chips |
| `app/src/lib/shortcuts.ts` | Implement `useKeyboardShortcuts` |
| `app/src/App.tsx` | Wire shortcuts hook |
| `app/src/lib/export.ts` | New — `exportChatAsMarkdown` |
