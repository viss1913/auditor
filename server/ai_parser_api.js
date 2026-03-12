const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const multer = require('multer');
const xlsx = require('xlsx');

// Инициализация пула соединений
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// Настройка загрузки файлов (храним в памяти для AI)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- API ПРОЕКТОВ ---

// Получить все проекты
router.get('/projects', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM projects ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        console.error('Ошибка при получении проектов:', err);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Создать новый проект
router.post('/projects', async (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Имя проекта обязательно' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO projects (name) VALUES ($1) RETURNING *',
            [name]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Ошибка при создании проекта:', err);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// --- API ПРАВИЛ ПАРСИНГА ---

// Получить правила для проекта
router.get('/parsing-rules/:project_id', async (req, res) => {
    const { project_id } = req.params;
    try {
        const result = await pool.query(
            'SELECT * FROM parsing_rules WHERE project_id = $1 ORDER BY created_at DESC',
            [project_id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Ошибка при получении правил:', err);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Сохранить правило
router.post('/parsing-rules', async (req, res) => {
    const { project_id, source, rule_json } = req.body;

    if (!project_id || !rule_json) {
        return res.status(400).json({ error: 'project_id и rule_json обязательны' });
    }

    try {
        const result = await pool.query(
            'INSERT INTO parsing_rules (project_id, source, rule_json) VALUES ($1, $2, $3) RETURNING *',
            [project_id, source || 'UK', rule_json]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Ошибка при сохранении правила:', err);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// --- ИНТЕГРАЦИЯ QWEN (OpenRouter) ---

/**
 * Вспомогательная функция для извлечения текстового превью из Excel
 */
function getExcelPreview(buffer) {
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    // Берем первые 20 строк для примера
    const data = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' }).slice(0, 20);

    return data.map(row => row.join('\t')).join('\n');
}

// Генерировать правило на основе загруженного файла и промпта
router.post('/ai/generate-rule-from-file', upload.single('file'), async (req, res) => {
    const { prompt } = req.body;
    const file = req.file;

    if (!prompt || !file) {
        return res.status(400).json({ error: 'Необходимы prompt и файл' });
    }

    try {
        const sampleData = getExcelPreview(file.buffer);

        const sysPrompt = `Ты - эксперт по парсингу финансовых данных из Excel (банковские выписки, карточки счетов). 
Твоя задача: на основе фрагмента данных и запроса пользователя сгенерировать JSON правило для парсинга.

ВАЖНО: 
1. В "conditions" указывай ключи: "debit_account", "credit_account", "date_start", "date_end".
2. Если пользователь просит диапазон дат, используй формат "YYYY-MM-DD" для "date_start" и "date_end".
3. Если пользователь указывает счет (например "58.1"), пиши его как есть.
4. В "extract" перечисли поля: "amount", "quantity", "period", "name", "regNum".
5. Если пользователь просит назвать тип операции (например "покупка", "продажа" и т.д.), добавь ключ "operation_type" на верхнем уровне JSON.

Верни ТОЛЬКО валидный JSON без маркдауна.

Формат JSON:
{
  "conditions": {
    "debit_account": "номер_счета",
    "credit_account": "номер_счета",
    "date_start": "ГГГГ-ММ-ДД",
    "date_end": "ГГГГ-ММ-ДД"
  },
  "operation_type": "название_операции_если_указано_иначе_Умная_Операция",
  "extract": ["amount", "quantity", "period", "name"]
}
`;

        const userMsg = `Запрос пользователя: ${prompt}\n\nФрагмент данных из Excel (tab-separated):\n${sampleData}`;

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: process.env.QWEN_MODEL || 'qwen/qwen-2.5-7b-instruct',
                messages: [
                    { role: 'system', content: sysPrompt },
                    { role: 'user', content: userMsg }
                ],
                temperature: 0.1
            })
        });

        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Ошибка OpenRouter: ${response.status} ${errBody}`);
        }

        const data = await response.json();
        let content = data.choices[0].message.content.trim();
        content = content.replace(/```json/gi, '').replace(/```/g, '').trim();

        const jsonRule = JSON.parse(content);
        res.json({ rule: jsonRule, preview: sampleData });
    } catch (err) {
        console.error('Ошибка при генерации правила Qwen:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
