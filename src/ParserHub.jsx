import React from 'react';
import { PARSER_PROFILES } from './parserProfiles';

const STATUS_LABEL = {
  ready: { text: 'Готов', className: 'parser-hub__status--ready' },
  planned: { text: 'В плане', className: 'parser-hub__status--planned' },
};

export default function ParserHub({ selectedId, onSelect, variant = 'grid' }) {
  if (variant === 'sidebar') {
    return (
      <nav className="parser-hub-sidebar" aria-label="Кураторы разбора">
        <div className="parser-hub-sidebar__label">Кураторы</div>
        {PARSER_PROFILES.map((profile) => {
          const status = STATUS_LABEL[profile.status] || STATUS_LABEL.planned;
          const active = selectedId === profile.id;
          return (
            <button
              key={profile.id}
              type="button"
              className={`parser-hub-sidebar__item${active ? ' parser-hub-sidebar__item--active' : ''}`}
              onClick={() => onSelect(profile.id)}
              aria-pressed={active}
              title={profile.title}
            >
              <span className="parser-hub-sidebar__name">{profile.name}</span>
              <span className={`parser-hub-sidebar__status ${status.className}`}>{status.text}</span>
            </button>
          );
        })}
      </nav>
    );
  }

  return (
    <section className="parser-hub panel" aria-label="Выбор парсера">
      <div className="parser-hub__head">
        <h2 className="parser-hub__title">Кураторы разбора</h2>
        <p className="hint parser-hub__lead">
          У каждого свой формат и свой скрипт. Сначала решаем задачу отдельно — потом сведём в общий роутер.
        </p>
      </div>
      <div className="parser-hub__grid">
        {PARSER_PROFILES.map((profile) => {
          const status = STATUS_LABEL[profile.status] || STATUS_LABEL.planned;
          const active = selectedId === profile.id;
          return (
            <button
              key={profile.id}
              type="button"
              className={`parser-hub__card${active ? ' parser-hub__card--active' : ''}`}
              onClick={() => onSelect(profile.id)}
              aria-pressed={active}
            >
              <div className="parser-hub__card-top">
                <span className="parser-hub__name">{profile.name}</span>
                <span className={`parser-hub__status ${status.className}`}>{status.text}</span>
              </div>
              <strong className="parser-hub__card-title">{profile.title}</strong>
              <p className="hint parser-hub__desc">{profile.description}</p>
              <p className="parser-hub__meta">
                <span>агент: {profile.cursorAgent}</span>
                <span> · {profile.engines.slice(0, 2).join(', ')}</span>
              </p>
            </button>
          );
        })}
      </div>
    </section>
  );
}
