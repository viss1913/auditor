/**
 * Разбор секции брокерского Excel (1.1 / 1.2) из фразы аудитора.
 */
const BROKER_SECTION_META = {
    '1.1': {
        id: '1.1',
        label: 'Сделки, обязательства из которых прекращены',
        shortLabel: '1.1 — прекращённые обязательства',
    },
    '1.2': {
        id: '1.2',
        label: 'Сделки, обязательства из которых не исполнены',
        shortLabel: '1.2 — неисполненные обязательства',
    },
};

const DEFAULT_BROKER_SECTION = '1.2';

function sectionMeta(sectionId) {
    return BROKER_SECTION_META[sectionId] || BROKER_SECTION_META[DEFAULT_BROKER_SECTION];
}

function hasSectionMarker(text, sectionId) {
    const t = String(text || '').toLowerCase();
    if (sectionId === '1.1') {
        return /\b1\s*[\.\-]\s*1\b/.test(t) || /\bраздел\s+1\.1\b/.test(t);
    }
    return /\b1\s*[\.\-]\s*2\b/.test(t) || /\bраздел\s+1\.2\b/.test(t);
}

/**
 * @returns {{ brokerSection: '1.1'|'1.2', confidence: number, source: string, label: string }}
 */
function resolveBrokerSectionFromMessage(userText, options = {}) {
    const raw = String(userText || '').trim();
    const t = raw.toLowerCase();
    const fallback = options.defaultSection || DEFAULT_BROKER_SECTION;

    if (!t) {
        const meta = sectionMeta(fallback);
        return {
            brokerSection: fallback,
            confidence: 0.65,
            source: 'default',
            label: meta.label,
            shortLabel: meta.shortLabel,
        };
    }

    const explicit11 = hasSectionMarker(t, '1.1');
    const explicit12 = hasSectionMarker(t, '1.2');

    const semantic12 =
        /не\s*исполн|неисполнен|ожидающ|обязательств\w*\s+из\s+которых\s+не\s*исполн/i.test(t);
    const semantic11 =
        /прекращ|обязательств\w*\s+из\s+которых\s+прекращ/i.test(t) ||
        (/исполненн/i.test(t) && !/не\s*исполн|неисполнен/i.test(t));

    if (explicit12 && !explicit11) {
        const meta = sectionMeta('1.2');
        return { brokerSection: '1.2', confidence: 0.96, source: 'marker', label: meta.label, shortLabel: meta.shortLabel };
    }
    if (explicit11 && !explicit12) {
        const meta = sectionMeta('1.1');
        return { brokerSection: '1.1', confidence: 0.96, source: 'marker', label: meta.label, shortLabel: meta.shortLabel };
    }
    if (semantic12 && !semantic11) {
        const meta = sectionMeta('1.2');
        return { brokerSection: '1.2', confidence: 0.9, source: 'semantic', label: meta.label, shortLabel: meta.shortLabel };
    }
    if (semantic11 && !semantic12) {
        const meta = sectionMeta('1.1');
        return { brokerSection: '1.1', confidence: 0.88, source: 'semantic', label: meta.label, shortLabel: meta.shortLabel };
    }
    if (explicit12 && explicit11) {
        const last11 = t.lastIndexOf('1.1');
        const last12 = t.lastIndexOf('1.2');
        const picked = last12 > last11 ? '1.2' : '1.1';
        const meta = sectionMeta(picked);
        return {
            brokerSection: picked,
            confidence: 0.75,
            source: 'marker_ambiguous',
            label: meta.label,
            shortLabel: meta.shortLabel,
        };
    }

    const meta = sectionMeta(fallback);
    return {
        brokerSection: fallback,
        confidence: 0.72,
        source: 'default',
        label: meta.label,
        shortLabel: meta.shortLabel,
    };
}

module.exports = {
    BROKER_SECTION_META,
    DEFAULT_BROKER_SECTION,
    sectionMeta,
    resolveBrokerSectionFromMessage,
    hasSectionMarker,
};
