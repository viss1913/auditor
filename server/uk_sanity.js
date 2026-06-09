/**
 * Проверки результата парса карточки УК (без LLM).
 * @param {Array<Object>} rows
 * @param {{ quantity_column?: number, mode?: string }} [probe]
 */
function checkUkParseSanity(rows, probe = {}) {
    const warnings = [];
    const issues = [];

    if (!rows?.length) {
        return {
            ok: false,
            warnings: ['После парса УК нет ни одной строки'],
            issues: ['empty'],
            suggestQuantityColumn: null,
        };
    }

    let balanceLikeQty = 0;
    let zeroQtyWithAmount = 0;
    let has91 = 0;

    for (const row of rows) {
        const qty = Number(row.quantity);
        const amount = Number(row.amount);
        const cr = String(row.credit_account || '');

        if (/^91/.test(cr)) has91 += 1;

        if (amount > 0 && (!qty || qty === 0)) zeroQtyWithAmount += 1;

        if (qty > 0 && amount > 0) {
            if (qty > 1_000_000 || qty / amount > 1000) {
                balanceLikeQty += 1;
            }
        }
    }

    const balanceRatio = balanceLikeQty / Math.max(rows.length, 1);
    if (balanceRatio > 0.3) {
        const msg =
            'Количество похоже на сальдо (очень большие числа), а не на штуки по сделке. Проверьте колонку «Кол.» (H/I).';
        warnings.push(msg);
        issues.push('quantity_like_balance');
    }

    if (zeroQtyWithAmount / Math.max(rows.length, 1) > 0.5) {
        warnings.push('У большинства строк amount есть, а quantity = 0 — возможно неверная колонка Кол.');
        issues.push('quantity_mostly_zero');
    }

    if (probe.has_credit_91 && has91 === 0) {
        warnings.push(
            'В файле есть проводки с Кт 91 (переоценка), но в результате их нет — проверьте фильтр счетов.'
        );
        issues.push('missing_credit_91');
    }

    let suggestQuantityColumn = null;
    if (issues.includes('quantity_like_balance')) {
        const alt = probe.quantity_options?.find((o) => o.index !== probe.quantity_column);
        suggestQuantityColumn = alt?.index ?? (probe.quantity_column === 8 ? 7 : 8);
    }

    return {
        ok: warnings.length === 0,
        warnings,
        issues,
        suggestQuantityColumn,
        stats: {
            rowCount: rows.length,
            balanceLikeQty,
            zeroQtyWithAmount,
            has91,
        },
    };
}

module.exports = { checkUkParseSanity };
