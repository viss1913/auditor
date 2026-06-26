import React, { useCallback, useEffect, useState } from 'react';
import { InboxFolderBrowser, parentPath } from './inboxTreeShared.jsx';

export default function InboxPicker({
  api,
  chatSessionId,
  refreshKey = 0,
  parseScope,
  onParseScopeChange,
  onParseSelected,
  disabled = false,
  variant = 'attach',
  onClose,
}) {
  const [tree, setTree] = useState(null);
  const [loading, setLoading] = useState(false);
  const [browsePath, setBrowsePath] = useState('');
  const [highlighted, setHighlighted] = useState(null);

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
  }, [refresh, refreshKey]);

  useEffect(() => {
    if (!tree?.totalFiles) {
      setBrowsePath('');
      setHighlighted(null);
      return;
    }
    if (parseScope?.path) {
      setBrowsePath(parseScope.type === 'file' ? parentPath(parseScope.path) : parseScope.path);
      setHighlighted(parseScope);
      return;
    }
    setBrowsePath('');
    setHighlighted(null);
  }, [tree?.totalFiles, parseScope?.path, parseScope?.type]);

  const selectedPath = parseScope?.path || '';
  const total = tree?.totalFiles || 0;
  const highlightPath = highlighted?.path || '';
  const canConfirm = Boolean(highlighted?.path && highlighted.path !== selectedPath);

  const confirmSelection = () => {
    if (!highlighted?.path) return;
    onParseScopeChange?.(highlighted);
  };

  const body = (
    <>
      {!chatSessionId ? (
        <p className="mv2-inbox-picker__hint">Сначала открой чат</p>
      ) : loading && !tree ? (
        <p className="mv2-inbox-picker__hint">Загружаю структуру…</p>
      ) : !total ? (
        <p className="mv2-inbox-picker__hint">
          Хранилище пусто — загрузи папку <strong>слева</strong>.
        </p>
      ) : (
        <div className="mv2-inbox-picker__tree">
          <InboxFolderBrowser
            tree={tree}
            browsePath={browsePath}
            highlightedPath={highlightPath}
            selectedPath={selectedPath}
            onHighlight={setHighlighted}
            onNavigate={setBrowsePath}
          />
        </div>
      )}

      {total > 0 && (
        <div className="mv2-inbox-picker__scope">
          {highlighted?.path ? (
            <span className="mv2-inbox-picker__scope-label" title={highlighted.path}>
              {highlighted.type === 'file' ? '📄' : '📁'} {highlighted.path}
            </span>
          ) : (
            <span className="mv2-inbox-picker__scope-label mv2-inbox-picker__scope-label--muted">
              Отметь файл или папку
            </span>
          )}
          <button
            type="button"
            className="mv2-inbox-picker__choose-btn"
            disabled={disabled || !canConfirm}
            onClick={confirmSelection}
          >
            Выбрать
          </button>
          {parseScope?.path && variant === 'attach' ? (
            <button
              type="button"
              className="mv2-inbox-picker__parse-btn"
              disabled={disabled || !total}
              onClick={() => {
                onClose?.();
                onParseSelected?.();
              }}
            >
              Парсить…
            </button>
          ) : null}
        </div>
      )}
    </>
  );

  if (variant === 'attach') {
    return (
      <div className="mv2-attach-menu mv2-attach-menu--tree">
        <div className="mv2-attach-menu__title">Что парсить из хранилища</div>
        {body}
      </div>
    );
  }

  return <div className="mv2-inbox-picker">{body}</div>;
}
