import React, { useCallback, useEffect, useRef, useState } from 'react';
import { InboxTreeNode } from './inboxTreeShared.jsx';

export default function WorkspaceTree({
  api,
  chatSessionId,
  refreshKey = 0,
  uploading = false,
  uploadProgress = null,
  onUploadPick,
  onInboxChanged,
}) {
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const [tree, setTree] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!chatSessionId) {
      setTree(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${api}/chats/${chatSessionId}/inbox/tree`);
      const data = await res.json();
      if (res.ok) setTree(data.tree);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [api, chatSessionId]);

  useEffect(() => {
    refresh();
    setSelectedPath('');
  }, [refresh, chatSessionId, refreshKey]);

  const parseDeleteError = async (res) => {
    const text = await res.text();
    try {
      const data = JSON.parse(text);
      return data.error || text;
    } catch {
      if (res.status === 404) return 'Сервер без DELETE — перезапусти бэк (cd server && node index.js)';
      return text || `HTTP ${res.status}`;
    }
  };

  const clearAll = async () => {
    if (!chatSessionId || !tree?.totalFiles) return;
    if (!window.confirm(`Очистить всё хранилище чата? (${tree.totalFiles} файл(ов))`)) return;
    setBusy(true);
    try {
      const res = await fetch(`${api}/chats/${chatSessionId}/inbox`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await parseDeleteError(res));
      const data = await res.json();
      setSelectedPath('');
      onInboxChanged?.(data.message);
      await refresh();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteSelected = async () => {
    if (!chatSessionId || !selectedPath) return;
    if (!window.confirm(`Удалить «${selectedPath}» из хранилища?`)) return;
    setBusy(true);
    try {
      const q = new URLSearchParams({ path: selectedPath });
      const res = await fetch(`${api}/chats/${chatSessionId}/inbox/item?${q}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await parseDeleteError(res));
      const data = await res.json();
      setSelectedPath('');
      onInboxChanged?.(data.message);
      await refresh();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  const root = tree?.tree;
  const byKind = tree?.byKind || {};
  const disabled = uploading || busy;

  return (
    <aside className="mv2-workspace" aria-label="Хранилище чата">
      <div className="mv2-workspace__head">
        <div className="mv2-workspace__title">
          <span>💾 Хранилище</span>
          {tree?.totalFiles > 0 && (
            <span className="mv2-workspace__count">{tree.totalFiles.toLocaleString('ru-RU')}</span>
          )}
        </div>
        <div className="mv2-workspace__path" title={tree?.workspaceRoot || tree?.inboxRoot}>
          {tree?.displayPath || (chatSessionId ? `chat #${chatSessionId}` : '—')}
        </div>
        <p className="mv2-workspace__sub">Загрузка файлов — только здесь</p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".xls,.xlsx,.xlsm,.txt,.csv,.tsv,.pdf"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onUploadPick?.(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        webkitdirectory=""
        directory=""
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onUploadPick?.(e.target.files);
          e.target.value = '';
        }}
      />

      <div className="mv2-workspace__actions">
        <button type="button" className="mv2-workspace__btn" disabled={disabled} onClick={() => fileInputRef.current?.click()}>
          Файлы
        </button>
        <button type="button" className="mv2-workspace__btn" disabled={disabled} onClick={() => folderInputRef.current?.click()}>
          Папка
        </button>
        <button type="button" className="mv2-workspace__btn mv2-workspace__btn--ghost" disabled={loading || busy} onClick={refresh}>
          ↻
        </button>
      </div>

      {tree?.totalFiles > 0 && (
        <div className="mv2-workspace__actions mv2-workspace__actions--danger">
          {selectedPath ? (
            <button type="button" className="mv2-workspace__btn mv2-workspace__btn--danger" disabled={disabled} onClick={deleteSelected}>
              Удалить
            </button>
          ) : null}
          <button type="button" className="mv2-workspace__btn mv2-workspace__btn--danger" disabled={disabled} onClick={clearAll}>
            Очистить всё
          </button>
        </div>
      )}

      {uploading && uploadProgress && (
        <div className="mv2-workspace__progress">
          Пачка {uploadProgress.chunk}/{uploadProgress.total} · {uploadProgress.files} файл(ов)
        </div>
      )}

      {!chatSessionId ? (
        <p className="mv2-workspace__empty">Открой или создай чат</p>
      ) : loading && !tree ? (
        <p className="mv2-workspace__empty">Сканирую диск…</p>
      ) : !tree?.totalFiles ? (
        <p className="mv2-workspace__empty">Пусто. Нажми «Папка» и залей выгрузку целиком.</p>
      ) : (
        <>
          {Object.values(byKind).some((n) => n > 0) && (
            <div className="mv2-workspace__stats">
              {byKind.broker > 0 && <span>broker {byKind.broker}</span>}
              {byKind.depo > 0 && <span>DEPO {byKind.depo}</span>}
              {byKind.uk > 0 && <span>УК {byKind.uk}</span>}
              {byKind.other > 0 && <span>прочее {byKind.other}</span>}
            </div>
          )}
          <div className="mv2-workspace__tree">
            {(root?.children || []).map((ch) => (
              <InboxTreeNode
                key={`${ch.type}-${ch.path || ch.name}`}
                node={ch}
                depth={0}
                selectedPath={selectedPath}
                onSelectPath={(scope) => setSelectedPath(scope?.path || '')}
                mode="manage"
              />
            ))}
          </div>
          {selectedPath ? (
            <div className="mv2-workspace__footer" title={selectedPath}>
              {selectedPath}
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}
