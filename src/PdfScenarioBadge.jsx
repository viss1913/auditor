const STATUS_LABELS = {
    builtin: { text: 'Встроенный парсер', className: 'pdf-scenario-badge pdf-scenario-badge--builtin' },
    found: { text: 'Сценарий найден', className: 'pdf-scenario-badge pdf-scenario-badge--found' },
    similar: { text: 'Похожий сценарий', className: 'pdf-scenario-badge pdf-scenario-badge--similar' },
    missing: { text: 'Сценарий не найден', className: 'pdf-scenario-badge pdf-scenario-badge--missing' },
};

export default function PdfScenarioBadge({ scenarioResolution, onOpenEditor }) {
    const ps = scenarioResolution?.parseScenario;
    if (!ps?.status) return null;

    const cfg = STATUS_LABELS[ps.status] || STATUS_LABELS.missing;
    const score = ps.matchScore != null ? Math.round(ps.matchScore * 100) : null;

    return (
        <div className="pdf-scenario-row">
            <span className={cfg.className} title={ps.scenarioName || ''}>
                {cfg.text}
                {ps.scenarioName ? `: ${ps.scenarioName}` : ''}
                {score != null && ps.status !== 'builtin' ? ` (${score}%)` : ''}
            </span>
            {ps.status === 'similar' && ps.candidates?.length > 1 ? (
                <span className="pdf-scenario-hint">
                    Кандидатов: {ps.candidates.length}
                </span>
            ) : null}
            {(ps.status === 'missing' || ps.status === 'similar') && onOpenEditor ? (
                <button type="button" className="btn-link" onClick={onOpenEditor}>
                    Подправить колонки
                </button>
            ) : null}
        </div>
    );
}
