import { useState } from 'react';

function statusIcon(status) {
  if (status === 'pass') return '✓';
  if (status === 'warn') return '⚠';
  if (status === 'fail') return '✗';
  return '·';
}

export default function ReasoningTrace({ trace, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!trace?.steps?.length) return null;

  const outcome = trace.outcome || 'plan';
  const isFail = outcome === 'refused' || trace.steps.some((s) => s.status === 'fail');

  return (
    <details
      className={`mv2-reasoning${open ? ' mv2-reasoning--open' : ''}${isFail ? ' mv2-reasoning--fail' : ''}`}
      open={open}
      onToggle={(e) => setOpen(e.target.open)}
    >
      <summary className="mv2-reasoning__summary">
        <span className="mv2-reasoning__title">Как решила</span>
        {trace.summary ? (
          <span className="mv2-reasoning__hint">{trace.summary}</span>
        ) : null}
      </summary>
      <ol className="mv2-reasoning__steps">
        {trace.steps.map((s) => (
          <li
            key={s.id}
            className={`mv2-reasoning__step mv2-reasoning__step--${s.status || 'pass'}`}
          >
            <span className="mv2-reasoning__icon" aria-hidden>
              {statusIcon(s.status)}
            </span>
            <div className="mv2-reasoning__body">
              <span className="mv2-reasoning__label">{s.title}</span>
              <span className="mv2-reasoning__detail">{s.detail}</span>
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}
