const pdf = require('pdf-parse');

const UNRELIABLE_MARKERS = [
    'сведения недостоверны',
    'результаты проверки достоверности',
    'сведения о недостоверности',
];

function normalizeSpaces(text) {
    return String(text || '')
        .replace(/\u0000/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function pickBlock(text, startLabel, stopLabels) {
    const t = String(text || '');
    const start = t.search(new RegExp(startLabel, 'i'));
    if (start < 0) return '';
    let end = t.length;
    for (const stop of stopLabels) {
        const idx = t.slice(start + startLabel.length).search(new RegExp(stop, 'i'));
        if (idx >= 0) {
            end = Math.min(end, start + startLabel.length + idx);
        }
    }
    return normalizeSpaces(t.slice(start, end));
}

function extractField(text, labelRegex, maxLen = 500) {
    const m = String(text || '').match(labelRegex);
    if (!m) return '';
    return normalizeSpaces(m[1]).slice(0, maxLen);
}

function extractFormationMethod(text) {
    const direct = extractField(
        text,
        /Способ образования\s*([^\n]+?)(?=ОГРН|Дата присвоения|Сведения|$)/i
    );
    if (direct) return direct;
    const block = pickBlock(text, 'Сведения о регистрации', [
        'Сведения о регистрирующем',
        'Сведения о лице',
        'Страница',
    ]);
    const m = block.match(/Способ образования\s*([^\n]+)/i);
    return m ? normalizeSpaces(m[1]) : '';
}

function extractAdditionalInfo(text) {
    const block = pickBlock(text, 'Дополнительные сведения', [
        'Сведения о регистрации',
        'Сведения о лице',
        'Наименование',
        'Страница',
    ]);
    if (block) return normalizeSpaces(block.replace(/^Дополнительные сведения/i, ''));
    for (const marker of UNRELIABLE_MARKERS) {
        if (text.toLowerCase().includes(marker)) return marker;
    }
    return '';
}

function resolveP7Status(text) {
    const lower = String(text || '').toLowerCase();
    const hasUnreliable = UNRELIABLE_MARKERS.some((m) => lower.includes(m));
    const hasAdditionalSection = /дополнительные сведения/i.test(text) && hasUnreliable;
    const formationMethod = extractFormationMethod(text);

    if (hasUnreliable || hasAdditionalSection) {
        return {
            code: 'unreliable',
            label: 'Дополнительные сведения / сведения недостоверны',
            needsAlert: true,
        };
    }
    if (formationMethod) {
        return {
            code: 'formation_ok',
            label: 'Способ образования',
            needsAlert: false,
        };
    }
    return {
        code: 'unknown',
        label: 'Не удалось определить',
        needsAlert: false,
    };
}

/**
 * @param {Buffer} pdfBuffer
 * @param {{ searchMeta?: object }} [opts]
 */
async function parseEgrulPdf(pdfBuffer, opts = {}) {
    const data = await pdf(pdfBuffer);
    const text = data.text || '';
    const meta = opts.searchMeta || {};

    const fullName = extractField(
        text,
        /полное наименование юридического лица\s*([^\n]+)/i
    ) || meta.fullName || '';
    const shortName =
        extractField(text, /Сокращенное наименование на русском\s*языке\s*([^\n]+)/i) ||
        meta.shortName ||
        '';
    const inn =
        extractField(text, /ИНН\s*(\d{10})/i) || meta.inn || '';
    const ogrn =
        extractField(text, /ОГРН\s*(\d{13})/i) || meta.ogrn || '';
    const address = extractField(
        text,
        /Адрес юридического лица\s*([^\n]+(?:\n[^\n]+){0,4})/i
    );
    const directorBlock = pickBlock(
        text,
        'Сведения о лице, имеющем право без доверенности',
        ['Сведения об уставном', 'Страница']
    );
    const director = extractField(
        directorBlock,
        /(?:Фамилия|Имя|Отчество|Должность)\s*([^\n]+)/i
    );

    const formationMethod = extractFormationMethod(text);
    const additionalInfo = extractAdditionalInfo(text);
    const p7 = resolveP7Status(text);
    const extractDate = extractField(text, /дата формирования выписки\s*([0-9.]+)/i);

    return {
        inn,
        ogrn,
        fullName,
        shortName,
        address,
        director,
        formationMethod,
        additionalInfo,
        p7Status: p7.label,
        p7Code: p7.code,
        needsAlert: p7.needsAlert,
        extractDate,
        pageCount: data.numpages || 0,
    };
}

module.exports = {
    parseEgrulPdf,
    resolveP7Status,
    extractFormationMethod,
    extractAdditionalInfo,
    UNRELIABLE_MARKERS,
};
