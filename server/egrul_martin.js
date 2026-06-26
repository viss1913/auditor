const { fetchEgrulPdfByInn, SEARCH_WAIT_MS } = require('./egrul_client');
const { parseEgrulPdf } = require('./egrul_parse');
const {
    extractInnsFromText,
    findInnColumn,
    resolveRequestedFields,
    headersForFields,
    rowFromParsed,
} = require('./egrul_intent');
const { createParseSnapshotStore } = require('./parse_snapshot_store');
const { CLIENT_PREVIEW_ROWS } = require('./client_response_sanitize');
const { createEgrulBatchDir, saveEgrulPdf, getEgrulRootRelative } = require('./egrul_storage');

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function collectInnsFromSnapshot(store, snapshotId, innColumn, message) {
    const snap = await store.getSnapshot(snapshotId);
    if (!snap) {
        throw new Error('Таблица-источник не найдена');
    }
    const column = innColumn || findInnColumn(snap.headers);
    if (!column) {
        throw new Error(
            'Не нашла колонку с ИНН. Укажи в сообщении, например: «проверь по ЕГРЮЛ, колонка ИНН контрагента».'
        );
    }

    const inns = new Set();
    let page = 1;
    const limit = 500;
    while (true) {
        const batch = await store.fetchRowsPage(snapshotId, { page, limit });
        if (!batch?.rows?.length) break;
        for (const row of batch.rows) {
            const raw = String(row[column] ?? '').replace(/\D/g, '');
            if (/^\d{10}$/.test(raw) || /^\d{12}$/.test(raw)) {
                inns.add(raw);
            }
        }
        if (batch.rows.length < limit) break;
        page += 1;
    }

    if (!inns.size) {
        throw new Error(`В колонке «${column}» нет валидных ИНН (10 или 12 цифр).`);
    }
    return { inns: [...inns], column, sourceSnapshot: snap };
}

function buildAssistantMessage({ rowCount, alertCount, errors, fieldKeys, sourceLabel, pdfDir, savedPdfCount }) {
    const lines = [
        `Готово: **${rowCount}** ${rowCount === 1 ? 'контрагент' : 'контрагентов'} из ${sourceLabel}.`,
        `Колонки: ${headersForFields(fieldKeys).join(', ')}.`,
    ];
    if (savedPdfCount > 0 && pdfDir) {
        lines.push(
            `PDF выписки сохранены (**${savedPdfCount}**): \`${pdfDir}\`\nКорень хранилища: \`${getEgrulRootRelative()}/\``
        );
    }
    if (alertCount > 0) {
        lines.push(
            `⚠️ **${alertCount}** с отметкой о недостоверных сведениях (п.7) — позже можно отправить уведомление на e-mail.`
        );
    } else {
        lines.push('По п.7 критичных отметок о недостоверности не найдено.');
    }
    if (errors.length) {
        lines.push(`Ошибки (${errors.length}): ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '…' : ''}`);
    }
    lines.push('Можешь попросить другие колонки, фильтр или выгрузку — как с обычной таблицей.');
    return lines.join('\n\n');
}

/**
 * @param {import('pg').Pool} pool
 * @param {{
 *   message: string,
 *   inns?: string[],
 *   sourceSnapshotId?: number|null,
 *   innColumn?: string|null,
 *   projectId?: number|null,
 * }} opts
 */
async function runEgrulCheck(pool, opts) {
    const message = String(opts.message || '').trim();
    const store = createParseSnapshotStore(pool);
    const fieldKeys = resolveRequestedFields(message);

    let inns = Array.isArray(opts.inns) ? opts.inns.map((x) => String(x).replace(/\D/g, '')).filter(Boolean) : [];
    let sourceLabel = 'запроса в чате';

    if (!inns.length) {
        inns = extractInnsFromText(message);
    }

    if (!inns.length && opts.sourceSnapshotId) {
        const fromTable = await collectInnsFromSnapshot(
            store,
            opts.sourceSnapshotId,
            opts.innColumn,
            message
        );
        inns = fromTable.inns;
        sourceLabel = `таблицы (колонка «${fromTable.column}»)`;
    }

    inns = [...new Set(inns)];
    if (!inns.length) {
        return {
            ok: false,
            error:
                'Не нашла ИНН. Напиши их в сообщении (7707083893) или открой таблицу с колонкой ИНН и повтори: «проверь по ЕГРЮЛ».',
        };
    }

    const headers = headersForFields(fieldKeys);
    const rows = [];
    const errors = [];
    let alertCount = 0;
    let savedPdfCount = 0;
    const batch = createEgrulBatchDir();

    for (let i = 0; i < inns.length; i += 1) {
        const inn = inns[i];
        if (i > 0) await sleep(SEARCH_WAIT_MS);

        const fetched = await fetchEgrulPdfByInn(inn);
        if (!fetched.ok) {
            errors.push(`${inn}: ${fetched.error}`);
            rows.push(
                rowFromParsed(
                    {
                        inn,
                        needsAlert: false,
                        error: fetched.error,
                    },
                    fieldKeys
                )
            );
            continue;
        }

        let parsed;
        let pdfFile = '';
        try {
            const saved = saveEgrulPdf(fetched.pdfBuffer, {
                inn,
                ogrn: fetched.searchMeta?.ogrn || '',
                batchDir: batch.absDir,
            });
            pdfFile = saved.relativePath;
            savedPdfCount += 1;

            parsed = await parseEgrulPdf(fetched.pdfBuffer, { searchMeta: fetched.searchMeta });
            parsed.inn = parsed.inn || inn;
            parsed.pdfFile = pdfFile;
        } catch (err) {
            const msg = err.message || String(err);
            errors.push(`${inn}: ${msg}`);
            rows.push(
                rowFromParsed(
                    {
                        inn,
                        needsAlert: false,
                        error: `Ошибка разбора PDF: ${msg}`,
                    },
                    fieldKeys
                )
            );
            continue;
        }

        if (parsed.needsAlert) alertCount += 1;
        rows.push(rowFromParsed(parsed, fieldKeys));
    }

    const snapshotId = await store.createSnapshot({
        projectId: opts.projectId ? parseInt(opts.projectId, 10) : null,
        sourceFileName: 'ЕГРЮЛ',
        sheetName: 'Проверка контрагентов',
        scenarioId: 'egrul_check',
        headers,
        tableMeta: {
            kind: 'egrul_check',
            fieldKeys,
            sourceLabel,
            requestedInns: inns,
            egrulPdfDir: batch.relativeDir,
            egrulPdfRoot: getEgrulRootRelative(),
        },
        status: 'parsing',
    });

    await store.importParsedRows(snapshotId, headers, rows, {
        kind: 'egrul_check',
        fieldKeys,
        sourceLabel,
        requestedInns: inns,
        egrulPdfDir: batch.relativeDir,
        egrulPdfRoot: getEgrulRootRelative(),
        snapshotId,
    });

    const previewRows = rows.slice(0, CLIENT_PREVIEW_ROWS);
    const assistantMessage = buildAssistantMessage({
        rowCount: rows.length,
        alertCount,
        errors,
        fieldKeys,
        sourceLabel,
        pdfDir: batch.relativeDir,
        savedPdfCount,
    });

    return {
        ok: true,
        snapshotId,
        scenarioId: 'egrul_check',
        sourceFileName: 'ЕГРЮЛ',
        egrulPdfDir: batch.relativeDir,
        egrulPdfRoot: getEgrulRootRelative(),
        savedPdfCount,
        parsePreview: {
            ok: true,
            headers,
            rows: previewRows,
            rowCount: rows.length,
        },
        assistantMessage,
        stats: {
            total: rows.length,
            alerts: alertCount,
            errors: errors.length,
        },
        errors,
    };
}

module.exports = {
    runEgrulCheck,
    collectInnsFromSnapshot,
};
