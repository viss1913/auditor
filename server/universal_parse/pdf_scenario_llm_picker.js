const { chatCompletion, extractJsonFromLlmContent } = require('../llm_client');

const PICKER_SYSTEM = `Ты выбираешь PDF-сценарий парсинга таблицы из списка кандидатов.
Верни JSON:
{
  "chosenScenarioId": number|null,
  "confidence": number (0..1),
  "reason": "кратко по-русски",
  "askUser": boolean,
  "question": "если askUser=true — вопрос пользователю"
}
Если один кандидат явно подходит — chosenScenarioId и confidence >= 0.7.
Если не уверен — askUser=true, chosenScenarioId=null, confidence < 0.7.
Не выбирай сценарий, если markers файла не совпадают с типом документа.`;

function shouldInvokeLlmPicker(candidates, pdfProbe) {
    if (!candidates?.length) return false;
    const top = candidates[0];
    const second = candidates[1];
    if (pdfProbe?.ambiguous && candidates.length >= 2) return true;
    if (top.matchScore >= 0.85 && top.autoApply) return false;
    if (top.matchScore >= 0.55 && top.matchScore < 0.85 && !top.autoApply) return true;
    if (second && second.matchScore >= 0.55 && top.matchScore - second.matchScore < 0.15) {
        return true;
    }
    return false;
}

function buildCandidateSummary(c) {
    const rule = c.ruleJson || {};
    const meta = rule.meta || {};
    return {
        id: c.id,
        name: c.name,
        description: meta.description || '',
        tags: meta.tags || [],
        docKind: c.docKind,
        brokerSubtype: c.brokerSubtype,
        markers: rule.detection?.markers || [],
        headers: (rule.columns || []).slice(0, 6).map((col) => col.label || col.target),
        matchScore: Math.round((c.matchScore || 0) * 100) / 100,
        markerHits: c.markerHits,
        autoApply: c.autoApply,
    };
}

/**
 * @param {object} input
 * @returns {Promise<{ chosenScenarioId: number|null, confidence: number, reason: string, askUser?: boolean, question?: string }|null>}
 */
async function pickPdfScenarioWithLlm({ fileSignals, candidates, pdfProbe, fileName = '' }) {
    if (!shouldInvokeLlmPicker(candidates, pdfProbe)) return null;
    if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY && !process.env.OPENROUTER_API_KEY) {
        return null;
    }

    const textLines = String(fileSignals?.text || '')
        .split('\n')
        .slice(0, 20)
        .join('\n');

    const payload = {
        file: {
            fileName: fileName || null,
            docKind: fileSignals?.docKind || pdfProbe?.kind || 'unknown',
            brokerSubtype: fileSignals?.brokerSubtype || pdfProbe?.brokerSubtype || null,
            headerSample: fileSignals?.headerSample || [],
            columnCount: fileSignals?.columnCount || 0,
            textSample: textLines.slice(0, 800),
            ambiguous: Boolean(pdfProbe?.ambiguous),
        },
        candidates: candidates.slice(0, 5).map(buildCandidateSummary),
    };

    try {
        const { content } = await chatCompletion({
            messages: [
                { role: 'system', content: PICKER_SYSTEM },
                {
                    role: 'user',
                    content: `Выбери сценарий:\n${JSON.stringify(payload, null, 2)}`,
                },
            ],
            temperature: 0.08,
            responseFormat: { type: 'json_object' },
        });
        const parsed = extractJsonFromLlmContent(content);
        const chosenId = parsed.chosenScenarioId != null ? parseInt(parsed.chosenScenarioId, 10) : null;
        const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
        return {
            chosenScenarioId: Number.isFinite(chosenId) ? chosenId : null,
            confidence,
            reason: String(parsed.reason || '').trim(),
            askUser: Boolean(parsed.askUser),
            question: String(parsed.question || '').trim(),
        };
    } catch (err) {
        if (process.env.PDF_SCENARIO_DEBUG === '1') {
            console.warn('[pdf-scenario-llm]', err?.message || err);
        }
        return null;
    }
}

module.exports = {
    shouldInvokeLlmPicker,
    pickPdfScenarioWithLlm,
    buildCandidateSummary,
};
