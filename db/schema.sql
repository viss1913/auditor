-- Схема для аудита сделок
CREATE TABLE IF NOT EXISTS trades (
    id SERIAL PRIMARY KEY,
    period DATE,
    security_name TEXT,
    reg_number TEXT,
    isin TEXT,
    quantity NUMERIC(20, 10),
    amount NUMERIC(20, 2),
    debit_account TEXT,
    credit_account TEXT,
    source TEXT DEFAULT 'UK', -- 'UK', 'Broker', 'DEPO'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Индексы для быстрого поиска
CREATE INDEX IF NOT EXISTS idx_trades_period ON trades(period);
CREATE INDEX IF NOT EXISTS idx_trades_reg_number ON trades(reg_number);

-- Martin: снимки разбора Excel (большие таблицы)
CREATE TABLE IF NOT EXISTS parse_snapshots (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    source_file_name TEXT,
    sheet_name TEXT,
    scenario_id TEXT,
    rule_id INTEGER,
    headers JSONB NOT NULL DEFAULT '[]'::jsonb,
    row_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'parsing',
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS parsed_rows (
    id BIGSERIAL PRIMARY KEY,
    snapshot_id INTEGER NOT NULL REFERENCES parse_snapshots(id) ON DELETE CASCADE,
    row_index INTEGER NOT NULL,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (snapshot_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_parsed_rows_snapshot ON parsed_rows(snapshot_id);

CREATE TABLE IF NOT EXISTS table_operations (
    id SERIAL PRIMARY KEY,
    snapshot_id INTEGER REFERENCES parse_snapshots(id) ON DELETE CASCADE,
    message TEXT,
    command_json JSONB,
    rows_affected INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS table_recipes (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    recipe_json JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_sessions (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'Новый чат',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_session_snapshots (
    id SERIAL PRIMARY KEY,
    chat_session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    snapshot_id INTEGER NOT NULL REFERENCES parse_snapshots(id) ON DELETE CASCADE,
    label TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    removed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (chat_session_id, snapshot_id)
);

CREATE TABLE IF NOT EXISTS chat_history (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    chat_session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
    snapshot_id INTEGER REFERENCES parse_snapshots(id) ON DELETE SET NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
