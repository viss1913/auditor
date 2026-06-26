/**
 * Якоря разделов брокерского PDF — без ложных срабатываний на сносках.
 */

const SECTION_DEFS = [
    {
        id: 'assets',
        label: 'Справка о стоимости активов',
        patterns: [/Справка\s+о\s+стоимости\s+активов/i],
        messageHints: [/стоимост[а-яё]*\s+актив/i, /справка\s+о\s+стоимости/i],
    },
    {
        id: 'encumbered',
        label: 'Обременённые и/или ограниченные в распоряжении ЦБ',
        patterns: [/Обремененн/i, /ограниченн\w*\s+в\s+распоряжен/i],
        messageHints: [/обремен/i, /ограниченн[а-яё]*.*ценн/i],
    },
    {
        id: 'reserved',
        label: 'ЦБ зарезервированные для торгов',
        patterns: [/ЦБ\s+зарезервированн/i, /зарезервированн\w*\s+для\s+торгов/i],
        messageHints: [/зарезервирован/i, /организатор.*торгов/i],
    },
    {
        id: 'repo',
        label: 'Реестр РЕПО/СВОП',
        patterns: [/Реестр\s+сделок\s+РЕПО/i, /РЕПО\s*\/\s*СВОП/i],
        messageHints: [/репо/i, /своп/i, /реестр\s+сделок/i],
    },
    {
        id: 'trades',
        label: 'Исполненные сделки',
        patterns: [/Исполненные\s+сделки/i],
        messageHints: [/исполненн[а-яё]*\s+сделк/i],
    },
    {
        id: 'operations',
        label: 'Отчет об операциях с активами клиента',
        patterns: [/Отчет\s+об\s+операциях\s+с\s+активами/i],
        messageHints: [/операци[яи].*актив/i, /оплата\s+услуг/i],
    },
];

function isSectionAnchorRow(line, def) {
    const t = String(line || '').trim();
    if (!t || t.length > 180) return false;
    if (
        /^\d{1,2}\s+(Не включают|Включают|Цена указана|По курсу|Сделка|Информация|В тексте|Для акций|Справочная|Если расчетная|Сведения|База начисления|В случае|Cимвол)/i.test(
            t
        )
    ) {
        return false;
    }
    if (/^\d{1,2}\s/.test(t) && t.length > 60) return false;
    if (def.id === 'reserved' && /денежн\w*\s+средств/i.test(t) && !/ЦБ\s+зарезервированн/i.test(t)) {
        return false;
    }
    return def.patterns.some((re) => re.test(t));
}

function findSectionAnchorStarts(lines) {
    const starts = [];
    for (let i = 0; i < lines.length; i++) {
        const line = String(lines[i] || '');
        for (const def of SECTION_DEFS) {
            if (isSectionAnchorRow(line, def)) {
                starts.push({ index: i, def });
                break;
            }
        }
    }
    starts.sort((a, b) => a.index - b.index);
    const deduped = [];
    const seen = new Set();
    for (const s of starts) {
        if (seen.has(s.def.id)) continue;
        seen.add(s.def.id);
        deduped.push(s);
    }
    return deduped;
}

module.exports = {
    SECTION_DEFS,
    isSectionAnchorRow,
    findSectionAnchorStarts,
};
