const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    classifyPdfText,
    classifyPdfTextWithScores,
    isStrongDepoPdf,
    shouldDelegateToOpifDepo,
} = require('./pdf_probe');

const ATON_SAMPLE = `
Отчет о состоянии счетов клиента по сделкам и операциям
ATON
Справка о стоимости активов
Обремененные и/или ограниченные в распоряжении ценные бумаги
ЦБ (эмитент / ISIN)
RU0009024277
ЛУКойл
`;

const DEPO_SAMPLE = `
Выписка о движении ценных бумаг по счету депо
Зачисление ЦБ
01.01.2025
`;

const AMBIGUOUS_SAMPLE = `
Выписка о движении ценных бумаг
Отчет о состоянии счетов клиента по сделкам и операциям
ценных бумаг по счету депо
Справка о стоимости активов
`;

describe('pdf_probe', () => {
    it('Атон → broker_report, не depo', () => {
        const profile = classifyPdfTextWithScores(
            ATON_SAMPLE,
            'client_24940000_01.12.2025_to_31.12.2025.pdf'
        );
        assert.equal(profile.kind, 'broker_report');
        assert.equal(profile.ambiguous, false);
        assert.ok(profile.confidence >= 0.7);
        assert.equal(classifyPdfText(ATON_SAMPLE, 'client_24940000_01.12.2025_to_31.12.2025.pdf'), 'broker_report');
    });

    it('выписка ДЕПО с операциями → depo', () => {
        const profile = classifyPdfTextWithScores(DEPO_SAMPLE);
        assert.equal(profile.kind, 'depo');
        assert.equal(isStrongDepoPdf(DEPO_SAMPLE), true);
    });

    it('ISIN без depo-маркеров → не depo', () => {
        const kind = classifyPdfText('ISIN RU0009024277 ценных бумаг в отчёте');
        assert.notEqual(kind, 'depo');
    });

    it('ambiguous: depo и broker близко по score', () => {
        const profile = classifyPdfTextWithScores(AMBIGUOUS_SAMPLE);
        assert.equal(profile.ambiguous, true);
        assert.equal(profile.kind, 'unknown');
        assert.ok(profile.alternatives.length >= 2);
    });

    it('протокол собрания → not_broker через subtype path', () => {
        const { detectBrokerSubtype } = require('./pdf_probe');
        assert.equal(detectBrokerSubtype('протокол собрания участников', 'protocol.pdf'), 'not_broker');
    });

    it('confidence не фиксированная константа 0.88', () => {
        const weak = classifyPdfTextWithScores('брокерск отчет');
        const strong = classifyPdfTextWithScores(ATON_SAMPLE, 'client_24940000_01.12.2025_to_31.12.2025.pdf');
        assert.ok(strong.confidence > weak.confidence);
    });

    it('shouldDelegateToOpifDepo: только при intent + сильный depo', () => {
        const probe = { kind: 'depo', lines: DEPO_SAMPLE.split('\n') };
        assert.equal(
            shouldDelegateToOpifDepo({
                pdfProbe: probe,
                userMessage: 'это депо',
                fileName: 'DEPO/file.pdf',
            }),
            true
        );
        assert.equal(
            shouldDelegateToOpifDepo({
                pdfProbe: probe,
                userMessage: 'разбери брокерский отчёт',
                fileName: 'client_24940000.pdf',
            }),
            false
        );
    });

    it('ложный depo (только ISIN) не делегируется без intent', () => {
        const probe = {
            kind: 'depo',
            lines: ['ISIN', 'RU0009024277', 'ценных бумаг'],
        };
        assert.equal(
            shouldDelegateToOpifDepo({
                pdfProbe: probe,
                userMessage: 'разбери отчёт',
                fileName: 'report.pdf',
            }),
            false
        );
    });
});
