/**
 * Диагностика качества grid-парса PDF.
 */

function diagnoseGridExtract(result, expectedColumnCount) {
    const headers = result?.headers || [];
    const rows = result?.rows || [];
    const colCount = headers.length;
    const expected = expectedColumnCount || colCount;

    const emptyByCol = headers.map((h, idx) => {
        const key = typeof h === 'string' ? h : `col_${idx + 1}`;
        let empty = 0;
        for (const row of rows) {
            const v = row?.[key] ?? row?.[headers[idx]];
            if (v == null || String(v).trim() === '') empty++;
        }
        const ratio = rows.length ? empty / rows.length : 1;
        return { index: idx, header: headers[idx], emptyRatio: ratio };
    });

    const suspiciousCols = emptyByCol.filter((c) => c.emptyRatio > 0.6);
    const colCountMismatch = expected > 0 && colCount !== expected;

    let confidence = result?.confidence ?? 0.5;
    if (colCountMismatch) confidence *= 0.6;
    if (suspiciousCols.length > Math.max(1, colCount * 0.3)) confidence *= 0.7;
    if (!rows.length) confidence = 0;

    const issues = [];
    if (colCountMismatch) {
        issues.push({
            code: 'column_count_mismatch',
            message: `Ожидали ${expected} колонок, нашли ${colCount}`,
        });
    }
    for (const col of suspiciousCols.slice(0, 5)) {
        issues.push({
            code: 'empty_column',
            message: `Колонка «${col.header}»: ${Math.round(col.emptyRatio * 100)}% пустых ячеек`,
            columnIndex: col.index,
        });
    }

    return {
        confidence: Math.max(0, Math.min(1, confidence)),
        columnCount: colCount,
        expectedColumnCount: expected,
        emptyByCol,
        suspiciousCols,
        issues,
    };
}

module.exports = { diagnoseGridExtract };
