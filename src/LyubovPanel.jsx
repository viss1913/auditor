import React from 'react';
import { getParserProfile } from './parserProfiles';

const LINKS = [
  { page: 'opif_uk', label: 'УК', hint: 'Выгрузка управляющей компании → trades' },
  { page: 'opif_broker', label: 'Брокер', hint: 'Отчёт брокера → trades' },
  { page: 'opif_depo', label: 'ДЕПО', hint: 'Депозитарий → trades' },
  { page: 'opif_audit', label: 'Аудит', hint: 'Сверка УК · Брокер · ДЕПО' },
];

export default function LyubovPanel({ onNavigate }) {
  const profile = getParserProfile('lyubov');

  return (
    <div className="parser-workspace">
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>{profile?.name} — {profile?.title}</h3>
        <p className="hint">{profile?.description}</p>
        <p className="hint" style={{ marginBottom: '1rem' }}>
          API: <code>{profile?.api?.join(', ')}</code>
        </p>
        <div className="parser-hub__grid parser-hub__grid--links">
          {LINKS.map((link) => (
            <button
              key={link.page}
              type="button"
              className="parser-hub__card parser-hub__card--link"
              onClick={() => onNavigate(link.page)}
            >
              <strong className="parser-hub__card-title">{link.label}</strong>
              <p className="hint parser-hub__desc">{link.hint}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
