import React from 'react';
import { getParserProfile } from './parserProfiles';

export default function ParserPlaceholder({ profileId }) {
  const profile = getParserProfile(profileId);
  if (!profile) return null;

  return (
    <div className="panel parser-placeholder">
      <h3 style={{ marginTop: 0 }}>
        {profile.name} — {profile.title}
      </h3>
      <p className="hint">{profile.description}</p>
      <p className="hint">
        Статус: <strong>{profile.status === 'ready' ? 'готов' : 'в разработке'}</strong>. Отдельный агент и парсер —
        без смешивания с Антоном (ОС) и Любовью (ОПИФ).
      </p>
      <ul className="hint parser-placeholder__list">
        <li>
          Cursor-агент: <code>.cursor/agents/{profile.cursorAgent}.md</code>
        </li>
        <li>
          Движки: <code>{profile.engines.join(', ')}</code>
        </li>
        <li>
          API: <code>{profile.api.join(', ')}</code>
        </li>
      </ul>
    </div>
  );
}
