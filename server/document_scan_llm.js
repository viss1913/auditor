/**
 * OCR / разбор сканов (PDF и изображения без текстового слоя) через vision-модель.
 */
const { extractJsonFromLlmContent } = require('./llm_client');

const SCAN_MIN_TEXT_LINES = Number(process.env.DOCUMENT_SCAN_MIN_LINES || 8);

function isDocumentScanEnabled() {
    const v = String(process.env.DOCUMENT_SCAN_ENABLED ?? '1').trim().toLowerCase();
    return v !== '0' && v !== 'false' && v !== 'off';
}

/** PDF с нормальным текстовым слоем — сначала обычные сценарии, не vision. */
function isMachineReadablePdf(pdfProbe) {
    if (!pdfProbe) return false;
    const lines = pdfProbe.lineCount || 0;
    if (lines >= SCAN_MIN_TEXT_LINES) return true;
    if (pdfProbe.kind && pdfProbe.kind !== 'unknown' && lines > 0) return true;
    return false;
}

function isLikelyScanPdf(pdfProbe) {
    if (!pdfProbe) return false;
    const pages = pdfProbe.pageCount || 0;
    if (pages < 1) return false;
    return !isMachineReadablePdf(pdfProbe);
}

function resolveVisionModel() {
    return (
        process.env.VISION_MODEL ||
        process.env.GEMINI_MODEL ||
        'google/gemini-2.0-flash-001'
    );
}

function parseRequestedTableColumns(userMessage) {
    const t = String(userMessage || '');

    const multilineMatch = t.match(/таблиц[ауе]\s*:\s*\n([\s\S]+)/i);
    if (multilineMatch?.[1]) {
        const lines = multilineMatch[1]
            .split(/\n/)
            .map((s) => s.replace(/^[-*•\d.)]+\s*/, '').trim())
            .filter((line) => line && !/^[,;|]+$/.test(line));
        if (lines.length) return lines;
    }

    const listMatch =
        t.match(/колонк[аи][:\s]+([^\n.]+)/i) ||
        t.match(/таблиц[ауе][:\s]+([^\n.]+)/i) ||
        t.match(/(?:созда(?:ть|й)|сдела(?:ть|й)|надо\s+созда(?:ть)?|нужно\s+созда(?:ть)?)\s+таблиц[ау][:\s]+([^\n.]+)/i);
    if (listMatch?.[1]) {
        return listMatch[1]
            .split(/[,;|]/)
            .map((s) => s.trim())
            .filter(Boolean);
    }

    const known = ['№', 'Контрагент', 'Дата', 'Сумма', 'Наименование', 'НДС', 'Договор', 'ИНН'];
    const found = known.filter((k) => new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(t));
    return found.length >= 2 ? found : [];
}

function buildScanExtractionPrompt({ fileName, userMessage }) {
    const requestedColumns = parseRequestedTableColumns(userMessage);
    const columnsHint = requestedColumns.length
        ? `\nОбязательные колонки таблицы (headers и ключи в rows): ${requestedColumns.join(', ')}`
        : '';
    const strictColumnsRule = requestedColumns.length
        ? `\n- СТРОГО: headers = только [${requestedColumns.map((c) => `"${c}"`).join(', ')}], без других колонок
- СТРОГО: каждая строка rows содержит ТОЛЬКО эти ключи; если значение не найдено — пустая строка "", но ключ обязателен
- Ищи значения по всему документу (все страницы): реквизиты, шапка, «Сведения об обществе», устав, титул
- НЕ добавляй поля в fields, которых нет в списке колонок`
        : '';

    return `Ты — OCR-аудитор. Документ — скан или фото: договор, акт, счёт, накладная, протокол собрания и т.п.
На изображении МНОГО текста — прочитай его и извлеки нужные поля.
Имя файла: ${fileName || 'document'}

Задача пользователя:
${userMessage || 'Извлеки реквизиты и табличные данные в структурированный вид.'}
${columnsHint}

Верни ТОЛЬКО JSON (без markdown):
{
  "document_kind": "contract|upd|act|invoice|other",
  "headers": ["колонка1", "колонка2"],
  "rows": [{ "колонка1": "значение", "колонка2": "значение" }],
  "fields": { "контрагент": "...", "договор": "...", "дата": "...", "сумма": "..." },
  "full_text": "полный распознанный текст одной строкой или с \\n",
  "confidence": 0.0,
  "notes": "кратко что не удалось прочитать"
}

Правила:
- Один документ (один акт/договор/протокол) → обычно одна строка в rows
- Если пользователь перечислил колонки — используй ИМЕННО их в headers и как ключи в rows
- rows — основная таблица; если таблицы нет — одна строка из fields (только по запрошенным колонкам)
- числа и даты как в документе (не пересчитывай)
- confidence 0..1${strictColumnsRule}`;
}

function pickRowValuesForHeaders(obj, headers) {
    const out = {};
    const src = obj && typeof obj === 'object' ? obj : {};
    for (const h of headers) {
        let v = src[h];
        if (v == null) {
            const key = Object.keys(src).find((k) => k.toLowerCase() === String(h).toLowerCase());
            if (key) v = src[key];
        }
        if (v != null && String(v).trim() !== '') out[h] = String(v).trim();
    }
    return out;
}

/**
 * @param {object} extracted — результат normalizeScanExtraction
 * @param {string} [userMessage]
 */
function buildScanTableFromExtraction(extracted, userMessage = '') {
    const requestedColumns = parseRequestedTableColumns(userMessage);

    if (requestedColumns.length > 0) {
        const headers = requestedColumns;
        let rows = [];
        if (extracted.rows?.length) {
            const merged = {};
            for (const row of extracted.rows) {
                Object.assign(merged, pickRowValuesForHeaders(row, headers));
            }
            rows = [Object.fromEntries(headers.map((h) => [h, merged[h] ?? '']))];
        }
        if (!rows.length) {
            const fromFields = pickRowValuesForHeaders(extracted.fields || {}, headers);
            rows = [Object.fromEntries(headers.map((h) => [h, fromFields[h] ?? '']))];
        }
        return { headers, rows };
    }

    const headers =
        extracted.headers?.length > 0
            ? extracted.headers
            : extracted.rows?.length
              ? Object.keys(extracted.rows[0])
              : ['full_text'];
    const rows =
        extracted.rows?.length > 0
            ? extracted.rows
            : [{ full_text: extracted.fullText, ...(extracted.fields || {}) }];

    return { headers, rows };
}

function buildVisionUserContent({ buffer, mimeType, fileName, userMessage }) {
    const b64 = buffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${b64}`;
    const prompt = buildScanExtractionPrompt({ fileName, userMessage });

    if (/^image\//i.test(mimeType)) {
        return [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
        ];
    }

    return [
        { type: 'text', text: prompt },
        {
            type: 'file',
            file: {
                filename: fileName || 'document.pdf',
                file_data: dataUrl,
            },
        },
    ];
}

async function visionChatCompletion({ buffer, mimeType, fileName, userMessage }) {
    const baseUrl = (
        process.env.VISION_LLM_BASE_URL ||
        process.env.LLM_BASE_URL ||
        'https://openrouter.ai/api/v1'
    ).replace(/\/$/, '');
    const apiKey =
        process.env.VISION_API_KEY ||
        process.env.OPENROUTER_API_KEY ||
        process.env.GEMINI_API_KEY ||
        process.env.LLM_API_KEY ||
        '';
    const model = resolveVisionModel();
    const timeoutMs = Number(process.env.VISION_TIMEOUT_MS || 120000);

    const isLocalLlm =
        /localhost|127\.0\.0\.1|:11434/i.test(baseUrl) &&
        !baseUrl.includes('openrouter.ai') &&
        !baseUrl.includes('generativelanguage.googleapis.com');

    if (!apiKey && !isLocalLlm) {
        throw new Error('Для сканов нужен OPENROUTER_API_KEY или GEMINI_API_KEY (VISION_*)');
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (baseUrl.includes('openrouter')) {
        headers['HTTP-Referer'] = process.env.OPENROUTER_REFERER || 'http://localhost:5173';
        headers['X-Title'] = process.env.OPENROUTER_APP_TITLE || 'Auditor Martin';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
        response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify({
                model,
                messages: [
                    {
                        role: 'user',
                        content: buildVisionUserContent({ buffer, mimeType, fileName, userMessage }),
                    },
                ],
                temperature: 0.1,
                response_format: { type: 'json_object' },
            }),
        });
    } catch (err) {
        if (err?.name === 'AbortError') throw new Error(`Vision LLM timeout ${timeoutMs}ms`);
        throw err;
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Vision API ${response.status}: ${errBody.slice(0, 500)}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Пустой ответ vision-модели');
    return String(content).trim();
}

function normalizeScanExtraction(raw) {
    const headers = Array.isArray(raw?.headers)
        ? raw.headers.map((h) => String(h || '').trim()).filter(Boolean)
        : [];
    const rows = Array.isArray(raw?.rows)
        ? raw.rows
              .map((row) => {
                  if (!row || typeof row !== 'object') return null;
                  const out = {};
                  for (const h of headers.length ? headers : Object.keys(row)) {
                      const v = row[h];
                      if (v != null && String(v).trim() !== '') out[h] = String(v).trim();
                  }
                  return Object.keys(out).length ? out : null;
              })
              .filter(Boolean)
        : [];

    let finalHeaders = headers;
    if (!finalHeaders.length && rows.length) {
        finalHeaders = Object.keys(rows[0]);
    }

    return {
        documentKind: String(raw?.document_kind || raw?.documentKind || 'other').trim(),
        headers: finalHeaders,
        rows,
        fields: typeof raw?.fields === 'object' && raw.fields ? raw.fields : {},
        fullText: String(raw?.full_text || raw?.fullText || '').trim(),
        confidence: Number(raw?.confidence) || 0,
        notes: String(raw?.notes || '').trim(),
    };
}

async function extractScannedDocument({ buffer, mimeType, fileName, userMessage }) {
    const content = await visionChatCompletion({ buffer, mimeType, fileName, userMessage });
    const parsed = extractJsonFromLlmContent(content);
    return normalizeScanExtraction(parsed);
}

function buildTableStructurePrompt({ fileName, sectionTitle, pageHint }) {
    const isTrades = /исполненн/i.test(sectionTitle || '');
    const isEncumbered = /обремен|ограничен/i.test(sectionTitle || '');
    const colHint = isTrades
        ? 'Таблица широкая: ожидается около 28–35 колонок (все поля сделки).'
        : isEncumbered
          ? 'Таблица: ожидается около 12–14 колонок (ЦБ, на начало, на конец, планируемая позиция).'
          : '';

    return `Ты — аудитор. На странице PDF есть таблица брокерского отчёта.
Имя файла: ${fileName || 'document'}
Раздел: ${sectionTitle || 'таблица'}
${pageHint ? `Подсказка: раздел начинается примерно на странице ${pageHint}.` : ''}
${colHint}

Верни ТОЛЬКО JSON (без markdown):
{
  "headers": ["полное название колонки 1", "полонка 2"],
  "column_count": 0,
  "header_row_count": 0,
  "confidence": 0.0,
  "notes": ""
}

Правила:
- headers — плоский список ВСЕХ колонок слева направо, как в шапке таблицы
- объединяй многострочные подзаголовки в одну строку на колонку (например "На начало — Количество ЦБ")
- НЕ возвращай rows и значения ячеек — только структуру
- column_count = headers.length
- confidence 0..1`;
}

function buildStructureVisionContent({ buffer, mimeType, fileName, sectionTitle, pageHint }) {
    const b64 = buffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${b64}`;
    const prompt = buildTableStructurePrompt({ fileName, sectionTitle, pageHint });

    if (/^image\//i.test(mimeType)) {
        return [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
        ];
    }

    return [
        { type: 'text', text: prompt },
        {
            type: 'file',
            file: {
                filename: fileName || 'document.pdf',
                file_data: dataUrl,
            },
        },
    ];
}

async function visionTableStructure({ buffer, mimeType, fileName, sectionTitle, pageHint }) {
    const baseUrl = (
        process.env.VISION_LLM_BASE_URL ||
        process.env.LLM_BASE_URL ||
        'https://openrouter.ai/api/v1'
    ).replace(/\/$/, '');
    const apiKey =
        process.env.VISION_API_KEY ||
        process.env.OPENROUTER_API_KEY ||
        process.env.GEMINI_API_KEY ||
        process.env.LLM_API_KEY ||
        '';
    const model = resolveVisionModel();
    const timeoutMs = Number(process.env.VISION_TIMEOUT_MS || 120000);

    if (!apiKey) {
        throw new Error('Для vision structure нужен OPENROUTER_API_KEY или GEMINI_API_KEY');
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (baseUrl.includes('openrouter')) {
        headers['HTTP-Referer'] = process.env.OPENROUTER_REFERER || 'http://localhost:5173';
        headers['X-Title'] = process.env.OPENROUTER_APP_TITLE || 'Auditor Martin';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
        response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify({
                model,
                messages: [
                    {
                        role: 'user',
                        content: buildStructureVisionContent({
                            buffer,
                            mimeType,
                            fileName,
                            sectionTitle,
                            pageHint,
                        }),
                    },
                ],
                temperature: 0.1,
                response_format: { type: 'json_object' },
            }),
        });
    } catch (err) {
        if (err?.name === 'AbortError') throw new Error(`Vision LLM timeout ${timeoutMs}ms`);
        throw err;
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Vision API ${response.status}: ${errBody.slice(0, 500)}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Пустой ответ vision structure');

    const raw = extractJsonFromLlmContent(String(content).trim());
    const hdrs = Array.isArray(raw?.headers)
        ? raw.headers.map((h) => String(h || '').trim()).filter(Boolean)
        : [];

    return {
        headers: hdrs,
        columnCount: Number(raw?.column_count) || hdrs.length,
        headerRowCount: Number(raw?.header_row_count) || 0,
        confidence: Number(raw?.confidence) || 0,
        notes: String(raw?.notes || '').trim(),
    };
}

async function extractTableStructureFromPdf({ buffer, fileName, sectionTitle, pageHint }) {
    if (!isDocumentScanEnabled()) {
        return { headers: [], columnCount: 0, confidence: 0, notes: 'DOCUMENT_SCAN_ENABLED=0' };
    }
    try {
        return await visionTableStructure({
            buffer,
            mimeType: mimeTypeForScanFile(fileName),
            fileName,
            sectionTitle,
            pageHint,
        });
    } catch (err) {
        return { headers: [], columnCount: 0, confidence: 0, notes: err.message };
    }
}

function mimeTypeForScanFile(fileName) {
    const ext = String(fileName || '').toLowerCase().split('.').pop();
    if (ext === 'pdf') return 'application/pdf';
    if (ext === 'png') return 'image/png';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'gif') return 'image/gif';
    return 'image/jpeg';
}

function extractionToTableRows(extracted, { fileName, index, requestedHeaders = [] }) {
    const base = { source_file: fileName };
    if (index != null) base['№'] = String(index);

    let rows = [];
    if (extracted.rows?.length) {
        rows = extracted.rows.map((r) => ({ ...base, ...r }));
    } else if (extracted.fields && Object.keys(extracted.fields).length) {
        rows = [{ ...base, ...extracted.fields }];
    } else if (extracted.fullText) {
        rows = [{ ...base, full_text: extracted.fullText }];
    }

    const headers =
        requestedHeaders.length > 0
            ? [...new Set([...requestedHeaders, 'source_file'])]
            : extracted.headers?.length
              ? [...new Set([...extracted.headers, 'source_file'])]
              : rows.length
                ? [...new Set([...Object.keys(rows[0])])]
                : ['source_file'];

    return { headers, rows };
}

module.exports = {
    isDocumentScanEnabled,
    isMachineReadablePdf,
    isLikelyScanPdf,
    resolveVisionModel,
    extractScannedDocument,
    extractTableStructureFromPdf,
    mimeTypeForScanFile,
    buildScanExtractionPrompt,
    buildTableStructurePrompt,
    parseRequestedTableColumns,
    buildScanTableFromExtraction,
    extractionToTableRows,
    SCAN_MIN_TEXT_LINES,
};
