const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { probePdfKind, detectBrokerSubtype } = require('./pdf_probe');
const {
    extractBrokerPdfSectionTables,
    shouldUseMultiTableBrokerParse,
} = require('./universal_parse/pdf_broker_sections');
const { extractRuAmounts, parseAtonReservedLine, parseAtonEncumberedLine, parseGluedAssetsLine, parseAtonReportHeader, applyAtonReportHeader, ATON_REPORT_HEADER_COLS, H, parseOperationsLine, parseAtonRuAmount, parseAtonCashOperationsGridRow } = require('./universal_parse/aton_broker_extract');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'broker_aton');
const OCTOBER = path.join(FIXTURE_DIR, 'client_24951000_01.10.2025_to_31.10.2025.pdf');
const DECEMBER_SHORT = path.join(FIXTURE_DIR, 'client_24940000_01.12.2025_to_31.12.2025.pdf');
const Q4 = path.join(FIXTURE_DIR, 'client_24951000_01.10.2025_to_31.12.2025.pdf');

describe('aton_broker_extract', () => {
    it('extractRuAmounts: склеенные суммы после RUR', () => {
        const amounts = extractRuAmounts('201 974 862,19201 974 862,192 680 487 575,342 680 487 575,34');
        assert.equal(amounts.length, 4);
        assert.equal(amounts[0], '201 974 862,19');
    });

    it('parseAtonReservedLine: позиция с ПАО', () => {
        const row = parseAtonReservedLine(
            'ПАО Московская Биржа, Фондовый рынокИНТЕР РАО ЕЭС4(C)/RU000A0JPNM1/1-04-33498-E66 499 40066 499 4003,015200 495 691,00     0'
        );
        assert.ok(row);
        assert.ok(row['ЦБ (эмитент / ISIN / код гос. регистрации)'].includes('RU000A0JPNM1'));
        assert.ok(row['Организатор торговли'].includes('ПАО'));
    });

    it('parseAtonEncumberedLine: ВТБ без склейки количества в название', () => {
        const row = parseAtonEncumberedLine(
            'ВТБ(1/10000)(C)/RU000A0JP5V6/10401000B3 408 3 408 3 408'
        );
        assert.ok(row);
        assert.equal(
            row['ЦБ (эмитент / ISIN / код гос. регистрации)'],
            'ВТБ(1/10000)(C)/RU000A0JP5V6/10401000B'
        );
        assert.equal(row['Количество ЦБ (на начало)'], '3 408');
        assert.equal(row['Количество ЦБ (на конец)'], '3 408');
    });

    it('parseAtonEncumberedLine: строка с RUR — чистое имя и суммы', () => {
        const row = parseAtonEncumberedLine(
            'ВТБ(C)/RU000A0JP5V6/10401000B3 275 73,11239 435,25RUR3 275 72,34236 913,50RUR3 275'
        );
        assert.ok(row);
        assert.equal(row['ЦБ (эмитент / ISIN / код гос. регистрации)'], 'ВТБ(C)/RU000A0JP5V6/10401000B');
        assert.equal(row['Количество ЦБ (на начало)'], '3 275');
        assert.equal(row['В рублях (на начало)'], '239 435,25');
        assert.equal(row['Количество ЦБ (на конец)'], '3 275');
        assert.equal(row['В рублях (на конец)'], '236 913,50');
    });

    it('заголовки как в PDF', () => {
        assert.equal(H.assets[0], 'Показатель');
        assert.equal(H.trades[0], '№ п/п');
    });

    it('parseAtonRuAmount: без ведущих нулей и как number', () => {
        assert.equal(parseAtonRuAmount('096 958 880,00'), 96958880);
        assert.equal(parseAtonRuAmount('-96 958 880,00'), -96958880);
        assert.equal(parseAtonRuAmount('150 000 000,00'), 150000000);
    });

    it('parseOperationsLine: REPO компенсация без RUR в описании', () => {
        const row = parseOperationsLine(
            '3624.12.2524.12.25Компенсация дивидендного дохода по сделке РЕПО (mcxs1504876654521)RUR96 958 880,0096 958 880,0024951000'
        );
        assert.ok(row);
        assert.equal(
            row['Описание операции'],
            'Компенсация дивидендного дохода по сделке РЕПО (mcxs1504876654521)'
        );
        assert.equal(row['Сумма, руб.'], 96958880);
        assert.equal(row['Портфель'], '24951000');
    });

    it('parseAtonCashOperationsGridRow: отделяет описание от RUR и суммы', () => {
        const row = parseAtonCashOperationsGridRow({
            items: [
                { text: '36', x: 38.7 },
                { text: '24.12.25', x: 75.0 },
                { text: '24.12.25', x: 141.2 },
                {
                    text: 'Компенсация дивидендного дохода по сделке РЕПО (mcxs1504876654521)',
                    x: 189.4,
                },
                { text: 'RUR', x: 603.6 },
                { text: '96 958 880,00', x: 657.5 },
                { text: '96 958 880,00', x: 727.2 },
                { text: '24951000', x: 777.0 },
            ],
        });
        assert.ok(row);
        assert.equal(
            row['Описание операции'],
            'Компенсация дивидендного дохода по сделке РЕПО (mcxs1504876654521)'
        );
        assert.equal(row['Сумма, руб.'], 96958880);
    });

    it('parseGluedAssetsLine: подпись склеена с RUR', () => {
        const glued = parseGluedAssetsLine(
            'Доступно средств для заключения сделокRUR433 290,21433 290,21433 183,49433 183,49'
        );
        assert.ok(glued);
        assert.equal(glued.label, 'Доступно средств для заключения сделок');
        assert.equal(glued.currency, 'RUR');
        assert.equal(glued.amounts[0], '433 290,21');
    });

    it('parseAtonReportHeader: ClnBIS No → № в договоре', () => {
        const meta = parseAtonReportHeader([
            'Номер брокерского счета клиента20200000',
            'Договор о брокерском обслуживанииNo 20200000 от 11.09.2024',
            'Дата составления отчета01.11.2025',
        ]);
        assert.equal(meta.ok, true);
        assert.equal(meta.account, '20200000');
        assert.equal(meta.contract, '№ 20200000 от 11.09.2024');
        assert.equal(meta.reportDate, '01.11.2025');
    });

    it('parseAtonReportHeader: шапка из pdf-parse', () => {
        const lines = [
            'Номер брокерского счета клиента24940000',
            'Договор о брокерском обслуживанииNo 24940000 от 16.10.2020',
            'Дата составления отчета13.01.2026',
        ];
        const meta = parseAtonReportHeader(lines);
        assert.equal(meta.ok, true);
        assert.equal(meta.account, '24940000');
        assert.equal(meta.contract, '№ 24940000 от 16.10.2020');
        assert.equal(meta.reportDate, '13.01.2026');
    });

    it('applyAtonReportHeader: мета-колонки в начале каждой строки', () => {
        const meta = parseAtonReportHeader([
            'Номер брокерского счета клиента24951000',
            'Договор о брокерском обслуживанииNo 24951000 от 21.10.2020',
            'Дата составления отчета29.12.2025',
        ]);
        const { headers, rows } = applyAtonReportHeader(
            ['Показатель', 'Валюта'],
            [{ Показатель: 'Рыночная стоимость активов', Валюта: 'CNY' }],
            meta
        );
        assert.deepEqual(headers.slice(0, 3), Object.values(ATON_REPORT_HEADER_COLS));
        assert.equal(rows[0][ATON_REPORT_HEADER_COLS.account], '24951000');
        assert.equal(rows[0][ATON_REPORT_HEADER_COLS.contract], '№ 24951000 от 21.10.2020');
        assert.equal(rows[0][ATON_REPORT_HEADER_COLS.reportDate], '29.12.2025');
        assert.equal(rows[0].Показатель, 'Рыночная стоимость активов');
    });
});

describe('aton broker PDF fixtures', () => {
    it('октябрьский отчёт: ≥2 таблицы, reserved + trades', async () => {
        assert.ok(fs.existsSync(OCTOBER), `fixture missing: ${OCTOBER}`);
        const buf = fs.readFileSync(OCTOBER);
        const probe = await probePdfKind(buf, path.basename(OCTOBER));
        assert.equal(probe.brokerSubtype, 'aton');
        assert.equal(probe.kind, 'broker_report');

        const sections = await extractBrokerPdfSectionTables(probe.lines, '', {
            brokerSubtype: 'aton',
            pdfBuffer: buf,
        });
        const byId = Object.fromEntries(sections.map((s) => [s.id, s]));

        assert.ok(sections.length >= 2);
        assert.ok(byId.reserved?.rows.length >= 1, 'reserved rows');
        assert.ok(byId.trades?.rows.length >= 1, 'trades rows');
        assert.ok(byId.reserved?.headers.includes('Организатор торговли') || /pdfjs_grid/.test(byId.reserved?.method || ''));
        assert.ok(
            byId.trades?.headers.some((h) => /сделк|сумм/i.test(String(h))) ||
                /pdfjs_grid/.test(byId.trades?.method || ''),
            `trades headers from PDF: ${JSON.stringify(byId.trades?.headers?.slice(0, 3))}`,
        );
        assert.ok(byId.trades?.rows.length >= 150, 'trades rows');
        assert.match(byId.trades?.method || '', /aton_trades_grid|pdfjs_grid/);
        assert.ok(byId.trades?.headers.length >= 21, `trades cols: ${byId.trades?.headers.length}`);
        assert.ok(!byId.trades?.headers.some((h) => /^col_22$/i.test(String(h))), 'no col_22 tail');
        assert.equal(shouldUseMultiTableBrokerParse(sections, ''), true);
    });

    it('Q4 2025: aton_trades_grid — строка 1 по полям', async () => {
        const pdfPath = fs.existsSync(Q4) ? Q4 : null;
        assert.ok(pdfPath, `fixture missing: ${Q4}`);
        const buf = fs.readFileSync(pdfPath);
        const probe = await probePdfKind(buf, path.basename(pdfPath));
        const sections = await extractBrokerPdfSectionTables(probe.lines, '', {
            brokerSubtype: 'aton',
            pdfBuffer: buf,
        });
        const trades = sections.find((s) => s.id === 'trades');
        assert.ok(trades?.rows?.length >= 200, `trades rows: ${trades?.rows?.length}`);
        assert.match(trades.method || '', /aton_trades_grid/);
        assert.ok(!trades.headers.some((h) => /^col_22$/i.test(String(h))));

        const col = (re) => trades.headers.find((h) => re.test(String(h)));
        const first = trades.rows[0];

        assert.match(String(first[col(/организатор/i)] || ''), /Московская.*Биржа.*рынок/i);
        assert.match(String(first[col(/№ сделк/i)] || ''), /mcxs143043507/i);
        assert.match(String(first[col(/№ сделк/i)] || ''), /26\.09\.25/);
        assert.match(String(first[col(/вид сделки/i)] || ''), /Продажа.*Часть\s*2/i);
        assert.equal(first[col(/количество/i)], -1800000000);
        assert.equal(first[col(/цена одного/i)], 2.588);
        assert.equal(first[col(/^Валюта цены/i)], 'RUR');
        assert.equal(first[col(/сумма сделки в валюте/i)], 4658027201.75);
        assert.equal(first[col(/сумма сделки, руб/i)], 4658027201.75);
        assert.ok(!first[col(/НКД в валюте/i)], 'НКД в валюте пустой');
        assert.ok(!first[col(/НКД, руб/i)], 'НКД руб пустой');
        assert.equal(first[col(/комиссия ООО/i)], 0);
        assert.equal(first[col(/комиссия биржи/i)], 0);
        assert.match(String(first[col(/срок действия/i)] || ''), /1\s+день/i);
        assert.equal(first[col(/портфель/i)], '24951000');

        const row7 = trades.rows[6];
        assert.equal(row7[col(/комиссия ООО/i)], -25978.7);
        assert.equal(row7[col(/комиссия биржи/i)], 0);

        const typeKey = col(/вид сделки/i);
        let splitLike = 0;
        for (const row of trades.rows) {
            const v = String(row[typeKey] || '');
            if (/^Продажа,\s*$/i.test(v) || /^Покупка,\s*$/i.test(v) || /^Часть\s+[12]\s*$/i.test(v)) {
                splitLike++;
            }
        }
        assert.ok(splitLike <= 3, `split-like deal type rows: ${splitLike}`);
    });

    it('декабрьский короткий: assets + encumbered', async () => {
        assert.ok(fs.existsSync(DECEMBER_SHORT), `fixture missing: ${DECEMBER_SHORT}`);
        const buf = fs.readFileSync(DECEMBER_SHORT);
        const probe = await probePdfKind(buf, path.basename(DECEMBER_SHORT));
        assert.equal(probe.brokerSubtype, 'aton');

        const sections = await extractBrokerPdfSectionTables(probe.lines, '', {
            brokerSubtype: 'aton',
            pdfBuffer: buf,
        });
        const byId = Object.fromEntries(sections.map((s) => [s.id, s]));

        assert.ok(byId.assets?.rows.length >= 16, `assets rows: ${byId.assets?.rows.length}`);
        assert.ok(byId.assets?.headers[0] === ATON_REPORT_HEADER_COLS.account);
        assert.ok(byId.assets?.headers.includes('Показатель'));
        assert.equal(byId.assets.method, 'aton_assets');
        assert.equal(
            byId.assets.rows[0][ATON_REPORT_HEADER_COLS.account],
            '24940000'
        );
        assert.equal(
            byId.assets.rows[0][ATON_REPORT_HEADER_COLS.contract],
            '№ 24940000 от 16.10.2020'
        );
        assert.equal(
            byId.assets.rows[0][ATON_REPORT_HEADER_COLS.reportDate],
            '13.01.2026'
        );
        assert.ok(
            byId.assets.rows.every(
                (r) =>
                    r[ATON_REPORT_HEADER_COLS.account] === '24940000' &&
                    r[ATON_REPORT_HEADER_COLS.reportDate] === '13.01.2026'
            ),
            'мета ATON во всех строках assets'
        );
        const marketRows = byId.assets.rows.filter((r) =>
            /Рыночная\s+стоимость\s+активов/i.test(r['Показатель'] || '')
        );
        assert.equal(marketRows.length, 5, '5 валют под «Рыночная стоимость активов»');
        assert.ok(
            marketRows.every((r) => /^(CNY|EUR|HKD|RUR|USD)$/.test(r['Валюта'] || '')),
            'валюты не склеены в показатель'
        );
        assert.ok(
            !byId.assets.rows.some((r) => /^(EUR|HKD|RUR|USD)\d/.test(r['Показатель'] || '')),
            'показатель не начинается с кода валюты и цифр'
        );
        assert.ok(byId.encumbered?.rows.length >= 1);
        assert.equal(
            byId.encumbered.rows[0][ATON_REPORT_HEADER_COLS.account],
            '24940000'
        );
        const cbKey =
            byId.encumbered.headers.find((h) => /ЦБ.*ISIN|эмитент/i.test(h)) ||
            byId.encumbered.headers[0];
        assert.equal(byId.encumbered.rows[0][cbKey], 'ВТБ(1/10000)(C)/RU000A0JP5V6/10401000B');
        assert.ok(
            byId.encumbered.headers.length >= 12,
            `encumbered cols: ${byId.encumbered.headers.length}`
        );
        assert.match(byId.encumbered.method || '', /pdfjs_grid/);
    });
});

describe('detectBrokerSubtype', () => {
    it('ClnBIS → vtb, не aton', () => {
        assert.equal(
            detectBrokerSubtype('Справка о стоимости активов', 'ClnBIS_Period_20200000_20251001_20251031_1.pdf', '/Джи Ай/'),
            'vtb'
        );
    });

    it('client_*_to_ → aton', () => {
        assert.equal(
            detectBrokerSubtype('Отчет о состоянии счетов', 'client_24951000_01.10.2025_to_31.10.2025.pdf', ''),
            'aton'
        );
    });
});

const GI_SOLUTIONS_DIR = path.join(
    __dirname,
    '..',
    'docs',
    'ksenia',
    'проект SOLAR',
    'проект SOLAR',
    'Отчеты брокера за 4 квартал 2025',
    'Джи Ай Солюшенс'
);
const CLNBIS_OCTOBER = path.join(GI_SOLUTIONS_DIR, 'ClnBIS_Period_20200000_20251001_20251031_1.pdf');

describe('ClnBIS / GI Solutions broker PDF', () => {
    it('октябрь 2025: assets + reserved + operations при subtype vtb', async () => {
        if (!fs.existsSync(CLNBIS_OCTOBER)) return;

        const buf = fs.readFileSync(CLNBIS_OCTOBER);
        const probe = await probePdfKind(buf, path.basename(CLNBIS_OCTOBER));
        assert.equal(probe.brokerSubtype, 'vtb');

        const sections = await extractBrokerPdfSectionTables(probe.lines, '', {
            brokerSubtype: probe.brokerSubtype,
            pdfBuffer: buf,
            fileName: path.basename(CLNBIS_OCTOBER),
        });
        const byId = Object.fromEntries(sections.map((s) => [s.id, s]));

        assert.ok(byId.assets?.rows.length >= 4, 'assets: 4 строки с подписями');
        assert.ok(
            byId.assets.rows.some((r) => /Доступно\s+средств/i.test(r['Показатель'] || '')),
            'assets: доступно средств'
        );
        assert.ok(
            byId.assets.rows.some((r) => /Задолженность/i.test(r['Показатель'] || '')),
            'assets: задолженность'
        );
        assert.ok(byId.reserved?.rows.length >= 1, 'reserved Take-Two');
        const cbKey = 'ЦБ (эмитент / ISIN / код гос. регистрации)';
        assert.equal(
            byId.reserved.rows[0][cbKey],
            'Take-Two Interactive Soft(C)/US8740541094/'
        );
        assert.equal(byId.reserved.rows[0]['На начало — Количество ЦБ'], '58');
        assert.equal(byId.reserved.rows[0]['На конец — Количество ЦБ'], '58');
        assert.equal(byId.reserved.rows[0]['Планируемая позиция по ЦБ'], '58');
        assert.match(byId.reserved.method || '', /clnbis_reserved_grid/);
        assert.ok(byId.operations?.rows.length >= 3, 'operations');
        assert.match(byId.operations.method || '', /clnbis_operations_grid|aton_operations/);
        assert.equal(byId.operations.rows[0]['Сумма, руб.'], '-100,00');
        assert.equal(byId.operations.rows[0]['Портфель'], '20200000');
        assert.equal(byId.operations.rows[1]['Сумма, руб.'], '-6,72');
        assert.ok(shouldUseMultiTableBrokerParse(sections, ''));

        for (const sec of ['assets', 'reserved', 'operations']) {
            const table = byId[sec];
            assert.ok(table, sec);
            assert.equal(table.headers[0], ATON_REPORT_HEADER_COLS.account, `${sec}: account col`);
            assert.equal(table.rows[0][ATON_REPORT_HEADER_COLS.account], '20200000', `${sec}: account`);
            assert.equal(
                table.rows[0][ATON_REPORT_HEADER_COLS.contract],
                '№ 20200000 от 11.09.2024',
                `${sec}: contract`
            );
            assert.equal(table.rows[0][ATON_REPORT_HEADER_COLS.reportDate], '01.11.2025', `${sec}: date`);
            assert.ok(
                table.rows.every(
                    (r) =>
                        r[ATON_REPORT_HEADER_COLS.account] === '20200000' &&
                        r[ATON_REPORT_HEADER_COLS.reportDate] === '01.11.2025'
                ),
                `${sec}: meta во всех строках`
            );
        }
    });
});
