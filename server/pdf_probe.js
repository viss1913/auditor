const pdfParse = require('pdf-parse');
const { CLASSIFY_MIN_MARGIN } = require('./confidence_thresholds');

const DEPO_STRONG_MARKERS = [
    /Зачисление\s+ЦБ/i,
    /Списание\s+ЦБ/i,
    /выписка\s+о\s+движен/i,
    /движени[яе]\s+ценн/i,
    /счет[ауе]\s+депо/i,
    /депозитар/i,
];

const BROKER_REPORT_MARKERS = [
    /Отчет\s+о\s+состоянии\s+счет/i,
    /по\s+сделкам\s+и\s+операциям/i,
    /брокерск/i,
    /\bATON\b/i,
    /АТОН/i,
    /Справка\s+о\s+стоимости\s+активов/i,
    /INVESTMENT\s+ACCOUNT\s+STATEMENT/i,
    /Landmark\s+Capital/i,
    /Cash\s+Balance/i,
    /ClientReportForThePeriod/i,
    /Cash\s+Deposits\/Withdrawals/i,
    /Conversion\s+Transactions/i,
];

const LIMAN_FILENAME_RE = /Account[\s_]?Statement_LMC|LMC-/i;

const UPD_MARKERS = [
    /СЧФДОП/i,
    /Универсальный\s+передаточный/i,
    /Счет-фактура\s+No/i,
    /Наименование товара/i,
    /Эдивеб/i,
];

const BROKER_FILENAME_RE = /client_\d+_\d{2}\.\d{2}\.\d{4}_to_/i;

const KIND_IDS = ['upd_ediweb', 'broker_report', 'depo'];

/**
 * @param {string} text
 * @param {string} [fileName]
 * @returns {{ upd: number, broker: number, depo: number }}
 */
function scorePdfKinds(text, fileName = '') {
    const t = String(text || '');
    const name = String(fileName || '');

    let upd = 0;
    let broker = 0;
    let depo = 0;

    for (const re of UPD_MARKERS) {
        if (re.test(t)) upd++;
    }
    for (const re of BROKER_REPORT_MARKERS) {
        if (re.test(t)) broker++;
    }
    for (const re of DEPO_STRONG_MARKERS) {
        if (re.test(t)) depo++;
    }

    if (/Обремененн/i.test(t) && /ценн/i.test(t)) broker += 2;

    const brokerTextMarkers = BROKER_REPORT_MARKERS.filter((re) => re.test(t)).length;
    if (BROKER_FILENAME_RE.test(name)) broker += brokerTextMarkers >= 2 ? 2 : 1;
    if (LIMAN_FILENAME_RE.test(name)) broker += brokerTextMarkers >= 2 ? 3 : 1;
    if (/INVESTMENT\s+ACCOUNT\s+STATEMENT/i.test(t) && /Landmark\s+Capital/i.test(t)) broker += 2;

    return { upd, broker, depo };
}

/**
 * @param {{ upd: number, broker: number, depo: number }} scores
 * @param {number} [minMargin]
 */
function buildKindRanking(scores, minMargin = CLASSIFY_MIN_MARGIN) {
    const ranked = KIND_IDS.map((id) => ({
        id,
        score: scores[id === 'upd_ediweb' ? 'upd' : id === 'broker_report' ? 'broker' : 'depo'] || 0,
    })).sort((a, b) => b.score - a.score);

    const top = ranked[0];
    const second = ranked[1];
    const margin = top.score - second.score;
    const ambiguous =
        top.score > 0 &&
        second.score > 0 &&
        margin <= minMargin &&
        top.score >= 1 &&
        second.score >= 1;

    return { ranked, top, second, margin, ambiguous };
}

/**
 * @param {string} text
 * @param {string} [fileName]
 * @returns {{
 *   kind: 'depo'|'upd_ediweb'|'broker_report'|'unknown',
 *   scores: { upd: number, broker: number, depo: number },
 *   alternatives: { id: string, score: number, label: string }[],
 *   ambiguous: boolean,
 *   margin: number,
 *   confidence: number
 * }}
 */
function classifyPdfTextWithScores(text, fileName = '') {
    const scores = scorePdfKinds(text, fileName);
    const { ranked, top, second, margin, ambiguous } = buildKindRanking(scores);

    const KIND_LABELS = {
        upd_ediweb: 'УПД',
        broker_report: 'Брокерский отчёт',
        depo: 'Выписка ДЕПО',
    };

    const alternatives = ranked
        .filter((r) => r.score > 0)
        .map((r) => ({ id: r.id, score: r.score, label: KIND_LABELS[r.id] || r.id }));

    let kind = 'unknown';
    if (!ambiguous && top.score > 0) {
        if (top.id === 'upd_ediweb' && top.score >= 2) kind = 'upd_ediweb';
        else if (top.id === 'broker_report' && top.score >= 2 && top.score >= scores.depo) kind = 'broker_report';
        else if (top.id === 'depo' && top.score >= 1 && scores.broker < 2) kind = 'depo';
        else if (top.id === 'broker_report' && top.score >= 1) kind = 'broker_report';
        else if (top.id === 'upd_ediweb' && top.score >= 1) kind = 'upd_ediweb';
    } else if (!ambiguous && top.score > 0 && second.score === 0) {
        if (top.id === 'broker_report' && top.score >= 1) kind = 'broker_report';
        else if (top.id === 'upd_ediweb' && top.score >= 1) kind = 'upd_ediweb';
        else if (top.id === 'depo' && top.score >= 1) kind = 'depo';
    }

    const confidence = computeClassifyConfidence(kind, top.score, margin, ambiguous, text);

    return { kind, scores, alternatives, ambiguous, margin, confidence };
}

/**
 * @param {string} kind
 * @param {number} topScore
 * @param {number} margin
 * @param {boolean} ambiguous
 * @param {string} text
 */
function computeClassifyConfidence(kind, topScore, margin, ambiguous, text = '') {
    if (ambiguous || kind === 'unknown') {
        return Math.max(0.2, Math.min(0.55, topScore > 0 ? 0.35 + margin * 0.1 : 0.3));
    }
    if (kind === 'upd_ediweb' && /СЧФДОП/.test(text)) return 0.95;
    if (topScore <= 0) return 0.3;
    const marginBoost = Math.min(0.25, margin * 0.12);
    const scoreBoost = Math.min(0.35, topScore * 0.08);
    return Math.max(0.45, Math.min(0.95, 0.5 + marginBoost + scoreBoost));
}

/**
 * @param {string} text
 * @param {string} [fileName]
 * @returns {'depo'|'upd_ediweb'|'broker_report'|'unknown'}
 */
function classifyPdfText(text, fileName = '') {
    return classifyPdfTextWithScores(text, fileName).kind;
}

/**
 * @param {string} text
 * @param {string} [fileName]
 * @param {string} [filePath]
 * @returns {'aton'|'vtb'|'liman'|'unknown'|'not_broker'}
 */
function detectBrokerSubtype(text, fileName = '', filePath = '') {
    const t = String(text || '');
    const name = String(fileName || '');
    const path = String(filePath || '');

    if (
        (/протокол|собрани[яе]\s+участник/i.test(t) || /протокол/i.test(name)) &&
        !/брокерск|сделкам\s+и\s+операциям|Отчет\s+о\s+состоянии\s+счет/i.test(t)
    ) {
        return 'not_broker';
    }
    if (/ClnBIS_Period/i.test(name) || /втб|vtb|гпб|джи\s*ай|gi\s*solution/i.test(path)) {
        return 'vtb';
    }
    if (/Account[\s_]?Statement_LMC|LMC-/i.test(name) || /лэндмарк|landmark|лиман/i.test(path)) {
        return 'liman';
    }
    if (/Landmark\s+Capital|INVESTMENT\s+ACCOUNT\s+STATEMENT/i.test(t)) return 'liman';
    if (/ClientReportForThePeriod/i.test(name)) return 'orion_client_report';
    if (/Cash\s+Deposits\/Withdrawals/i.test(t) || /Conversion\s+Transactions/i.test(t)) return 'orion_client_report';
    if (
        /\bATON\b|АТОН|Отчет\s+о\s+состоянии\s+счетов\s+клиента\s+по\s+сделкам/i.test(t) ||
        BROKER_FILENAME_RE.test(name) ||
        /атон/i.test(path)
    ) {
        return 'aton';
    }
    if (/ВТБ/i.test(t)) return 'vtb';
    return 'unknown';
}

/** Реальная выписка ДЕПО с операциями зачисления/списания. */
function isStrongDepoPdf(text) {
    const t = String(text || '');
    if (/Зачисление\s+ЦБ|Списание\s+ЦБ/.test(t)) return true;
    return /выписка/i.test(t) && /депо|движени.*ценн/i.test(t);
}

/**
 * Делегировать в ОПИФ/ДЕПО только при явном intent и сильных маркерах выписки.
 * @param {{ pdfProbe?: object, userMessage?: string, fileName?: string }} opts
 */
function shouldDelegateToOpifDepo({ pdfProbe, userMessage = '', fileName = '' }) {
    if (!pdfProbe || pdfProbe.kind !== 'depo') return false;

    const t = String(userMessage || '').toLowerCase();
    const pathHint = String(fileName || '');
    const depoIntent =
        /депо|выписк|движени.*ценн/i.test(t) ||
        /(^|[\\/])depo([\\/]|$)/i.test(pathHint);

    if (!depoIntent) return false;

    const text = (pdfProbe.lines || []).join('\n') || pdfProbe.textSample || '';
    return isStrongDepoPdf(text);
}

/**
 * @param {Buffer} buffer
 * @param {string} [fileName]
 */
async function probePdfKind(buffer, fileName = '') {
    const pdfData = await pdfParse(buffer);
    const lines = pdfData.text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

    const profile = classifyPdfTextWithScores(pdfData.text, fileName);
    const brokerSubtype =
        profile.kind === 'broker_report' ? detectBrokerSubtype(pdfData.text, fileName) : null;

    return {
        kind: profile.kind,
        confidence: profile.confidence,
        ambiguous: profile.ambiguous,
        alternatives: profile.alternatives,
        scores: profile.scores,
        margin: profile.margin,
        lineCount: lines.length,
        pageCount: pdfData.numpages || 0,
        lines,
        textSample: lines.slice(0, 30).join('\n'),
        isLikelyScan: lines.length < 8 && (pdfData.numpages || 0) > 0,
        brokerSubtype,
    };
}

module.exports = {
    probePdfKind,
    classifyPdfText,
    classifyPdfTextWithScores,
    scorePdfKinds,
    detectBrokerSubtype,
    isStrongDepoPdf,
    shouldDelegateToOpifDepo,
};
