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
