function cellText(row, col) {
    if (!row) return '';
    return String(row[col] ?? '').trim();
}

const UK_DATE_RE = /^\d{2}\.\d{2}\.\d{4}/;

/**
 * Карточка УК (58.01 / 76): даты в col A, БУ/Кол. в показателе, счета в фиксированных колонках.
 * @param {Array<Array>} data
 * @param {string} [fileName]
 */
function detectUkCard(data, fileName = '') {
    const fn = String(fileName || '').toLowerCase();
    const nameHint = /карт|58[.,]\s*0?1|ук|ценн|бумаг/i.test(fn);

    let bu58 = 0;
    let dateRows = 0;
    let kolRows = 0;
    const scanEnd = Math.min(data?.length || 0, 400);

    for (let i = 7; i < scanEnd; i++) {
        const row = data[i];
        if (!row) continue;
        if (UK_DATE_RE.test(cellText(row, 0))) dateRows++;
        if (cellText(row, 5) === 'БУ' && /^58\.0?1/.test(cellText(row, 6))) bu58++;
        if (cellText(row, 5) === 'Кол.') kolRows++;
    }

    const structureMatch = bu58 >= 2 && dateRows >= 3;
    const kolMatch = kolRows >= 2;

    let confidence = 0;
    if (structureMatch && (nameHint || kolMatch)) confidence = nameHint ? 0.99 : 0.96;
    else if (structureMatch) confidence = 0.94;
    else if (nameHint && dateRows >= 1 && bu58 >= 1) confidence = 0.92;
    else if (nameHint && dateRows >= 3) confidence = 0.88;

    return {
        isUk: confidence >= 0.88,
        confidence,
        signals: { nameHint, bu58, dateRows, kolRows, structureMatch },
    };
}

function isUkDateLabel(label) {
    const s = String(label || '').trim();
    return UK_DATE_RE.test(s);
}

module.exports = { detectUkCard, isUkDateLabel, UK_DATE_RE };
