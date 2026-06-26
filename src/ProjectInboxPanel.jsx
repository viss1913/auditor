import React, { useCallback, useEffect, useRef, useState } from 'react';

const KIND_ICONS = { broker: '📁', uk: '📊', depo: '📄', other: '📎' };

function formatCount(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString('ru-RU');
}

export default function ProjectInboxPanel({
  api,
  auditorHeaders,
  auditorSlug,
  projectId,
  chatSessionId,
  onParseResult,
  onStatusMessage,
  onRefreshRequest,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [parsing, setParsing] = useState(false);
  const fileRef = useRef(null);
  const folderRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setSources([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${api}/projects/${projectId}/inbox`, {
        headers: auditorHeaders(),
      });
      const data = await res.json();
      if (res.ok) setSources(data.sources || []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [api, auditorHeaders, projectId]);

  useEffect(() => {
    refresh();
  }, [refresh, auditorSlug, onRefreshRequest]);

  const uploadFiles = async (fileList) => {
    if (!projectId || !fileList?.length) return;
    setUploading(true);
    onStatusMessage?.(`Загружаю ${fileList.length} файл(ов) в хранилище…`);
    try {
      const fd = new FormData();
      const meta = [];
      for (const f of fileList) {
        fd.append('files', f, f.name);
        meta.push({ name: f.name, relativePath: f.webkitRelativePath || f.name });
      }
      fd.append('filesMeta', JSON.stringify(meta));
      const res = await fetch(`${api}/projects/${projectId}/inbox/upload`, {
        method: 'POST',
        headers: auditorHeaders(),
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'upload failed');
      onStatusMessage?.(data.message || `Сохранено ${data.saved}`);
      await refresh();
    } catch (e) {
      onStatusMessage?.(`Ошибка загрузки: ${e.message}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
      if (folderRef.current) folderRef.current.value = '';
    }
  };

  const parseFromInbox = async (userMessage = 'брокер 1F018') => {
    if (!projectId) return;
    setParsing(true);
    onStatusMessage?.('Парс из хранилища…');
    try {
      const res = await fetch(`${api}/projects/${projectId}/inbox/parse`, {
        method: 'POST',
        headers: { ...auditorHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatSessionId: chatSessionId || null,
          userMessage,
          filePrefix: '1F018_',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'parse failed');
      onParseResult?.(data);
      onStatusMessage?.(data.assistantMessage || 'Готово');
      await refresh();
    } catch (e) {
      onStatusMessage?.(`Парс: ${e.message}`);
    } finally {
      setParsing(false);
    }
  };

  const brokerSource = sources.find((s) => s.kind === 'broker');
  const broker1f018 = brokerSource?.prefix1F018 ?? 0;
  const totalFiles = sources.reduce((s, x) => s + (x.fileCount || 0), 0);
  const busy = loading || uploading || parsing || disabled;

  return (
    <div className={`mv2-inbox${open ? ' mv2-inbox--open' : ''}`}>
      <button
        type="button"
        className="mv2-inbox__toggle"
        onClick={() => setOpen((v) => !v)}
        title="Хранилище файлов на сервере"
      >
        <span className="mv2-inbox__toggle-icon">📥</span>
        <span>Хранилище</span>
        {totalFiles > 0 && <span className="mv2-inbox__badge">{formatCount(totalFiles)}</span>}
        <span className="mv2-inbox__chevron">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="mv2-inbox__body">
          {!projectId ? (
            <p className="mv2-inbox__hint">Выбери проект — тогда появится хранилище на сервере.</p>
          ) : (
            <>
              <p className="mv2-inbox__hint">
                Все загрузки идут сюда: <strong>{auditorSlug}</strong> / проект #{projectId}. Парсер
                читает только с диска сервера.
              </p>
              <div className="mv2-inbox__grid">
                {sources.map((src) => (
                  <div key={src.kind} className="mv2-inbox__card">
                    <div className="mv2-inbox__card-head">
                      <span>{KIND_ICONS[src.kind] || '📎'}</span>
                      <span>{src.label}</span>
                    </div>
                    <div className="mv2-inbox__card-meta">
                      {formatCount(src.fileCount)} файл(ов)
                      {src.kind === 'broker' && src.prefix1F018 != null && (
                        <span className="mv2-inbox__card-sub">
                          · 1F018: {formatCount(src.prefix1F018)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mv2-inbox__actions">
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  accept=".xls,.xlsx,.xlsm,.txt,.csv,.tsv,.pdf"
                  className="mv2-inbox__file-input"
                  onChange={(e) => uploadFiles(Array.from(e.target.files || []))}
                />
                <input
                  ref={folderRef}
                  type="file"
                  multiple
                  webkitdirectory=""
                  directory=""
                  className="mv2-inbox__file-input"
                  onChange={(e) => uploadFiles(Array.from(e.target.files || []))}
                />
                <button
                  type="button"
                  className="mv2-inbox__btn"
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                >
                  {uploading ? 'Загружаю…' : 'Файлы'}
                </button>
                <button
                  type="button"
                  className="mv2-inbox__btn"
                  disabled={busy}
                  onClick={() => folderRef.current?.click()}
                >
                  {uploading ? 'Загружаю…' : 'Папка'}
                </button>
                <button
                  type="button"
                  className="mv2-inbox__btn mv2-inbox__btn--primary"
                  disabled={busy || !broker1f018}
                  onClick={() => parseFromInbox('брокер 1F018')}
                >
                  {parsing ? 'Парсю…' : `1F018 (${formatCount(broker1f018)})`}
                </button>
                <button
                  type="button"
                  className="mv2-inbox__btn mv2-inbox__btn--ghost"
                  disabled={busy}
                  onClick={refresh}
                >
                  Обновить
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
