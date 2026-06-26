/**
 * Метаданные таблицы результата: многоуровневая шапка, Excel-сетка, подсказки для ИИ.
 */
const UK_OSV_DIMENSIONS = ['Фонд', 'Счёт', 'Наименование', 'Валюта'];
const UK_OSV_LAYOUT = 'uk_osv_wide';

function excelColumnLetter(index) {
    let n = index + 1;
    let s = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

function isWideMeasureHeader(header) {
    const parts = String(header || '')
        .split(' / ')
        .map((p) => p.trim())
        .filter(Boolean);
    if (parts.length !== 3) return false;
    return /^(бу|кол\.?)$/i.test(parts[2]);
}

function buildUkOsvWideMeta(headers) {
    const dimensions = UK_OSV_DIMENSIONS.filter((d) => headers.includes(d));
    const measures = headers.filter((h) => !dimensions.includes(h));
    if (!measures.length || !measures.every(isWideMeasureHeader)) return null;

    const measureGroups = measures.map((leaf) => {
        const [period, side, indicator] = leaf.split(' / ').map((p) => p.trim());
        return { leaf, period, side, indicator };
    });

    return {
        tableLayout: UK_OSV_LAYOUT,
        excelGrid: true,
        headerLevels: 3,
        dimensionColumns: dimensions,
        measureColumns: measures,
        measureGroups,
        columnLetters: headers.map((_, i) => excelColumnLetter(i)),
        aiHints: {
            structureId: 'uk_osv_58',
            scenarioId: 'uk_osv_58',
            profileId: 'uk_osv_58',
            pivot: 'bu_kol_in_columns',
            description:
                'ОСВ УК 58: дерево в Excel, в результате БУ/Кол. — уровень колонок (период / Дебет|Кредит / БУ|Кол.), не отдельные строки',
            detectSignals: [
                'title:оборотно-сальдовая ведомость по счету 58',
                'header:Показатели',
                'rows:БУ и Кол. попарно',
                'outline:дерево счёт→бумага→валюта',
            ],
            columnPattern: 'период / Дебет|Кредит / БУ|Кол.',
        },
    };
}

function inferTableMeta(headers, scenarioId, stored = null) {
    if (stored?.tableLayout && stored.tableLayout !== 'flat') {
        return {
            ...stored,
            columnLetters: stored.columnLetters || (headers || []).map((_, i) => excelColumnLetter(i)),
        };
    }
    if (scenarioId === 'uk_osv_58') {
        const meta = buildUkOsvWideMeta(headers || []);
        if (meta) return meta;
    }
    if ((headers || []).some(isWideMeasureHeader)) {
        const meta = buildUkOsvWideMeta(headers);
        if (meta) return meta;
    }
    const list = headers || [];
    return {
        tableLayout: 'flat',
        excelGrid: true,
        headerLevels: 1,
        dimensionColumns: [],
        measureColumns: list,
        columnLetters: list.map((_, i) => excelColumnLetter(i)),
        aiHints: null,
    };
}

function formatTableMetaForAi(tableMeta) {
    if (!tableMeta?.aiHints) return '';
    const h = tableMeta.aiHints;
    const lines = [
        `tableLayout=${tableMeta.tableLayout}`,
        `scenario=${h.scenarioId}`,
        `structure=${h.structureId}`,
        h.description,
    ];
    if (h.columnPattern) lines.push(`колонки: ${h.columnPattern}`);
    if (h.detectSignals?.length) lines.push(`сигналы: ${h.detectSignals.join('; ')}`);
    return lines.join('\n');
}

module.exports = {
    UK_OSV_LAYOUT,
    UK_OSV_DIMENSIONS,
    excelColumnLetter,
    isWideMeasureHeader,
    buildUkOsvWideMeta,
    inferTableMeta,
    formatTableMetaForAi,
};
