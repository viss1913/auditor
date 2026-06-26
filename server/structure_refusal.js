const DEFAULT_DEV_CONTACT =
    process.env.MARTIN_DEV_CONTACT || 'разработчикам проекта ИИ-Аудитор (через вашего куратора)';

function buildStructureRefusalMessage({ sheetName, structure, reason }) {
    const structReason = structure?.fingerprint_reason || structure?.structure_id || reason || 'неизвестно';
    const alts = (structure?.alternatives || [])
        .filter((a) => a.confidence >= 0.4)
        .map((a) => `${a.structure_id} (${Math.round(a.confidence * 100)}%)`)
        .join(', ');

    const lines = [
        'Прости, такой формат таблицы я пока не умею разбирать — в аудите гадать нельзя.',
        `Свяжись с ${DEFAULT_DEV_CONTACT}: они быстро научат меня этому листу.`,
        sheetName ? `Лист: «${sheetName}».` : '',
        `Структура: ${structReason}.`,
    ];
    if (structure?.ambiguous && alts) {
        lines.push(`Похоже на несколько форматов: ${alts}. Нужно уточнение или новый сценарий.`);
    }
    return lines.filter(Boolean).join('\n');
}

function buildValidationRefusalDetail(validationReport) {
    if (!validationReport?.checks?.length) return '';
    const failed = validationReport.checks.filter((c) => c.status !== 'pass');
    if (!failed.length) return '';
    const lines = failed.slice(0, 3).map((c) => {
        const actual = c.actual ? ` (получено: ${c.actual})` : '';
        return `• ${c.title}: ожидалось ${c.expected}${actual}`;
    });
    return ['Валидация не пройдена:', ...lines].join('\n');
}

module.exports = {
    DEFAULT_DEV_CONTACT,
    buildStructureRefusalMessage,
    buildValidationRefusalDetail,
};
