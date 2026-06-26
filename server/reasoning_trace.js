/**
 * Трасса решений Martin: план → структура → профиль → результат.
 * Детерминированная (не сырой LLM CoT) — для UI и контекста чата.
 */
const { scenarioDisplayName } = require('./scenarios/catalog');

function pct(confidence) {
    if (confidence == null || Number.isNaN(confidence)) return null;
    return Math.round(Number(confidence) * 100);
}

function step(id, title, status, detail, meta = null) {
    return { id, title, status, detail: String(detail || '—'), ...(meta ? { meta } : {}) };
}

function formatAlternatives(structure) {
    return (structure?.alternatives || [])
        .filter((a) => a.confidence >= 0.4)
        .map((a) => `${a.structure_id} ${pct(a.confidence)}%`)
        .join(', ');
}

function buildReasoningTrace(ctx = {}) {
    const {
        parsePlan = null,
        structure = null,
        profileId = null,
        scenarioId = null,
        scenarioName = null,
        sheetName = null,
        fileName = null,
        triedProfiles = null,
        validationReport = null,
        rowCount = null,
        tableMeta = null,
        outcome = 'plan',
        reason = null,
    } = ctx;

    const steps = [];

    if (fileName || sheetName) {
        steps.push(
            step(
                'file',
                'Файл',
                'pass',
                [fileName, sheetName ? `лист «${sheetName}»` : ''].filter(Boolean).join(' · ')
            )
        );
    }

    if (parsePlan) {
        const conf = pct(parsePlan.confidence);
        steps.push(
            step(
                'plan',
                'Команда → план',
                parsePlan.intent === 'idle' ? 'warn' : 'pass',
                parsePlan.summary || '—',
                {
                    scenarioId: parsePlan.scenarioId || null,
                    intent: parsePlan.intent,
                    confidence: conf,
                }
            )
        );
        if (parsePlan.probe) {
            const probe = parsePlan.probe;
            const probeParts = [`${probe.fileCount || 0} файл(ов)`];
            if (probe.suggestedScenario) probeParts.push(`похоже на ${probe.suggestedScenario}`);
            if (probe.prefixMatches != null && probe.fileCount) {
                probeParts.push(`prefix ${probe.prefixMatches}/${probe.fileCount}`);
            }
            steps.push(step('probe', 'Probe файлов', 'pass', probeParts.join(' · ')));
        }
    }

    if (structure) {
        const topConf = pct(structure.confidence);
        let status = 'pass';
        if (!structure.autoParse && outcome !== 'success' && !structure.ambiguous) status = 'fail';
        if (structure.ambiguous) status = 'warn';

        let detail = `${structure.structure_id || '?'}${topConf != null ? ` (${topConf}%)` : ''}`;
        if (structure.fingerprint_reason) detail += ` — ${structure.fingerprint_reason}`;
        const alts = formatAlternatives(structure);
        if (alts) detail += `. Альтернативы: ${alts}`;
        if (structure.ambiguous) detail += '. Неоднозначно — нужен выбор или новый сценарий';

        steps.push(
            step('structure', 'Структура листа', status, detail, {
                structureId: structure.structure_id,
                ambiguous: Boolean(structure.ambiguous),
                autoParse: Boolean(structure.autoParse),
            })
        );
    }

    if (triedProfiles?.length) {
        const lines = triedProfiles.map((t) => {
            const score = t.detectScore != null ? ` ${pct(t.detectScore)}%` : '';
            const mark =
                t.error || (outcome !== 'success' && triedProfiles.indexOf(t) === triedProfiles.length - 1)
                    ? ''
                    : profileId && t.profileId === profileId
                      ? ' ✓'
                      : '';
            return `${t.profileId}${score}${mark}${t.error ? ' ✗' : ''}`;
        });
        steps.push(
            step(
                'profile',
                'Профиль парсера',
                outcome === 'success' ? 'pass' : triedProfiles.length > 1 ? 'warn' : 'fail',
                lines.join(' → ')
            )
        );
    } else if (profileId) {
        steps.push(step('profile', 'Профиль парсера', 'pass', profileId));
    }

    const sid = scenarioId || parsePlan?.scenarioId;
    if (sid) {
        const label = scenarioName || scenarioDisplayName(sid) || sid;
        steps.push(
            step(
                'scenario',
                'Сценарий',
                outcome === 'refused' ? 'fail' : 'pass',
                label === sid ? sid : `${label} (${sid})`
            )
        );
    }

    if (rowCount != null && outcome === 'success') {
        let detail = `${Number(rowCount).toLocaleString('ru-RU')} строк`;
        if (tableMeta?.tableLayout && tableMeta.tableLayout !== 'flat') {
            detail += ` · шапка ${tableMeta.tableLayout}`;
        }
        steps.push(step('result', 'Результат', 'pass', detail));
    }

    if (validationReport) {
        steps.push(
            step(
                'validation',
                'Валидация',
                validationReport.ok ? 'pass' : 'fail',
                validationReport.summary || (validationReport.ok ? 'ок' : 'отказ')
            )
        );
    }

    if (outcome === 'refused') {
        steps.push(step('refusal', 'Отказ', 'fail', reason || 'не удалось разобрать'));
    }

    const summaryParts = [];
    if (structure?.structure_id) summaryParts.push(structure.structure_id);
    if (sid) summaryParts.push(sid);
    if (rowCount != null && outcome === 'success') summaryParts.push(`${rowCount} строк`);

    return {
        version: 1,
        outcome,
        steps,
        summary: summaryParts.join(' · ') || parsePlan?.summary || '',
    };
}

module.exports = {
    buildReasoningTrace,
};
