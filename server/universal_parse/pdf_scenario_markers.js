/** Авто-markers из текста PDF для detection (общий для API и фронта). */

function normalizeMarker(m) {
    return String(m || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function addMarker(markers, raw) {
    const s = normalizeMarker(raw);
    if (s && s.length >= 3 && !markers.includes(s)) markers.push(s);
}

/**
 * @param {string} text — полный текст страницы / clustered rows
 * @param {object} [opts]
 * @returns {string[]}
 */
function buildAutoMarkersFromText(text, opts = {}) {
    const full = String(text || '');
    const low = full.toLowerCase();
    const markers = [];

    const npf = full.match(/НПФ\s*[«"]?([^»"\n]+)/i);
    if (npf) addMarker(markers, npf[1].trim().slice(0, 48));

    const org = full.match(/(?:ООО|АО|ПАО|ЗАО)\s+[«"]?([^»"\n,]+)/i);
    if (org) addMarker(markers, org[0].trim().slice(0, 48));

    if (/северный мост/i.test(low)) addMarker(markers, 'северный мост');
    if (/\bisin\b/i.test(low)) addMarker(markers, 'isin');
    if (/счет депо|счёт депо/i.test(low)) addMarker(markers, 'счет депо');
    if (/брокерск/i.test(low)) addMarker(markers, 'брокерский отчёт');
    if (/выписка о движении/i.test(low)) addMarker(markers, 'выписка о движении');
    if (/маршрут/i.test(low)) addMarker(markers, 'маршрут');
    if (/отправител/i.test(low)) addMarker(markers, 'отправитель');
    if (/получател/i.test(low)) addMarker(markers, 'получатель');
    if (/склад/i.test(low)) addMarker(markers, 'склад');
    if (/логистик/i.test(low)) addMarker(markers, 'логистика');
    if (/инн\s*[:№]?\s*\d{10}/i.test(full)) addMarker(markers, 'инн');

    for (const h of opts.headers || []) {
        const s = String(h || '').trim();
        if (s.length >= 4 && s.length <= 32 && !/^col_\d+$/i.test(s)) {
            addMarker(markers, s);
        }
    }

    if (opts.filename) {
        const base = String(opts.filename)
            .replace(/\.[^.]+$/, '')
            .replace(/[_-]+/g, ' ')
            .trim()
            .slice(0, 32);
        if (base.length >= 4) addMarker(markers, base);
    }

    return markers.slice(0, 8);
}

/**
 * @param {object} preview — ответ pdf-grid-preview
 */
function buildAutoMarkersFromPreview(preview, opts = {}) {
    const text = (preview?.clusteredRows || preview?.items || [])
        .map((i) => i.text)
        .join('\n');
    return buildAutoMarkersFromText(text, {
        headers: preview?.headers,
        filename: opts.filename,
    });
}

function ensureMinMarkers(markers, text, opts = {}) {
    const list = (markers || []).map(normalizeMarker).filter(Boolean);
    if (list.length >= 2) return list;
    const auto = buildAutoMarkersFromText(text, opts);
    const merged = [...list];
    for (const m of auto) {
        if (!merged.includes(m)) merged.push(m);
        if (merged.length >= 8) break;
    }
    return merged.slice(0, 8);
}

module.exports = {
    normalizeMarker,
    buildAutoMarkersFromText,
    buildAutoMarkersFromPreview,
    ensureMinMarkers,
};
