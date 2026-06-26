import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiBase } from './apiBase';

export default function PdfColumnEditor({ file, meta, onClose, onSaved }) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [preview, setPreview] = useState(null);
    const [centersNorm, setCentersNorm] = useState([]);
    const [headers, setHeaders] = useState([]);
    const [extractRows, setExtractRows] = useState([]);
    const [saving, setSaving] = useState(false);
    const [scenarioName, setScenarioName] = useState('');
    const [draggingIdx, setDraggingIdx] = useState(null);
    const canvasRef = useRef(null);
    const extractTimerRef = useRef(null);

    const loadPreview = useCallback(async () => {
        if (!file) return;
        setLoading(true);
        setError('');
        try {
            const fd = new FormData();
            fd.append('file', file);
            if (meta?.sectionId) fd.append('section_id', meta.sectionId);
            if (meta?.sectionStart) fd.append('section_start', meta.sectionStart);
            if (meta?.docKind) fd.append('doc_kind', meta.docKind);
            if (meta?.brokerSubtype) fd.append('broker_subtype', meta.brokerSubtype);

            const res = await fetch(`${apiBase()}/pdf-grid-preview`, { method: 'POST', body: fd });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка preview');

            setPreview(data);
            const norms = data.autoColumnCentersNorm?.length
                ? [...data.autoColumnCentersNorm]
                : [0.1, 0.5, 0.9];
            setCentersNorm(norms);
            setHeaders(data.headers?.length ? [...data.headers] : norms.map((_, i) => `col_${i + 1}`));
            setScenarioName(
                meta?.scenarioName ||
                    `PDF ${meta?.brokerSubtype || meta?.docKind || 'таблица'} ${meta?.sectionId || ''}`.trim()
            );
            if (data.previewRows?.length) setExtractRows(data.previewRows);
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, [file, meta]);

    useEffect(() => {
        loadPreview();
    }, [loadPreview]);

    const reExtract = useCallback(async () => {
        if (!file) return;
        setError('');
        try {
            const fd = new FormData();
            fd.append('file', file);
            fd.append('column_centers_norm', JSON.stringify(centersNorm));
            fd.append('headers', JSON.stringify(headers));
            fd.append('x_tol_norm', '0.02');
            if (meta?.sectionId) fd.append('section_id', meta.sectionId);
            if (meta?.sectionStart) fd.append('section_start', meta.sectionStart);

            const res = await fetch(`${apiBase()}/pdf-grid-extract`, { method: 'POST', body: fd });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка extract');
            setExtractRows(data.rows || []);
            if (data.headers?.length) setHeaders(data.headers);
        } catch (e) {
            setError(e.message);
        }
    }, [file, centersNorm, headers, meta]);

    useEffect(() => {
        if (!preview || loading || centersNorm.length < 2) return;
        if (extractTimerRef.current) clearTimeout(extractTimerRef.current);
        extractTimerRef.current = setTimeout(() => {
            reExtract();
        }, 400);
        return () => {
            if (extractTimerRef.current) clearTimeout(extractTimerRef.current);
        };
    }, [centersNorm, preview, loading, reExtract]);

    const saveScenario = async () => {
        setSaving(true);
        setError('');
        try {
            const body = {
                project_id: meta?.projectId || null,
                name: scenarioName,
                doc_kind: meta?.docKind || 'unknown',
                broker_subtype: meta?.brokerSubtype || null,
                section_id: meta?.sectionId || null,
                page_width_pt: preview?.pageWidthPt || 595.28,
                column_centers_norm: centersNorm,
                headers,
                x_tol_norm: 0.02,
                data_start_row: 0,
                markers: meta?.markers || [],
                section_start: meta?.sectionStart || null,
                expected_row_count: extractRows.length || preview?.previewRows?.length || null,
            };
            const res = await fetch(`${apiBase()}/pdf-parse-scenarios/from-extract`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка сохранения');
            onSaved?.(data.scenario);
            onClose?.();
        } catch (e) {
            setError(e.message);
        } finally {
            setSaving(false);
        }
    };

    const updateCenterFromClientX = (idx, clientX) => {
        const el = canvasRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const norm = Math.max(0.01, Math.min(0.99, (clientX - rect.left) / rect.width));
        setCentersNorm((prev) => {
            const next = [...prev];
            next[idx] = norm;
            return next.sort((a, b) => a - b);
        });
    };

    const onLinePointerDown = (idx, e) => {
        e.preventDefault();
        setDraggingIdx(idx);
        e.currentTarget.setPointerCapture(e.pointerId);
    };

    const onCanvasPointerMove = (e) => {
        if (draggingIdx == null) return;
        updateCenterFromClientX(draggingIdx, e.clientX);
    };

    const onCanvasPointerUp = (e) => {
        if (draggingIdx == null) return;
        setDraggingIdx(null);
        try {
            e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
            /* ignore */
        }
    };

    const onCanvasDoubleClick = (e) => {
        const el = canvasRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const norm = Math.max(0.02, Math.min(0.98, (e.clientX - rect.left) / rect.width));
        setCentersNorm((prev) => [...prev, norm].sort((a, b) => a - b));
        setHeaders((prev) => [...prev, `col_${prev.length + 1}`]);
    };

    const moveCenter = (idx, delta) => {
        setCentersNorm((prev) => {
            const next = [...prev];
            next[idx] = Math.max(0.01, Math.min(0.99, (next[idx] || 0) + delta));
            return next.sort((a, b) => a - b);
        });
    };

    const addColumn = () => {
        setCentersNorm((prev) => [...prev, 0.5].sort((a, b) => a - b));
        setHeaders((prev) => [...prev, `col_${prev.length + 1}`]);
    };

    const removeColumn = (idx) => {
        if (centersNorm.length <= 2) return;
        setCentersNorm((prev) => prev.filter((_, i) => i !== idx));
        setHeaders((prev) => prev.filter((_, i) => i !== idx));
    };

    const previewTable = useMemo(() => {
        if (!extractRows.length || !headers.length) return null;
        return extractRows.slice(0, 12);
    }, [extractRows, headers]);

    if (!file) return null;

    return (
        <div className="pdf-column-editor">
            <div className="pdf-column-editor__header">
                <strong>Редактор колонок PDF</strong>
                <span className="pdf-column-editor__hint-inline">
                    Перетащи линии · двойной клик — новая колонка
                </span>
                <button type="button" className="btn-link" onClick={onClose}>
                    Закрыть
                </button>
            </div>
            {loading ? <p>Загрузка слоя текста…</p> : null}
            {error ? <p className="error-text">{error}</p> : null}
            {!loading && preview ? (
                <div className="pdf-column-editor__split">
                    <div className="pdf-column-editor__pane">
                        <div
                            ref={canvasRef}
                            className="pdf-column-editor__canvas"
                            onPointerMove={onCanvasPointerMove}
                            onPointerUp={onCanvasPointerUp}
                            onPointerLeave={onCanvasPointerUp}
                            onDoubleClick={onCanvasDoubleClick}
                        >
                            {preview.items?.slice(0, 500).map((it, i) => (
                                <span
                                    key={`${it.x}-${it.y}-${i}`}
                                    style={{
                                        position: 'absolute',
                                        left: `${(it.xNorm || 0) * 100}%`,
                                        top: `${(1 - (it.yNorm || 0) / (preview.pageHeightPt / preview.pageWidthPt || 1.4)) * 100}%`,
                                        fontSize: 9,
                                        color: '#333',
                                        whiteSpace: 'nowrap',
                                        transform: 'translate(-50%, -50%)',
                                        pointerEvents: 'none',
                                    }}
                                >
                                    {it.text}
                                </span>
                            ))}
                            {centersNorm.map((n, idx) => (
                                <div
                                    key={`line-${idx}`}
                                    className={`pdf-column-line${draggingIdx === idx ? ' pdf-column-line--drag' : ''}`}
                                    style={{ left: `${n * 100}%` }}
                                    title={headers[idx] || `col ${idx + 1}`}
                                    onPointerDown={(e) => onLinePointerDown(idx, e)}
                                >
                                    <span className="pdf-column-line__label">{headers[idx] || idx + 1}</span>
                                </div>
                            ))}
                        </div>
                        <div className="pdf-column-editor__cols">
                            {centersNorm.map((n, idx) => (
                                <div key={`col-${idx}`} className="pdf-column-editor__col">
                                    <input
                                        value={headers[idx] || ''}
                                        onChange={(e) =>
                                            setHeaders((prev) => {
                                                const next = [...prev];
                                                next[idx] = e.target.value;
                                                return next;
                                            })
                                        }
                                        placeholder={`Колонка ${idx + 1}`}
                                    />
                                    <button type="button" onClick={() => moveCenter(idx, -0.01)}>
                                        ←
                                    </button>
                                    <button type="button" onClick={() => moveCenter(idx, 0.01)}>
                                        →
                                    </button>
                                    <button type="button" onClick={() => removeColumn(idx)}>
                                        ✕
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="pdf-column-editor__pane pdf-column-editor__preview-table">
                        <strong>Preview ({extractRows.length} строк)</strong>
                        {previewTable ? (
                            <div className="pdf-column-editor__table-wrap">
                                <table className="pdf-column-editor__table">
                                    <thead>
                                        <tr>
                                            {headers.map((h) => (
                                                <th key={h}>{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {previewTable.map((row, ri) => (
                                            <tr key={ri}>
                                                {headers.map((h) => (
                                                    <td key={`${ri}-${h}`}>{row[h] ?? ''}</td>
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ) : (
                            <p className="pdf-column-editor__hint">Двигай линии — таблица обновится</p>
                        )}
                    </div>
                </div>
            ) : null}
            {!loading && preview ? (
                <div className="pdf-column-editor__actions">
                    <button type="button" onClick={addColumn}>
                        + Колонка
                    </button>
                    <button type="button" onClick={reExtract}>
                        Пересобрать
                    </button>
                    <input
                        value={scenarioName}
                        onChange={(e) => setScenarioName(e.target.value)}
                        placeholder="Имя сценария"
                    />
                    <button type="button" disabled={saving} onClick={saveScenario}>
                        {saving ? 'Сохраняю…' : 'Сохранить сценарий'}
                    </button>
                </div>
            ) : null}
        </div>
    );
}
