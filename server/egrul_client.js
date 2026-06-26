const SEARCH_URL = 'https://egrul.nalog.ru/';
const RESULT_URL = 'https://egrul.nalog.ru/search-result/';
const DOWNLOAD_URL = 'https://egrul.nalog.ru/vyp-download/';

const SEARCH_WAIT_MS = 1500;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function postSearch(query) {
    const res = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `query=${encodeURIComponent(String(query).trim())}`,
    });
    if (!res.ok) {
        throw new Error(`ЕГРЮЛ: поиск вернул HTTP ${res.status}`);
    }
    const data = await res.json();
    if (data.captchaRequired) {
        return { ok: false, error: 'ФНС запросила капчу — автоматический запрос сейчас невозможен' };
    }
    if (!data.t) {
        return { ok: false, error: 'ЕГРЮЛ: не получен токен поиска' };
    }
    return { ok: true, token: data.t };
}

async function fetchSearchRows(token) {
    await sleep(SEARCH_WAIT_MS);
    const res = await fetch(`${RESULT_URL}${token}`);
    if (!res.ok) {
        throw new Error(`ЕГРЮЛ: результаты поиска HTTP ${res.status}`);
    }
    const data = await res.json();
    return Array.isArray(data.rows) ? data.rows : [];
}

async function downloadExtract(rowToken) {
    const res = await fetch(`${DOWNLOAD_URL}${rowToken}`);
    if (!res.ok) {
        throw new Error(`ЕГРЮЛ: скачивание выписки HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) {
        throw new Error('ЕГРЮЛ: пустой файл выписки');
    }
    return buf;
}

/**
 * @param {string} inn
 * @returns {Promise<{ok:boolean, inn?:string, searchMeta?:object, pdfBuffer?:Buffer, error?:string}>}
 */
async function fetchEgrulPdfByInn(inn) {
    const normalized = String(inn || '').replace(/\D/g, '');
    if (!/^\d{10}$/.test(normalized) && !/^\d{12}$/.test(normalized)) {
        return { ok: false, inn: normalized, error: 'Некорректный ИНН (ожидается 10 или 12 цифр)' };
    }

    try {
        const search = await postSearch(normalized);
        if (!search.ok) {
            return { ok: false, inn: normalized, error: search.error };
        }

        const rows = await fetchSearchRows(search.token);
        const match =
            rows.find((r) => String(r.i || '').replace(/\D/g, '') === normalized) ||
            rows[0];

        if (!match) {
            return { ok: false, inn: normalized, error: 'В ЕГРЮЛ/ЕГРИП по ИНН ничего не найдено' };
        }

        const pdfBuffer = await downloadExtract(match.t);
        return {
            ok: true,
            inn: normalized,
            searchMeta: {
                kind: match.k || '',
                ogrn: match.o || '',
                shortName: match.c || '',
                fullName: match.n || '',
                kpp: match.p || '',
                regDate: match.r || '',
                region: match.rn || '',
            },
            pdfBuffer,
        };
    } catch (err) {
        return { ok: false, inn: normalized, error: err.message || String(err) };
    }
}

module.exports = {
    fetchEgrulPdfByInn,
    SEARCH_WAIT_MS,
};
