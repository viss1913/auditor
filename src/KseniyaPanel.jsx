import React, { useState } from 'react';
import { getParserProfile } from './parserProfiles';
import { apiBase } from './apiBase';

export default function KseniyaPanel() {
  const profile = getParserProfile('kseniya');
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const runParse = async (selectedFile = file) => {
    if (!selectedFile) return;
    setLoading(true);
    setError('');
    setResult(null);
    setPage(1);

    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
      const response = await fetch(`${apiBase()}/kseniya/parse-text`, {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Ошибка разбора');
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const onFileChange = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    runParse(f);
  };

  const headers = result?.headers || [];
  const allRows = result?.rows || [];
  const totalPages = Math.max(1, Math.ceil(allRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = allRows.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <div className="panel kseniya-panel">
      <h3 style={{ marginTop: 0 }}>
        {profile?.name} — {profile?.title}
      </h3>
      <p className="hint">
        Текстовые выгрузки 1С (.txt / .csv с табами): карточка счёта 90, реестр сделок. Парсер учитывает
        кавычки и переносы строк внутри ячеек.
      </p>

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem' }}>
        <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
          {loading ? 'Разбираю…' : 'Загрузить txt/csv'}
          <input
            type="file"
            accept=".txt,.csv,.tsv"
            style={{ display: 'none' }}
            onChange={onFileChange}
            disabled={loading}
          />
        </label>
        {file && (
          <span className="hint" title={file.name}>
            📄 {file.name}
          </span>
        )}
        {file && (
          <button type="button" className="btn" onClick={() => runParse()} disabled={loading}>
            Обновить
          </button>
        )}
      </div>

      {error && (
        <p className="hint" style={{ color: '#b45309' }}>
          {error}
        </p>
      )}

      {result?.meta && (
        <div className="hint" style={{ marginBottom: '1rem', lineHeight: 1.5 }}>
          <div>
            <strong>Профиль:</strong> {result.profile}
          </div>
          <div>
            <strong>Строк:</strong> {result.rowCount}
            {result.previewTruncated ? ` (в превью первые ${allRows.length})` : ''}
          </div>
          {result.meta.entity && (
            <div>
              <strong>Юрлицо:</strong> {result.meta.entity}
            </div>
          )}
          {result.meta.reportTitle && (
            <div>
              <strong>Отчёт:</strong> {result.meta.reportTitle}
            </div>
          )}
          {result.meta.filterLine && (
            <div>
              <strong>Отбор:</strong> {result.meta.filterLine}
            </div>
          )}
          {result.warnings?.length > 0 && <div style={{ color: '#b45309' }}>{result.warnings.join('; ')}</div>}
        </div>
      )}

      {headers.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ fontSize: '0.82rem' }}>
            <thead>
              <tr>
                {headers.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row, idx) => (
                <tr key={`${safePage}-${idx}`}>
                  {headers.map((h) => (
                    <td key={h} style={{ maxWidth: 280, whiteSpace: 'pre-wrap', verticalAlign: 'top' }}>
                      {row[h] === null || row[h] === undefined || row[h] === '' ? '—' : String(row[h])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {allRows.length > pageSize && (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '1rem' }}>
          <button type="button" className="btn" disabled={safePage <= 1} onClick={() => setPage((p) => p - 1)}>
            ←
          </button>
          <span className="hint">
            {safePage} / {totalPages}
          </span>
          <button
            type="button"
            className="btn"
            disabled={safePage >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            →
          </button>
        </div>
      )}
    </div>
  );
}
