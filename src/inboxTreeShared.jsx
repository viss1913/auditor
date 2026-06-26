import React, { useState } from 'react';

export function formatInboxSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function parentPath(pathStr) {
  const parts = String(pathStr || '').split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

export function findTreeFolder(root, pathStr) {
  const parts = String(pathStr || '').split('/').filter(Boolean);
  if (!parts.length) return root;
  let node = root;
  for (const part of parts) {
    const child = (node?.children || []).find((c) => c.type === 'folder' && c.name === part);
    if (!child) return null;
    node = child;
  }
  return node;
}

function sortDirEntries(items) {
  return [...items].sort((a, b) => {
    if (a.type !== b.type) {
      if (a.type === 'folder') return -1;
      if (b.type === 'folder') return 1;
      return 0;
    }
    return String(a.name).localeCompare(String(b.name), 'ru');
  });
}

export function listDirAtPath(treeRoot, pathStr) {
  if (!treeRoot?.tree) return [];
  const parts = String(pathStr || '').split('/').filter(Boolean);
  if (!parts.length) {
    return sortDirEntries((treeRoot.tree.children || []).filter((c) => c.type !== 'more'));
  }
  const folder = findTreeFolder(treeRoot.tree, pathStr);
  return sortDirEntries((folder?.children || []).filter((c) => c.type !== 'more'));
}

/** Проводник: одна папка за раз, клик — выбор, двойной клик по папке — войти. */
export function InboxFolderBrowser({
  tree,
  browsePath = '',
  highlightedPath = '',
  selectedPath = '',
  onHighlight,
  onNavigate,
}) {
  const entries = listDirAtPath(tree, browsePath);
  const crumbs = browsePath ? browsePath.split('/').filter(Boolean) : [];

  return (
    <div className="mv2-inbox-browser">
      <div className="mv2-inbox-browser__nav">
        <button
          type="button"
          className="mv2-inbox-browser__up"
          disabled={!browsePath}
          title="На уровень выше"
          onClick={() => onNavigate?.(parentPath(browsePath))}
        >
          ↑
        </button>
        <div className="mv2-inbox-browser__crumbs">
          <button type="button" className="mv2-inbox-browser__crumb" onClick={() => onNavigate?.('')}>
            корень
          </button>
          {crumbs.map((seg, i) => {
            const p = crumbs.slice(0, i + 1).join('/');
            return (
              <span key={p} className="mv2-inbox-browser__crumb-wrap">
                <span className="mv2-inbox-browser__sep">/</span>
                <button type="button" className="mv2-inbox-browser__crumb" onClick={() => onNavigate?.(p)}>
                  {seg}
                </button>
              </span>
            );
          })}
        </div>
      </div>

      <div className="mv2-inbox-browser__list">
        {entries.map((item) => {
          const isFolder = item.type === 'folder';
          const itemPath = isFolder ? item.path || item.name : item.path;
          const highlighted = highlightedPath === itemPath;
          const confirmed = selectedPath === itemPath;
          return (
            <button
              key={`${item.type}-${itemPath}`}
              type="button"
              className={`mv2-inbox-browser__row${highlighted ? ' mv2-inbox-browser__row--hl' : ''}${
                confirmed ? ' mv2-inbox-browser__row--picked' : ''
              }`}
              title={itemPath}
              onClick={() => onHighlight?.({ path: itemPath, type: isFolder ? 'folder' : 'file' })}
              onDoubleClick={(e) => {
                e.preventDefault();
                if (isFolder) onNavigate?.(itemPath);
              }}
            >
              <span className="mv2-inbox-browser__icon">{isFolder ? '📁' : '📄'}</span>
              <span className="mv2-inbox-browser__name">{item.name}</span>
              {isFolder && item.fileCount > 0 ? (
                <span className="mv2-inbox-browser__meta">{item.fileCount}</span>
              ) : null}
              {!isFolder && item.size ? (
                <span className="mv2-inbox-browser__meta">{formatInboxSize(item.size)}</span>
              ) : null}
            </button>
          );
        })}
        {!entries.length ? <p className="mv2-inbox-browser__empty">Пустая папка</p> : null}
      </div>

      <p className="mv2-inbox-browser__hint">Клик — отметить · двойной клик по папке — войти</p>
    </div>
  );
}

/** Дерево для левого хранилища: свёрнуто по умолчанию, шеврон раскрывает. */
export function InboxTreeNode({
  node,
  depth = 0,
  selectedPath,
  onSelectPath,
  mode = 'manage',
}) {
  const [open, setOpen] = useState(false);
  if (!node) return null;

  if (node.type === 'more') {
    return (
      <div className="mv2-tree__more" style={{ paddingLeft: `${8 + depth * 14}px` }}>
        {node.name}
      </div>
    );
  }

  if (node.type === 'file') {
    const selected = selectedPath === node.path;
    return (
      <button
        type="button"
        className={`mv2-tree__file${selected ? ' mv2-tree__file--selected' : ''}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        title={node.path}
        onClick={() => onSelectPath?.({ path: node.path, type: 'file' })}
      >
        <span className="mv2-tree__icon">📄</span>
        <span className="mv2-tree__name">{node.name}</span>
        {node.size ? <span className="mv2-tree__meta">{formatInboxSize(node.size)}</span> : null}
      </button>
    );
  }

  const childCount = node.fileCount || node.children?.length || 0;
  const folderPath = node.path || node.name;
  const selected = selectedPath === folderPath;
  return (
    <div className="mv2-tree__folder-wrap">
      <button
        type="button"
        className={`mv2-tree__folder${selected ? ' mv2-tree__file--selected' : ''}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        title={folderPath}
        onClick={() => {
          if (folderPath) onSelectPath?.({ path: folderPath, type: 'folder' });
        }}
      >
        <span
          className="mv2-tree__chev"
          role="presentation"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {open ? '▾' : '▸'}
        </span>
        <span className="mv2-tree__icon">📁</span>
        <span className="mv2-tree__name">{node.name || 'корень'}</span>
        {childCount > 0 && <span className="mv2-tree__meta">{childCount}</span>}
      </button>
      {open &&
        (node.children || []).map((ch) => (
          <InboxTreeNode
            key={`${ch.type}-${ch.path || ch.name}`}
            node={ch}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelectPath={onSelectPath}
            mode={mode}
          />
        ))}
    </div>
  );
}
