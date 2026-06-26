/**
 * Таблица с Excel-сеткой: № строк слева, буквы колонок сверху, многоуровневая шапка.
 */
import { useMemo } from 'react';

function excelColumnLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function buildWideHeaderRows(headers, tableMeta) {
  const dims = (tableMeta.dimensionColumns || []).filter((d) => headers.includes(d));
  const groups = (tableMeta.measureGroups || []).filter((g) => headers.includes(g.leaf));
  const levelCount = tableMeta.headerLevels || 3;
  const headRows = 1 + levelCount;
  const letters = headers.map(
    (_, i) => tableMeta.columnLetters?.[i] || excelColumnLetter(i)
  );

  const rows = [];

  rows.push([
    { text: '', rowSpan: headRows, colSpan: 1, key: 'corner', kind: 'corner' },
    ...letters.map((letter, i) => ({
      text: letter,
      rowSpan: 1,
      colSpan: 1,
      key: `letter-${headers[i]}`,
      kind: 'letter',
      headerKey: headers[i],
    })),
  ]);

  const periodCells = dims.map((d) => ({
    text: d,
    rowSpan: levelCount,
    colSpan: 1,
    key: `dim-${d}`,
    kind: 'dimension',
    headerKey: d,
  }));
  let i = 0;
  while (i < groups.length) {
    const period = groups[i].period;
    let j = i + 1;
    while (j < groups.length && groups[j].period === period) j += 1;
    periodCells.push({
      text: period,
      rowSpan: 1,
      colSpan: j - i,
      key: `period-${i}`,
      kind: 'period',
    });
    i = j;
  }
  rows.push(periodCells);

  const sideCells = [];
  i = 0;
  while (i < groups.length) {
    const side = groups[i].side;
    let j = i + 1;
    while (j < groups.length && groups[j].side === side && groups[j].period === groups[i].period) {
      j += 1;
    }
    sideCells.push({
      text: side,
      rowSpan: 1,
      colSpan: j - i,
      key: `side-${i}`,
      kind: 'side',
    });
    i = j;
  }
  rows.push(sideCells);

  rows.push(
    groups.map((g, idx) => ({
      text: g.indicator,
      rowSpan: 1,
      colSpan: 1,
      key: `ind-${idx}`,
      kind: 'indicator',
      headerKey: g.leaf,
    }))
  );

  return rows;
}

function buildFlatHeaderRows(headers, tableMeta) {
  const letters = tableMeta?.columnLetters || headers.map((_, i) => excelColumnLetter(i));
  return [
    [
      { text: '', rowSpan: 2, colSpan: 1, key: 'corner', kind: 'corner' },
      ...headers.map((h, i) => ({
        text: letters[i],
        rowSpan: 1,
        colSpan: 1,
        key: `letter-${h}`,
        kind: 'letter',
        headerKey: h,
      })),
    ],
    headers.map((h) => ({
      text: h,
      rowSpan: 1,
      colSpan: 1,
      key: `hdr-${h}`,
      kind: 'flat',
      headerKey: h,
    })),
  ];
}

function renderTh(cell, highlightHeaders) {
  const hl = cell.headerKey && highlightHeaders.includes(cell.headerKey);
  return (
    <th
      key={cell.key}
      rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
      colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
      className={[`grid-th grid-th--${cell.kind || 'data'}`, hl ? 'col-new' : ''].filter(Boolean).join(' ')}
    >
      {cell.text}
    </th>
  );
}

function HeaderRows({ plan, highlightHeaders }) {
  const spanLeft = [];

  return plan.map((row, ri) => {
    const cells = [];
    let col = 0;

    if (ri === 0) {
      for (const cell of row) {
        cells.push(renderTh(cell, highlightHeaders));
        if (cell.rowSpan > 1) {
          for (let c = col; c < col + cell.colSpan; c += 1) {
            spanLeft[c] = (spanLeft[c] || 0) + (cell.rowSpan - 1);
          }
        }
        col += cell.colSpan;
      }
      return <tr key={`hdr-${ri}`} className={`grid-hdr-row grid-hdr-row--${ri}`}>{cells}</tr>;
    }

    for (const cell of row) {
      while ((spanLeft[col] || 0) > 0) {
        spanLeft[col] -= 1;
        col += 1;
      }
      cells.push(renderTh(cell, highlightHeaders));
      if (cell.rowSpan > 1) {
        for (let c = col; c < col + cell.colSpan; c += 1) {
          spanLeft[c] = (spanLeft[c] || 0) + (cell.rowSpan - 1);
        }
      }
      col += cell.colSpan;
    }

    return <tr key={`hdr-${ri}`} className={`grid-hdr-row grid-hdr-row--${ri}`}>{cells}</tr>;
  });
}

function reconcileRowClass(row) {
  const brokerFlag = row?.brokerFound;
  const depoFlag = row?.depoFound;
  const hasBrokerCol = brokerFlag !== undefined && brokerFlag !== '';
  const hasDepoCol = depoFlag !== undefined && depoFlag !== '';

  if (hasBrokerCol || hasDepoCol) {
    const brokerOk = brokerFlag === true || brokerFlag === 'true';
    const depoOk = depoFlag === true || depoFlag === 'true';
    if (hasBrokerCol && hasDepoCol) {
      return brokerOk && depoOk
        ? 'reconcile-row reconcile-row--match'
        : 'reconcile-row reconcile-row--value_mismatch';
    }
    if (hasBrokerCol) {
      return brokerOk ? 'reconcile-row reconcile-row--match' : 'reconcile-row reconcile-row--only_left';
    }
    return depoOk ? 'reconcile-row reconcile-row--match' : 'reconcile-row reconcile-row--only_left';
  }

  const status = String(row?.reconcile_status || '').trim();
  if (!status) return '';
  return `reconcile-row reconcile-row--${status.replace(/[^a-z_]/gi, '')}`;
}

function reconcileCellClass(row, header) {
  const status = String(row?.reconcile_status || '');
  if (status !== 'value_mismatch') return '';
  const cols = row?._reconcile_mismatch_columns;
  if (!Array.isArray(cols) || !cols.length) return '';
  const leftKey = header?.startsWith('left_') ? header.slice(5) : header;
  const brokerKey = header?.startsWith('broker_') ? header.slice(7) : header;
  if (
    cols.includes(header) ||
    cols.includes(leftKey) ||
    cols.includes(brokerKey) ||
    header === 'audit_comment'
  ) {
    return 'reconcile-cell reconcile-cell--mismatch';
  }
  return '';
}

export default function ExcelGridTable({ headers, rows, tableMeta, highlightHeaders = [], rowOffset = 0 }) {
  const plan = useMemo(() => {
    if (!headers?.length) return null;
    if (tableMeta?.tableLayout === 'uk_osv_wide') {
      return buildWideHeaderRows(headers, tableMeta);
    }
    return buildFlatHeaderRows(headers, tableMeta);
  }, [headers, tableMeta]);

  if (!plan) return null;

  return (
    <table
      className="data-table excel-grid-table"
      style={{ '--grid-hdr-rows': plan.length }}
    >
      <thead>
        <HeaderRows plan={plan} highlightHeaders={highlightHeaders} />
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri} className={reconcileRowClass(row)}>
            <td className="grid-td grid-td--rownum">{rowOffset + ri + 1}</td>
            {headers.map((h) => (
              <td
                key={h}
                className={[
                  highlightHeaders.includes(h) ? 'col-new' : '',
                  reconcileCellClass(row, h),
                ]
                  .filter(Boolean)
                  .join(' ') || undefined}
              >
                {row[h] ?? ''}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
