const EGRUL_INTENT_RE =
    /егрюл|егрип|выписк\w*\s+егр|провер\w*\s+контрагент|недостоверн|достоверн\w*\s+сведен/i;

const INN_RE = /\b(\d{10}|\d{12})\b/g;

/** Все доступные поля результата */
const EGRUL_FIELD_CATALOG = {
    inn: { header: 'ИНН', aliases: ['инн'] },
    ogrn: { header: 'ОГРН', aliases: ['огрн'] },
    fullName: { header: 'Полное наименование', aliases: ['полное наименование', 'наименование'] },
    shortName: { header: 'Краткое наименование', aliases: ['краткое', 'сокращ'] },
    address: { header: 'Адрес', aliases: ['адрес', 'юр адрес', 'юридический адрес'] },
    director: { header: 'Руководитель', aliases: ['руковод', 'директор', 'генеральн'] },
    formationMethod: { header: 'Способ образования', aliases: ['способ образования', 'образован'] },
    additionalInfo: { header: 'П.7 Доп. сведения', aliases: ['п.7', 'п 7', 'пункт 7', 'дополнительн', 'доп сведен'] },
    p7Status: { header: 'Статус п.7', aliases: ['статус п.7', 'статус п 7', 'п.7 статус'] },
    needsAlert: { header: 'Требует уведомления', aliases: ['уведомлен', 'алерт', 'письмо', 'email', 'e-mail'] },
    extractDate: { header: 'Дата выписки', aliases: ['дата выписки', 'дата'] },
    pdfFile: { header: 'Файл выписки (PDF)', aliases: ['pdf', 'выписк', 'файл'] },
    error: { header: 'Ошибка', aliases: ['ошибк'] },
};

const DEFAULT_FIELD_KEYS = [
    'inn',
    'ogrn',
    'fullName',
    'shortName',
    'address',
    'director',
    'formationMethod',
    'additionalInfo',
    'p7Status',
    'needsAlert',
    'extractDate',
    'pdfFile',
];

function isEgrulIntent(message) {
    return EGRUL_INTENT_RE.test(String(message || ''));
}

function extractInnsFromText(text) {
    const found = new Set();
    const s = String(text || '');
    let m;
    INN_RE.lastIndex = 0;
    while ((m = INN_RE.exec(s)) !== null) {
        found.add(m[1]);
    }
    return [...found];
}

function findInnColumn(headers) {
    const list = Array.isArray(headers) ? headers : [];
    const hit = list.find((h) => /инн/i.test(String(h)));
    return hit || null;
}

function resolveRequestedFields(message) {
    const t = String(message || '').toLowerCase();
    if (!t.trim()) return [...DEFAULT_FIELD_KEYS];

    const onlyP7 = /только\s+п\.?\s*7|пункт\s*7|недостоверн|дополнительн\w*\s+сведен/i.test(t);
    if (onlyP7) {
        return ['inn', 'fullName', 'additionalInfo', 'p7Status', 'needsAlert', 'formationMethod', 'pdfFile', 'error'];
    }

    const minimal = /только\s+инн|минимум|кратк/i.test(t);
    if (minimal) {
        return ['inn', 'fullName', 'p7Status', 'needsAlert', 'pdfFile', 'error'];
    }

    const selected = [];
    for (const [key, spec] of Object.entries(EGRUL_FIELD_CATALOG)) {
        if (spec.aliases.some((a) => t.includes(a))) {
            selected.push(key);
        }
    }

    if (!selected.length) return [...DEFAULT_FIELD_KEYS];
    if (!selected.includes('inn')) selected.unshift('inn');
    if (!selected.includes('pdfFile')) selected.push('pdfFile');
    if (!selected.includes('error')) selected.push('error');
    return [...new Set(selected)];
}

function headersForFields(fieldKeys) {
    return fieldKeys.map((k) => EGRUL_FIELD_CATALOG[k]?.header || k);
}

function rowFromParsed(parsed, fieldKeys) {
    const out = {};
    for (const key of fieldKeys) {
        const header = EGRUL_FIELD_CATALOG[key]?.header || key;
        if (key === 'needsAlert') {
            out[header] = parsed.needsAlert ? 'да' : 'нет';
        } else if (key === 'error') {
            out[header] = parsed.error || '';
        } else {
            out[header] = parsed[key] ?? '';
        }
    }
    return out;
}

module.exports = {
    isEgrulIntent,
    extractInnsFromText,
    findInnColumn,
    resolveRequestedFields,
    headersForFields,
    rowFromParsed,
    EGRUL_FIELD_CATALOG,
    DEFAULT_FIELD_KEYS,
};
