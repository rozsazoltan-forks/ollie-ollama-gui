CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    model TEXT,
    system_prompt TEXT,
    params_json TEXT,
    title TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    meta_json TEXT,
    FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
);
