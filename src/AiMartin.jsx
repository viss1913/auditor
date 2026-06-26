import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import './martin-v2.css';
import ExcelGridTable from './ExcelGridTable';
import ReasoningTrace from './ReasoningTrace';
import WorkspaceTree from './WorkspaceTree';
import InboxPicker from './InboxPicker';
import { isTableCommand, isTableQuery, looksLikeTableMutationIntent, looksLikeReconcileIntent, resolvePendingTableConfirmation } from './martinChatIntent.js';
import { isEgrulIntent } from './egrulIntent.js';
import { apiBase, normalizeUploadPath, postFormData } from './apiBase.js';
import { authHeaders } from './auth.js';
import PdfScenarioBadge from './PdfScenarioBadge.jsx';
import PdfColumnEditor from './PdfColumnEditor.jsx';

const API = apiBase();

const PARSE_BRIEF_HINT =
  'Напиши задачу в чате: сценарий, правила, что разобрать — потом Enter. Без текста парс не стартую.';

function hasParseBrief(text) {
  return String(text || '').trim().length >= 3;
}

function isInboxTableBrief(text) {
  const t = String(text || '').trim();
  if (t.length < 3) return false;
  return (
    /(?:созда(?:ть|й)|сдела(?:ть|й)|надо|нужно).{0,24}таблиц[ауе]?\s*:/i.test(t) ||
    /таблиц[ауе]\s*:[^\n,;]+[,;]/i.test(t) ||
    /колонк[аи]\s*:/i.test(t)
  );
}

function fileMetasFromParseScope(scope) {
  if (!scope?.path) return [];
  const rel = String(scope.path).replace(/\\/g, '/');
  const name = rel.split('/').filter(Boolean).pop() || rel;
  return [{ name, relativePath: rel }];
}

function isBrokerInboxFileName(name) {
  return /^1f\d{3}_/i.test(String(name || ''));
}

/** Не тащим opif_broker с прошлого парса, если в 📎 выбран один не-брокерский Excel. */
function resolveScenarioForScopedParse(scenarioId, scope) {
  if (!scope?.path || scope.type === 'folder') return scenarioId || null;
  const base = String(scope.path).split('/').pop() || '';
  if (scenarioId === 'opif_broker' && !isBrokerInboxFileName(base)) return null;
  if (scenarioId === 'opif_depo' && !/\.pdf$/i.test(base)) return null;
  return scenarioId || null;
}

function stripOpifHintsForScopedFile(answers, scope) {
  if (!scope?.path || scope.type === 'folder') return answers;
  const base = String(scope.path).split('/').pop() || '';
  if (isBrokerInboxFileName(base) || /\.pdf$/i.test(base)) return answers;
  const next = { ...answers };
  if (next.scenarioId === 'opif_broker' || next.scenarioId === 'opif_depo') {
    delete next.scenarioId;
  }
  delete next.filePrefix;
  delete next.brokerSection;
  return next;
}

function inboxParseLoadingHint(scope, probe, userMessage = '') {
  if (scope?.path) {
    const label = String(scope.path).split('/').pop() || scope.path;
    return scope.type === 'folder'
      ? `Разбираю папку «${label}»…`
      : `Разбираю «${label}»…`;
  }
  if (probe?.suggestedScenario === 'opif_broker' || /брокер|1f018/i.test(userMessage || '')) {
    return `Брокер из хранилища — ${probe.prefixMatches || probe.totalFiles || '?'} файл(ов)…`;
  }
  if (probe?.byKind?.pdf) {
    return probe.suggestedScenario === 'opif_depo' ? 'ДЕПО из хранилища…' : 'PDF/сканы из хранилища…';
  }
  return 'Разбираю из хранилища…';
}
/** Файлов в одной пачке (папка 4000+ → по 1 файлу). */
const INBOX_UPLOAD_CHUNK = 8;
const INBOX_FOLDER_SINGLE_THRESHOLD = 30;
const INBOX_UPLOAD_RETRIES = 2;
/** Сколько файлов в одном HTTP-запросе batch-start (legacy). */
const BROKER_UPLOAD_CHUNK = 80;
function normalizeBrokerPrefix(prefix) {
  const p = String(prefix || '').trim();
  if (!p) return '1F018_';
  return p.endsWith('_') ? p : `${p}_`;
}

function chunkFileList(files, size = BROKER_UPLOAD_CHUNK) {
  const chunks = [];
  for (let i = 0; i < files.length; i += size) {
    chunks.push(files.slice(i, i + size));
  }
  return chunks;
}

function filterBrokerUploadFiles(files, { filePrefix, scenarioId } = {}) {
  const prefix = normalizeBrokerPrefix(
    filePrefix || (scenarioId === 'opif_broker' ? '1F018' : '')
  );
  if (!filePrefix && scenarioId !== 'opif_broker') {
    return { files: files || [], meta: null };
  }
  const matched = (files || []).filter(
    (f) =>
      String(f.name || '')
        .toLowerCase()
        .startsWith(prefix.toLowerCase()) && /\.(xlsx|xls|xlsm)$/i.test(f.name || '')
  );
  const chunks = chunkFileList(matched);
  return {
    files: matched,
    meta: {
      totalStaged: files?.length || 0,
      prefix,
      matched: matched.length,
      uploading: matched.length,
      chunks: chunks.length,
    },
  };
}

function formatBrokerUploadNote(meta) {
  if (!meta) return '';
  if (!meta.matched) {
    return `Нет excel с префиксом \`${meta.prefix}*\` среди ${meta.totalStaged} файлов в папке.`;
  }
  if (meta.chunks > 1) {
    return `Из папки **${meta.totalStaged}** файлов → **${meta.matched}** с \`${meta.prefix}*\`, разобью на **${meta.chunks}** пачек по ${BROKER_UPLOAD_CHUNK}.`;
  }
  if (meta.matched < meta.totalStaged) {
    return `Из папки **${meta.totalStaged}** файлов → **${meta.uploading}** с \`${meta.prefix}*\`.`;
  }
  return `Отправляю **${meta.uploading}** файл(ов) брокера.`;
}

const CLASSIFY_ROW_LIMIT = 120;
const SNAPSHOT_PAGE_SIZE = 50;
const CHAT_WIDTH_MIN = 280;
const CHAT_WIDTH_MAX_RATIO = 0.58;
const TABLE_WIDTH_MIN = 320;

function readInitialChatWidth() {
  try {
    const saved = parseInt(localStorage.getItem('mv2_chat_width') || '', 10);
    if (Number.isFinite(saved) && saved >= CHAT_WIDTH_MIN) return saved;
  } catch {
    /* ignore */
  }
  if (typeof window !== 'undefined') {
    return Math.round(Math.min(560, Math.max(CHAT_WIDTH_MIN, window.innerWidth * 0.36)));
  }
  return 400;
}

function MartinLoader({ hint = 'Думаю…' }) {
  return (
    <div className="mv2-chat-row mv2-chat-row--assistant">
      <div className="mv2-avatar mv2-avatar--martin">M</div>
      <div className="mv2-loader-bubble" role="status" aria-live="polite">
        <span className="mv2-loader-bubble__spinner" aria-hidden />
        <span className="mv2-loader-bubble__text">{hint}</span>
      </div>
    </div>
  );
}

const SCENARIO_PHRASES = {
  os_01_flat: 'Плоская таблица: только год, тип и метрики',
  os_01_hierarchy: 'С группой, РТК и ОП',
  os_01_cost_only: 'Без амортизации, только стоимость',
  from_target: 'Как в эталоне',
  uk_card: 'Карточка УК 58.01',
  wide_metrics: 'Годы в колонках (wide)',
  os_76_account_card: 'Карточка счёта 76',
  os_08_osv: 'ОСВ 08',
  card_90_tsv: 'Карточка 90 (txt)',
  deals_registry_tsv: 'Реестр сделок (txt)',
};

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim();
}

function resolveQuestionAnswerFromText(text, question) {
  if (!question) return null;
  const t = normalizeText(text);
  if (!t) return null;

  for (const opt of question.options || []) {
    const label = normalizeText(opt.label);
    const value = normalizeText(opt.value);
    if (t === label || t === value) return opt.value;
    if (label && (label.includes(t) || t.includes(label))) return opt.value;
  }

  if (question.id === 'pick_tree_flatten') {
    if (/^(да|yes|разверн|плоск|подтверд|ок|окей|давай|ага|угу|конечно)/i.test(t)) return 'confirm';
    if (/^(нет|no|осв|08|оборотн|не надо|остав)/i.test(t)) {
      const osv = (question.options || []).find((o) => String(o.value).includes('os_08'));
      return osv?.value || 'scenario:os_08_osv';
    }
  }

  if (question.id === 'pick_scenario') {
    if (/плоск|flat|без дерев/i.test(t)) return 'os_01_flat';
    if (/дерев|иерарх|hierarch|с групп/i.test(t)) return 'os_01_hierarchy';
  }

  if (question.id === 'pick_merge_strategy') {
    if (/одн|общ|скле|merge|вместе/i.test(t)) return 'one_table';
    if (/групп|структур/i.test(t)) return 'by_group';
    if (/файл|отдельн|кажд/i.test(t)) return 'per_file';
    const opt = (question.options || []).find((o) => normalizeText(o.label).includes(t));
    if (opt) return opt.value;
  }

  const numMatch = t.match(/\b(\d+)\b/);
  if (numMatch && question.id?.includes('column')) {
    const hit = (question.options || []).find((o) => String(o.value) === numMatch[1]);
    if (hit) return hit.value;
  }

  return null;
}

function resolveScenarioFromText(text, scenarios) {
  const t = normalizeText(text);
  if (!t) return null;
  for (const s of scenarios || []) {
    if (normalizeText(s.name).includes(t) || t.includes(normalizeText(s.id))) return s.id;
  }
  if (/плоск|flat/i.test(t)) return 'os_01_flat';
  if (/дерев|иерарх|hierarch/i.test(t)) return 'os_01_hierarchy';
  const phraseHit = Object.entries(SCENARIO_PHRASES).find(([, phrase]) => normalizeText(phrase).includes(t));
  return phraseHit?.[0] || null;
}

function mapSnapshotsToTables(snapshots, sourceName = '') {
  return (snapshots || []).map((s) => ({
    snapshotId: s.snapshotId,
    label: s.label,
    sheetName: s.sheetName,
    rowCount: s.rowCount,
    scenarioId: s.scenarioId,
    sourceFileName: sourceName,
  }));
}

function formatChatContent(text) {
  const raw = String(text || '');
  if (!raw) return null;
  const parts = raw.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

function formatTableTab(t) {
  const src = String(t.sourceFileName || '')
    .replace(/\.(xlsx|xls|xlsm|pdf|txt|csv)$/i, '')
    .trim();
  const sheet = String(t.sheetName || '').trim();
  const count =
    t.rowCount != null ? ` (${Number(t.rowCount).toLocaleString('ru-RU')})` : '';

  if (src && sheet && src.toLowerCase() !== sheet.toLowerCase()) {
    return `${src} · ${sheet}${count}`;
  }
  if (src) return `${src}${count}`;
  if (sheet) return `${sheet}${count}`;

  const label = String(t.label || '').trim();
  let title = label.replace(/\.(xlsx|xls|xlsm|pdf|txt|csv)$/i, '').slice(0, 36);
  if (/ · \d/.test(label)) {
    title = label.slice(0, 40);
  } else if (/1f018|брокер/i.test(label)) title = 'Брокер';
  else if (/upd|упд|счет-фактура/i.test(label)) title = 'УПД';
  else if (/депо|depo/i.test(label) && /\.pdf$/i.test(label)) title = 'Депо';
  else if (/\.pdf$/i.test(label)) title = 'PDF';
  else if (/58\.?1|ук|uk|карт/i.test(label)) title = 'УК 58.01';
  return `${title || `Таблица #${t.snapshotId}`}${count}`;
}

function mapServerSnapshotsToTabs(snapshots = []) {
  return snapshots.map((s) => ({
    snapshotId: s.snapshotId,
    label: s.label,
    sheetName: s.sheetName,
    rowCount: s.rowCount,
    scenarioId: s.scenarioId,
    sourceFileName: s.sourceFileName || '',
  }));
}

/** Excel с несколькими листами → по умолчанию парсим все, не только defaultSheet. */
function resolveInboxSheetParse({
  sheetNames = [],
  userMessage = '',
  parseAllSheets,
  targetSheetName,
  nextAnswers,
}) {
  const count = sheetNames.length;
  const allSheetsPhrase = /все\s+лист|кажд\w+\s+лист|multi.?sheet|все\s+вкладк/i.test(userMessage || '');
  const pickedSheet = nextAnswers?.sheetName || null;
  if (pickedSheet) {
    return { parseAllSheets: false, sheetName: pickedSheet };
  }
  const forceAll =
    parseAllSheets === true ||
    parseAllSheets === 1 ||
    parseAllSheets === '1' ||
    allSheetsPhrase ||
    count > 1;
  if (forceAll) {
    return { parseAllSheets: true, sheetName: null };
  }
  return { parseAllSheets: false, sheetName: targetSheetName || null };
}

export default function AiMartin() {
  const [workMode, setWorkMode] = useState('source');
  const [sheetNames, setSheetNames] = useState([]);
  const [activeSheet, setActiveSheet] = useState('');
  const [sheetSessions, setSheetSessions] = useState({});
  const [chatMessages, setChatMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [aiFile, setAiFile] = useState(null);
  const [inboxReady, setInboxReady] = useState(false);
  const [inboxUploadCount, setInboxUploadCount] = useState(0);
  const [stagedProbe, setStagedProbe] = useState(null);
  const [inboxRefreshTick, setInboxRefreshTick] = useState(0);
  const [parseScope, setParseScope] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [targetFile, setTargetFile] = useState(null);
  const [currentRule, setCurrentRule] = useState(null);
  const [parsePreview, setParsePreview] = useState(null);
  const [snapshotId, setSnapshotId] = useState(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [warnings, setWarnings] = useState([]);
  const [ruleDiff, setRuleDiff] = useState(null);
  const [layoutAnalysis, setLayoutAnalysis] = useState(null);
  const [compareResult, setCompareResult] = useState(null);
  const [validationReport, setValidationReport] = useState(null);
  const [validationDetailsOpen, setValidationDetailsOpen] = useState(false);
  const [scenarioResolution, setScenarioResolution] = useState(null);
  const [gridDiagnostics, setGridDiagnostics] = useState(null);
  const [pdfColumnEditorOpen, setPdfColumnEditorOpen] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [loadingHint, setLoadingHint] = useState('');
  const [projectId, setProjectId] = useState('');
  const [inboxStatus, setInboxStatus] = useState('');
  const [ruleJsonText, setRuleJsonText] = useState('');
  const [previewPage, setPreviewPage] = useState(1);
  const [scenarios, setScenarios] = useState([]);
  const [selectedScenario, setSelectedScenario] = useState(null);
  const [scenarioName, setScenarioName] = useState('');
  const [routeConfidence, setRouteConfidence] = useState(null);
  const [sourceKind, setSourceKind] = useState('');
  const [needsScenarioChoice, setNeedsScenarioChoice] = useState(false);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [scenarioCandidates, setScenarioCandidates] = useState([]);
  const [treeSample, setTreeSample] = useState([]);
  const [pendingQuestions, setPendingQuestions] = useState([]);
  const [currentQuestion, setCurrentQuestion] = useState(null);
  const [orchestratorAnswers, setOrchestratorAnswers] = useState({});
  const [structureGroups, setStructureGroups] = useState([]);
  const [appendTargetSnapshotId, setAppendTargetSnapshotId] = useState(null);
  const [reconcilePlan, setReconcilePlan] = useState(null);
  const [reconcilePanelOpen, setReconcilePanelOpen] = useState(false);
  const [reconcileLoading, setReconcileLoading] = useState(false);
  const [reconcileCatalog, setReconcileCatalog] = useState([]);
  const [reconcileLeftRef, setReconcileLeftRef] = useState('');
  const [reconcileRightRef, setReconcileRightRef] = useState('');
  const [enrichMode, setEnrichMode] = useState('extract');
  const [enrichSourceColumn, setEnrichSourceColumn] = useState('');
  const [enrichThreshold, setEnrichThreshold] = useState(0.7);
  const [enrichAuditorRule, setEnrichAuditorRule] = useState(
    'Определи: аренда (rent), ремонт (repair), движимое (movable), недвижимое (real_estate). Если неясно — not_sure.'
  );
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [enrichError, setEnrichError] = useState('');
  const [highlightHeaders, setHighlightHeaders] = useState([]);
  const [chatSessionId, setChatSessionId] = useState(null);
  const [chatSessions, setChatSessions] = useState([]);
  const [chatTables, setChatTables] = useState([]);
  const [activeTableId, setActiveTableId] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tableSearch, setTableSearch] = useState('');
  const [activeFilterCount, setActiveFilterCount] = useState(0);
  const [sessionsPanelOpen, setSessionsPanelOpen] = useState(false);
  const [tablePanelOpen, setTablePanelOpen] = useState(() => {
    try {
      return localStorage.getItem('anton_table_open') !== '0';
    } catch {
      return true;
    }
  });
  const tableScrollRef = useRef(null);
  const attachMenuRef = useRef(null);
  const bodyLayoutRef = useRef(null);
  const chatWidthRef = useRef(readInitialChatWidth());
  const parseInFlightRef = useRef(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState(readInitialChatWidth);
  const [resizing, setResizing] = useState(false);
  const previewPageSize = snapshotId ? SNAPSHOT_PAGE_SIZE : 20;

  useEffect(() => {
    chatWidthRef.current = chatWidth;
  }, [chatWidth]);

  useEffect(() => {
    if (!resizing) return undefined;
    const onMove = (e) => {
      const el = bodyLayoutRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const next = Math.round(rect.right - e.clientX);
      const max = Math.round(rect.width * CHAT_WIDTH_MAX_RATIO);
      const clamped = Math.min(max, Math.max(CHAT_WIDTH_MIN, next));
      const tableSpace = rect.width - clamped - 7;
      if (tableSpace < TABLE_WIDTH_MIN) return;
      setChatWidth(clamped);
    };
    const onUp = () => {
      setResizing(false);
      document.body.classList.remove('mv2-resizing');
      try {
        localStorage.setItem('mv2_chat_width', String(chatWidthRef.current));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('mv2-resizing');
    };
  }, [resizing]);

  useEffect(() => {
    if (!attachOpen) return undefined;
    const onDoc = (e) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target)) {
        setAttachOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [attachOpen]);

  useEffect(() => {
    fetch(`${API}/parse/scenarios`)
      .then((r) => r.json())
      .then((d) => setScenarios(d.scenarios || []))
      .catch(() => {});
  }, []);

  const bootstrapMartin = useCallback(async () => {
    const res = await fetch(`${API}/martin/bootstrap`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'bootstrap failed');
    setProjectId(String(data.projectId));
    setChatSessions(data.chats || []);
    return data;
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('anton_sessions_open', sessionsPanelOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [sessionsPanelOpen]);

  useEffect(() => {
    try {
      localStorage.setItem('anton_table_open', tablePanelOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [tablePanelOpen]);

  useEffect(() => {
    if (currentRule) setRuleJsonText(JSON.stringify(currentRule, null, 2));
  }, [currentRule]);

  useEffect(() => {
    if (!parsePreview?.headers?.length) {
      setEnrichSourceColumn('');
      return;
    }
    if (!enrichSourceColumn || !parsePreview.headers.includes(enrichSourceColumn)) {
      setEnrichSourceColumn(parsePreview.headers[0]);
    }
  }, [parsePreview, enrichSourceColumn]);

  const stripRowMeta = (row) => {
    if (!row || typeof row !== 'object') return row;
    const { __rowIndex, ...rest } = row;
    return rest;
  };

  const reloadSnapshotPage = useCallback(async (sid, page = 1, options = {}) => {
    if (!sid) return null;
    setRowsLoading(true);
    try {
      const response = await fetch(
        `${API}/parse/snapshots/${sid}/rows?page=${page}&limit=${SNAPSHOT_PAGE_SIZE}`
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'rows fetch failed');
      const rows = (data.rows || []).map(stripRowMeta);
      const nextPreview = {
        headers: data.headers || [],
        rows,
        rowCount: data.total ?? rows.length,
        tableMeta: data.tableMeta || null,
        scenarioId: data.scenarioId || null,
      };
      setParsePreview((prev) => ({
        ...prev,
        ...nextPreview,
      }));
      if (activeSheet) {
        setSheetSessions((prev) => ({
          ...prev,
          [activeSheet]: {
            ...(prev[activeSheet] || {}),
            snapshotId: sid,
            parsePreview: nextPreview,
          },
        }));
      }
      if (options.highlightCols?.length) {
        setHighlightHeaders(options.highlightCols);
        requestAnimationFrame(() => {
          const el = tableScrollRef.current;
          if (!el) return;
          const hdrs = nextPreview.headers || [];
          const col = options.highlightCols[0];
          const idx = hdrs.indexOf(col);
          if (idx >= 0) {
            const colWidth = 120;
            el.scrollLeft = Math.max(0, idx * colWidth - el.clientWidth / 3);
          } else {
            el.scrollLeft = el.scrollWidth;
          }
        });
      }
      return data;
    } finally {
      setRowsLoading(false);
    }
  }, [activeSheet]);

  useEffect(() => {
    if (!snapshotId) return;
    reloadSnapshotPage(snapshotId, previewPage);
  }, [snapshotId, previewPage, reloadSnapshotPage]);

  const refreshChatSessions = useCallback(async () => {
    const response = await fetch(`${API}/martin/chats`);
    const data = await response.json();
    if (data.projectId) setProjectId(String(data.projectId));
    const list = data.chats || [];
    setChatSessions(list);
    return list;
  }, []);

  const loadChatSession = useCallback(async (id) => {
    if (!id) return;
    const response = await fetch(`${API}/chats/${id}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'chat load failed');
    setChatSessionId(id);
    setInboxReady(false);
    setInboxUploadCount(0);
    setStagedProbe(null);
    setParseScope(null);
    setInboxStatus('');
    setInboxRefreshTick((t) => t + 1);
    setChatTables(mapServerSnapshotsToTabs(data.snapshots || []));
    setChatMessages(
      (data.messages || []).map((m) => ({ role: m.role, content: m.content }))
    );
    const tables = data.snapshots || [];
    const lastTable = tables.length ? tables[tables.length - 1] : null;
    if (lastTable?.snapshotId) {
      setActiveTableId(lastTable.snapshotId);
      setSnapshotId(lastTable.snapshotId);
      setPreviewPage(1);
      await reloadSnapshotPage(lastTable.snapshotId, 1);
    } else {
      setActiveTableId(null);
      setSnapshotId(null);
      setParsePreview(null);
    }
  }, [reloadSnapshotPage]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await bootstrapMartin();
        if (cancelled) return;
        if (data.chatSessionId) {
          await loadChatSession(data.chatSessionId);
        } else {
          const res = await fetch(`${API}/martin/chats`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Новый чат' }),
          });
          const created = await res.json();
          if (!res.ok) throw new Error(created.error || 'create chat failed');
          if (!cancelled && created.chat?.id) await loadChatSession(created.chat.id);
        }
      } catch (e) {
        if (!cancelled) {
          setChatMessages([
            {
              role: 'assistant',
              content: `Сервер недоступен (${API.replace('/api', '')}). Запусти: **cd server && node index.js**, потом F5.`,
            },
          ]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootstrapMartin, loadChatSession]);

  const ensureChatSession = useCallback(async () => {
    if (chatSessionId) return chatSessionId;
    const response = await fetch(`${API}/martin/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Новый чат' }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'create chat failed');
    if (data.projectId) setProjectId(String(data.projectId));
    setChatSessionId(data.chat.id);
    setChatTables([]);
    setChatMessages([]);
    setActiveTableId(null);
    setSnapshotId(null);
    setParsePreview(null);
    setInboxReady(false);
    setInboxUploadCount(0);
    setStagedProbe(null);
    setParseScope(null);
    setInboxRefreshTick((t) => t + 1);
    await refreshChatSessions();
    return data.chat.id;
  }, [chatSessionId, refreshChatSessions]);

  const deleteChat = async (id, e) => {
    e?.stopPropagation?.();
    if (!id) return;
    if (!confirm('Удалить этот чат?')) return;
    const response = await fetch(`${API}/chats/${id}`, { method: 'DELETE' });
    if (!response.ok) return;
    const list = await refreshChatSessions();
    if (chatSessionId === id) {
      if (list.length) {
        await loadChatSession(list[0].id);
      } else {
        setChatSessionId(null);
        setChatMessages([]);
        setChatTables([]);
        setActiveTableId(null);
        setSnapshotId(null);
        setParsePreview(null);
        resetSessionForNewFile();
        const boot = await bootstrapMartin();
        if (boot.chatSessionId) await loadChatSession(boot.chatSessionId);
      }
    }
  };

  const purgeAllChats = async () => {
    if (!confirm('Удалить все чаты? Таблицы в БД останутся, но привязки пропадут.')) return;
    const response = await fetch(`${API}/martin/chats`, { method: 'DELETE' });
    if (!response.ok) return;
    setChatSessionId(null);
    setChatMessages([]);
    setChatTables([]);
    setActiveTableId(null);
    setSnapshotId(null);
    setParsePreview(null);
    resetSessionForNewFile();
    await refreshChatSessions();
    await createNewChat();
  };

  const createNewChat = async () => {
    const response = await fetch(`${API}/martin/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Новый чат' }),
    });
    const data = await response.json();
    if (!response.ok) return;
    if (data.projectId) setProjectId(String(data.projectId));
    resetSessionForNewFile();
    setChatMessages([]);
    setChatTables([]);
    setActiveTableId(null);
    setSnapshotId(null);
    setParsePreview(null);
    setInboxReady(false);
    setInboxUploadCount(0);
    setStagedProbe(null);
    setParseScope(null);
    setInboxStatus('');
    setChatSessionId(data.chat.id);
    setInboxRefreshTick((t) => t + 1);
    await refreshChatSessions();
  };

  const switchChat = async (id) => {
    if (!id || id === chatSessionId) return;
    resetSessionForNewFile();
    await loadChatSession(id);
  };

  const switchActiveTable = async (tableSnapshotId) => {
    if (!tableSnapshotId || tableSnapshotId === activeTableId) return;
    if (String(tableSnapshotId).startsWith('draft-')) {
      setActiveTableId(tableSnapshotId);
      setPreviewPage(1);
      return;
    }
    setActiveTableId(tableSnapshotId);
    setSnapshotId(tableSnapshotId);
    setPreviewPage(1);
    await reloadSnapshotPage(tableSnapshotId, 1);
  };

  const removeTableFromChat = async (tableSnapshotId) => {
    if (!tableSnapshotId) return;
    if (String(tableSnapshotId).startsWith('draft-')) {
      setChatTables((prev) => prev.filter((t) => t.snapshotId !== tableSnapshotId));
      if (activeTableId === tableSnapshotId) {
        setActiveTableId(null);
        setSnapshotId(null);
        setParsePreview(null);
      }
      return;
    }
    if (!chatSessionId) return;
    if (!confirm('Убрать таблицу из чата? Данные в БД тоже удалятся.')) return;
    const response = await fetch(
      `${API}/chats/${chatSessionId}/snapshots/${tableSnapshotId}?hard=1`,
      { method: 'DELETE' }
    );
    if (!response.ok) return;
    const nextTables = chatTables.filter((t) => t.snapshotId !== tableSnapshotId);
    setChatTables(nextTables);
    if (activeTableId === tableSnapshotId) {
      const next = nextTables[nextTables.length - 1];
      if (next) {
        await switchActiveTable(next.snapshotId);
      } else {
        setActiveTableId(null);
        setSnapshotId(null);
        setParsePreview(null);
      }
    }
    await refreshChatSessions();
  };

  const syncChatTablesAfterParse = useCallback(
    async (sid, label) => {
      if (!chatSessionId || !sid) return;
      const response = await fetch(`${API}/chats/${chatSessionId}/snapshots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshotId: sid, label }),
      });
      if (response.ok) {
        const data = await response.json();
        setChatTables((prev) => {
          if (prev.some((t) => t.snapshotId === sid)) return prev;
          return [
            ...prev,
            {
              snapshotId: sid,
              label: data.link?.label || label,
              sheetName: parsePreview?.sheetName || '',
              sourceFileName: label.split(' · ')[0] || label,
              rowCount: parsePreview?.rowCount,
            },
          ];
        });
        setActiveTableId(sid);
        await refreshChatSessions();
      }
    },
    [chatSessionId, parsePreview, refreshChatSessions]
  );

  const activeSnapshotNumericId = useCallback(() => {
    const sid =
      activeTableId && !String(activeTableId).startsWith('draft-')
        ? activeTableId
        : snapshotId;
    const n = parseInt(sid, 10);
    return Number.isFinite(n) ? n : null;
  }, [activeTableId, snapshotId]);

  const downloadSnapshotExport = useCallback(
    async (format) => {
      const sid = activeSnapshotNumericId();
      if (!sid) return;
      try {
        const resp = await fetch(`${API}/parse/snapshots/${sid}/export?format=${format}`, {
          headers: authHeaders(),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || resp.statusText);
        }
        const blob = await resp.blob();
        const cd = resp.headers.get('Content-Disposition') || '';
        const m = /filename\*=UTF-8''([^;]+)|filename="([^"]+)"/i.exec(cd);
        const filename = decodeURIComponent(m?.[1] || m?.[2] || `snapshot-${sid}.${format}`);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        setChatMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `Экспорт не вышел: ${e.message}` },
        ]);
      }
    },
    [API, activeSnapshotNumericId]
  );

  const loadReconcileCatalog = useCallback(async () => {
    if (!projectId) return { sources: [] };
    const sid = activeSnapshotNumericId();
    const qs = new URLSearchParams({
      chatSessionId: chatSessionId ? String(chatSessionId) : '',
      activeSnapshotId: sid ? String(sid) : '',
    });
    const resp = await fetch(`${API}/projects/${projectId}/reconcile/sources?${qs}`, {
      headers: authHeaders(),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || resp.statusText);
    return data;
  }, [API, projectId, chatSessionId, activeSnapshotNumericId]);

  const fetchReconcilePlan = useCallback(
    async (message) => {
      const sid = activeSnapshotNumericId();
      const resp = await fetch(`${API}/reconcile/plan`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          message,
          projectId,
          chatSessionId: chatSessionId || null,
          activeSnapshotId: sid,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || resp.statusText);
      if (!data.plan) throw new Error(data.error || 'План не составлен');
      return data;
    },
    [API, projectId, chatSessionId, activeSnapshotNumericId]
  );

  const runReconcileExecute = useCallback(
    async (plan) => {
      if (!plan?.left?.ref || !plan?.right?.ref) {
        throw new Error('В плане нет left/right ref');
      }
      setReconcileLoading(true);
      try {
        const resp = await fetch(`${API}/reconcile/run`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            plan,
            projectId,
            chatSessionId: chatSessionId || null,
          }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || resp.statusText);
        if (data.assistantMessage) {
          setChatMessages((prev) => [...prev, { role: 'assistant', content: data.assistantMessage }]);
        }
        if (data.snapshotId) {
          const label = data.title || `Сверка #${data.snapshotId}`;
          await syncChatTablesAfterParse(data.snapshotId, label);
          setSnapshotId(data.snapshotId);
          setActiveTableId(data.snapshotId);
          setWorkMode('result');
          await reloadSnapshotPage(data.snapshotId, 1);
          setReconcilePanelOpen(false);
          setReconcilePlan(null);
        }
        return data;
      } finally {
        setReconcileLoading(false);
      }
    },
    [API, projectId, chatSessionId, syncChatTablesAfterParse, reloadSnapshotPage]
  );

  const openReconcilePanel = useCallback(async () => {
    if (!projectId) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Сверка работает в проекте — открой или создай проект.' },
      ]);
      return;
    }
    setReconcilePanelOpen(true);
    setReconcilePlan(null);
    setReconcileLoading(true);
    try {
      const catalog = await loadReconcileCatalog();
      setReconcileCatalog(catalog.sources || []);
      if ((catalog.sources || []).length === 2) {
        const planData = await fetchReconcilePlan('сверь');
        setReconcilePlan(planData.plan);
      }
    } catch (e) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Каталог сверки: ${e.message}` },
      ]);
    } finally {
      setReconcileLoading(false);
    }
  }, [projectId, loadReconcileCatalog, fetchReconcilePlan]);

  const applySessionData = (data, explicitSheetName) => {
    const effectiveSheet =
      explicitSheetName ||
      data.layoutAnalysis?.sheetName ||
      data.excelMeta?.sheetName ||
      activeSheet ||
      '';

    const incomingSheetNames =
      data.sheetNames || data.layoutAnalysis?.sheetNames || data.excelMeta?.sheetNames || [];
    const multiWorkbook =
      incomingSheetNames.length > 1 || sheetNames.length > 1;
    if (incomingSheetNames.length) setSheetNames(incomingSheetNames);
    if (effectiveSheet) setActiveSheet(effectiveSheet);

    if (multiWorkbook && data.previewIsTentative && !data.multiSheet) {
      return;
    }

    if (data.layoutAnalysis) setLayoutAnalysis(data.layoutAnalysis);
    setNeedsScenarioChoice(Boolean(data.needsScenarioChoice));
    setNeedsConfirm(Boolean(data.needsConfirm));
    setScenarioCandidates(data.candidates || []);
    setTreeSample(
      data.treeSample ||
        data.treeInference?.examples ||
        data.layoutAnalysis?.tree_inference?.examples ||
        data.layoutAnalysis?.hierarchy_tree_sample ||
        []
    );
    setPendingQuestions(data.pendingQuestions || []);
    setCurrentQuestion(data.currentQuestion || null);
    setOrchestratorAnswers({
      ...(data.sessionState?.answers || {}),
      scenarioId: data.sessionState?.scenarioId,
      sheetName: data.sessionState?.sheetName,
      profileId: data.sessionState?.profileId,
      nameColumn: data.sessionState?.nameColumn,
      quantityColumn: data.sessionState?.quantityColumn,
      amountColumn: data.sessionState?.amountColumn,
      compositeColumn: data.sessionState?.compositeColumn,
      compositeExtracts: data.sessionState?.compositeExtracts,
    });
    setSelectedScenario(data.scenarioId || null);
    setScenarioName(data.scenarioName || '');
    setRouteConfidence(data.confidence ?? null);
    setSourceKind(data.sourceKind || data.layoutAnalysis?.sourceKind || '');
    setCurrentRule(data.rule || null);
    setSnapshotId(data.snapshotId || null);
    if (data.snapshotId) setActiveTableId(data.snapshotId);
    setParsePreview(data.parsePreview || null);
    setCompareResult(data.compareResult || null);
    setWarnings(data.warnings || []);
    setValidationReport(data.validationReport || null);
    setValidationDetailsOpen(false);
    setScenarioResolution(data.scenarioResolution || null);
    setGridDiagnostics(data.gridDiagnostics || null);
    const isPdf = data.sourceKind === 'pdf' || data.layoutAnalysis?.sourceKind === 'pdf';
    const validationFailed =
        data.validationReport &&
        (data.validationReport.status === 'fail' || data.validationReport.blocksImport);
    const pdfDraftNeedsReview =
        isPdf && !data.snapshotId && data.parsePreview?.headers?.length && data.needsConfirm;
    if (isPdf && (validationFailed || pdfDraftNeedsReview)) {
      setPdfColumnEditorOpen(true);
      if (validationFailed) setValidationDetailsOpen(true);
    }
    setStructureGroups(data.groups || data.parsePlan?.groups || []);
    setPreviewPage(1);

    if (data.multiSheet && Array.isArray(data.snapshots)) {
      setPendingQuestions([]);
      setNeedsScenarioChoice(false);
      setWorkMode('result');
      if (data.sheetNames?.length) setSheetNames(data.sheetNames);
      if (data.snapshots[0]?.sheetName) setActiveSheet(data.snapshots[0].sheetName);
      setChatTables(mapSnapshotsToTables(data.snapshots, aiFile?.name || ''));
      if (chatSessionId) refreshChatSessions();
      return;
    }

    if (data.needsConfirm && data.pendingQuestions?.length) {
      setWorkMode('result');
    }

    if (data.parsePreview?.headers?.length) {
      const sheetLabel =
        effectiveSheet ||
        data.layoutAnalysis?.sheetName ||
        incomingSheetNames[0] ||
        'лист';
      const fileLabel = (aiFile?.name || data.sourceFileName || '').replace(
        /\.(xlsx|xls|xlsm|pdf|txt|csv)$/i,
        ''
      );
      const tabTitle = fileLabel || sheetLabel;
      const draftTab = {
        snapshotId: data.snapshotId || `draft-${tabTitle}-${sheetLabel}`,
        label: [tabTitle, sheetLabel !== tabTitle ? sheetLabel : null, data.parsePreview.rowCount]
          .filter((x) => x != null && x !== '')
          .join(' · '),
        sheetName: sheetLabel,
        rowCount: data.parsePreview.rowCount,
        sourceFileName: aiFile?.name || data.sourceFileName || tabTitle,
        isDraft: !data.snapshotId,
      };
      setChatTables((prev) => {
        if (data.snapshotId && prev.some((t) => t.snapshotId === data.snapshotId)) {
          return prev.map((t) =>
            t.snapshotId === data.snapshotId ? { ...t, ...draftTab, isDraft: false } : t
          );
        }
        if (!data.snapshotId && prev.some((t) => t.isDraft)) {
          return [...prev.filter((t) => !t.isDraft), draftTab];
        }
        if (prev.length > 0 && data.multiSheet) return prev;
        if (prev.length > 0 && !data.snapshotId) return prev;
        if (data.snapshotId && prev.length > 0) {
          return [...prev, { ...draftTab, isDraft: false }];
        }
        return [draftTab];
      });
    }

    if (data.snapshotId && chatSessionId) {
      const fileLabel = (aiFile?.name || '').replace(/\.(xlsx|xls|xlsm|pdf|txt|csv)$/i, '');
      const label = [fileLabel, effectiveSheet].filter(Boolean).join(' · ');
      syncChatTablesAfterParse(data.snapshotId, label);
    }

    if (effectiveSheet) {
      setSheetSessions((prev) => ({
        ...prev,
        [effectiveSheet]: {
          ...(prev[effectiveSheet] || {}),
          layoutAnalysis: data.layoutAnalysis || null,
          needsScenarioChoice: Boolean(data.needsScenarioChoice),
          scenarioCandidates: data.candidates || [],
          treeSample: data.treeSample || data.layoutAnalysis?.hierarchy_tree_sample || [],
          pendingQuestions: data.pendingQuestions || [],
          currentQuestion: data.currentQuestion || null,
          orchestratorAnswers: {
            ...(data.sessionState?.answers || {}),
            scenarioId: data.sessionState?.scenarioId,
            sheetName: data.sessionState?.sheetName || effectiveSheet,
            profileId: data.sessionState?.profileId,
            nameColumn: data.sessionState?.nameColumn,
            quantityColumn: data.sessionState?.quantityColumn,
            amountColumn: data.sessionState?.amountColumn,
            compositeColumn: data.sessionState?.compositeColumn,
            compositeExtracts: data.sessionState?.compositeExtracts,
          },
          selectedScenario: data.scenarioId || null,
          scenarioName: data.scenarioName || '',
          routeConfidence: data.confidence ?? null,
          sourceKind: data.sourceKind || '',
          currentRule: data.rule || null,
          snapshotId: data.snapshotId || null,
          parsePreview: data.parsePreview || null,
          compareResult: data.compareResult || null,
          warnings: data.warnings || [],
          validationReport: data.validationReport || null,
        },
      }));
    }
  };

  const handleInboxParseResult = (data) => {
    applySessionData(data);
    setWorkMode('result');
    if (data.assistantMessage) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: data.assistantMessage, reasoningTrace: data.reasoningTrace },
      ]);
    }
  };

  const buildStagingMessage = (probe) => {
    if (!probe) {
      return 'Файлы в **хранилище на сервере**. Парс **не запущен** — напиши задачу.';
    }
    const parts = [
      `В хранилище **${probe.totalFiles || probe.fileCount || 0}** файл(ов). Парс **не запущен**.`,
    ];
    if (probe.suggestedScenario) {
      parts.push(`Похоже на сценарий: **${probe.suggestedScenario}**.`);
    }
    if (probe.byKind?.pdf) parts.push(`PDF: ${probe.byKind.pdf}.`);
    if (probe.prefixMatches != null && probe.prefix) {
      parts.push(`С префиксом \`${probe.prefix}\`: **${probe.prefixMatches}** (можешь уточнить: «только 1F008…»).`);
    }
    if (probe.sampleNames?.length) {
      parts.push(`Примеры: ${probe.sampleNames.slice(0, 3).join(', ')}.`);
    }
    parts.push(
      'Примеры: «брокер 1F018», «депо», «разбери карточку 76», «ОС плоская, убери иерархию», «как в эталоне».'
    );
    parts.push(PARSE_BRIEF_HINT);
    parts.push('_(файлы уже на сервере — в шапке «Жду команду»)_');
    return parts.join('\n');
  };

  const uploadFilesToInbox = async (files, onProgress, sessionId = chatSessionId) => {
    const sid = sessionId || chatSessionId || (await ensureChatSession());
    if (!sid) throw new Error('Нет активного чата');
    const picked = Array.from(files || []).filter((f) =>
      /\.(pdf|xlsx|xls|xlsm|txt|csv|tsv|jpe?g|png|webp|gif|tiff?)$/i.test(f.name || '')
    );
    if (!picked.length) throw new Error('Нет PDF, Excel или изображений скана в выборе');

    const isFolder = picked.some((f) => String(f.webkitRelativePath || '').includes('/'));
    const chunkSize =
      isFolder && picked.length > INBOX_FOLDER_SINGLE_THRESHOLD ? 1 : INBOX_UPLOAD_CHUNK;
    const chunks = chunkFileList(picked, chunkSize);
    let totalSaved = 0;
    const byKindAcc = {};

    for (let ci = 0; ci < chunks.length; ci += 1) {
      const chunk = chunks[ci];
      const isLast = ci === chunks.length - 1;
      onProgress?.({ chunk: ci + 1, total: chunks.length, files: chunk.length });
      const fd = new FormData();
      const meta = chunk.map((f) => ({
        name: f.name,
        relativePath: normalizeUploadPath(f.webkitRelativePath || f.name),
      }));
      chunk.forEach((f) => {
        const rel = normalizeUploadPath(f.webkitRelativePath || f.name);
        fd.append('files', f, rel);
      });
      fd.append('filesMeta', JSON.stringify(meta));
      const q = new URLSearchParams();
      if (!isLast) q.set('skipProbe', '1');
      const uploadUrl = `${API}/chats/${sid}/inbox/upload${q.toString() ? `?${q}` : ''}`;
      const sampleNames = meta.slice(0, 2).map((m) => m.relativePath).join(', ');
      let response;
      let lastNetErr = null;
      for (let attempt = 1; attempt <= INBOX_UPLOAD_RETRIES; attempt += 1) {
        try {
          const xhrRes = await postFormData(uploadUrl, fd);
          response = {
            ok: xhrRes.ok,
            status: xhrRes.status,
            json: async () => JSON.parse(xhrRes.text),
          };
          lastNetErr = null;
          break;
        } catch (netErr) {
          lastNetErr = netErr;
          if (attempt < INBOX_UPLOAD_RETRIES) {
            await new Promise((r) => setTimeout(r, 600 * attempt));
          }
        }
      }
      if (lastNetErr) {
        throw new Error(
          `сеть оборвалась на пачке ${ci + 1}/${chunks.length} (${chunk.length} файлов, «${sampleNames}»): ${lastNetErr.message}. ${window.location.origin} → ${uploadUrl}`
        );
      }
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error(`пачка ${ci + 1}: сервер ответил не JSON (HTTP ${response.status})`);
      }
      if (!response.ok) throw new Error(data.error || `inbox upload failed (пачка ${ci + 1})`);
      totalSaved += data.saved || 0;
      Object.entries(data.byKind || {}).forEach(([k, n]) => {
        byKindAcc[k] = (byKindAcc[k] || 0) + n;
      });
    }

    const probe = await fetchInboxProbe('', sid);
    return { saved: totalSaved, byKind: byKindAcc, probe, chunks: chunks.length };
  };

  const fetchInboxProbe = useCallback(async (userMessage = '', sessionId = chatSessionId) => {
    if (!sessionId) return null;
    const response = await fetch(`${API}/chats/${sessionId}/inbox/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessage }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'inbox probe failed');
    return data.probe;
  }, [chatSessionId]);

  const syncInboxFromServer = useCallback(async () => {
    if (!chatSessionId) {
      setInboxReady(false);
      setInboxUploadCount(0);
      setStagedProbe(null);
      setParseScope(null);
      return;
    }
    try {
      const probe = await fetchInboxProbe('', chatSessionId);
      const count = probe?.totalFiles || 0;
      setInboxUploadCount(count);
      setInboxReady(count > 0);
      setStagedProbe(probe);
      if (!count) setParseScope(null);
    } catch {
      setInboxReady(false);
      setInboxUploadCount(0);
    }
  }, [chatSessionId, fetchInboxProbe]);

  useEffect(() => {
    syncInboxFromServer();
  }, [syncInboxFromServer, inboxRefreshTick]);

  const parseJsonResponse = async (response) => {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (parseErr) {
      const hint = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      throw new Error(
        parseErr?.message?.includes('stack')
          ? 'Maximum call stack size exceeded'
          : `Ответ сервера не JSON: ${hint}`
      );
    }
  };

  const recoverParseFromChat = async (sessionId) => {
    if (!sessionId) return null;
    try {
      const loaded = await fetch(`${API}/chats/${sessionId}`);
      const chatData = await parseJsonResponse(loaded);
      if (!loaded.ok) return null;
      const snapshots = chatData.snapshots || [];
      const lastSnap = snapshots[snapshots.length - 1];
      const lastAssist = [...(chatData.messages || [])]
        .reverse()
        .find((m) => m.role === 'assistant' && /Разобрала|Валидация:/i.test(String(m.content || '')));
      if (!lastSnap?.snapshotId) return null;
      return {
        ok: true,
        snapshotId: lastSnap.snapshotId,
        assistantMessage:
          lastAssist?.content ||
          `Разобрала **${lastSnap.label || 'таблицу'}** — ${(lastSnap.rowCount ?? 0).toLocaleString('ru-RU')} строк.`,
        parsePreview: {
          headers: [],
          rows: [],
          rowCount: lastSnap.rowCount ?? 0,
        },
        scenarioId: lastSnap.scenarioId || null,
        scenarioName: lastSnap.scenarioName || null,
        recoveredFromChat: true,
      };
    } catch {
      return null;
    }
  };

  const fetchInboxParse = async (opts = {}) => {
    const {
      userMessage = '',
      scenarioId,
      nextAnswers,
      targetSheetName,
      filePrefix,
      parseAllSheets,
      pathScope,
      chatSessionId: chatSessionIdOverride,
    } = opts;
    if (!chatSessionId) throw new Error('Нет активного чата');
    const sid = chatSessionIdOverride || chatSessionId;
    const appendId =
      opts.appendSnapshotId ||
      appendTargetSnapshotId ||
      nextAnswers?.appendSnapshotId ||
      null;
    const effectiveMessage =
      userMessage || (appendId ? 'добавь в таблицу' : '');
    const sheetScope = resolveInboxSheetParse({
      sheetNames: opts.knownSheetNames || sheetNames,
      userMessage,
      parseAllSheets,
      targetSheetName,
      nextAnswers,
    });
    const batchTimeoutMs = 1_800_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), batchTimeoutMs);
    let response;
    try {
      response = await fetch(`${API}/chats/${sid}/inbox/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          userMessage: effectiveMessage,
          chatSessionId: sid,
          projectId: projectId || null,
          scenarioId: scenarioId || null,
          orchestratorAnswers: nextAnswers || null,
          sheetName: sheetScope.sheetName,
          parseAllSheets: sheetScope.parseAllSheets ? true : null,
          filePrefix: filePrefix || nextAnswers?.filePrefix || null,
          pathScope: pathScope || null,
          appendSnapshotId: appendId,
        }),
      });
    } catch (netErr) {
      if (netErr?.name === 'AbortError') {
        const recovered = await recoverParseFromChat(sid);
        if (recovered) return recovered;
        throw new Error(
          `Парс занял больше ${Math.round(batchTimeoutMs / 1000)} сек — обнови чат: иногда таблица уже в БД.`
        );
      }
      throw new Error(
        `API на ${API.replace('/api', '')} не отвечает — запусти сервер (cd server && node index.js)`
      );
    } finally {
      clearTimeout(timeoutId);
    }
    let data;
    try {
      data = await parseJsonResponse(response);
    } catch (parseErr) {
      const recovered = await recoverParseFromChat(sid);
      if (recovered) return recovered;
      throw parseErr;
    }
    if (!response.ok) {
      const err = new Error(data.error || 'inbox parse failed');
      err.validationReport = data.validationReport || data.skipped?.[0]?.validationReport || null;
      err.reasoningTrace = data.reasoningTrace || data.skipped?.[0]?.reasoningTrace || null;
      throw err;
    }
    return data;
  };

  const runEgrulFetch = async (userMessage) => {
    setAiLoading(true);
    setWorkMode('result');
    setLoadingHint('Запрашиваю выписки ЕГРЮЛ…');
    try {
      const sid =
        activeTableId && !String(activeTableId).startsWith('draft-')
          ? activeTableId
          : snapshotId;
      const activeSnap =
        sid && !String(sid).startsWith('draft-') ? parseInt(sid, 10) : null;
      const response = await fetch(`${API}/egrul/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          projectId: projectId || null,
          chatSessionId: chatSessionId || null,
          sourceSnapshotId: Number.isFinite(activeSnap) ? activeSnap : null,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      applySessionData({
        snapshotId: data.snapshotId,
        parsePreview: data.parsePreview,
        scenarioId: data.scenarioId || 'egrul_check',
        sourceFileName: data.sourceFileName || 'ЕГРЮЛ',
      });
      if (data.assistantMessage) {
        setChatMessages((prev) => [
          ...prev,
          { role: 'assistant', content: data.assistantMessage },
        ]);
      }
      if (chatSessionId && data.snapshotId) {
        await refreshChatSessions();
      }
    } catch (e) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `ЕГРЮЛ: ${e.message}` },
      ]);
    } finally {
      setAiLoading(false);
      setLoadingHint('');
    }
  };

  const runInboxParse = async (opts = {}) => {
    if (parseInFlightRef.current) {
      return null;
    }
    if (!inboxReady && !chatSessionId) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Сначала создай **чат** и загрузи файлы **слева** в Хранилище.' },
      ]);
      return null;
    }
    if (!inboxReady) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'В хранилище пусто — загрузи папку **слева** (кнопка «Папка»).' },
      ]);
      return null;
    }
    setAiLoading(true);
    parseInFlightRef.current = true;
    const probe = stagedProbe || {};
    const effectiveScope = opts.pathScope ?? parseScope;
    setLoadingHint(inboxParseLoadingHint(effectiveScope, probe, opts.userMessage || ''));
    try {
      const sessionId = opts.chatSessionId || chatSessionId || (await ensureChatSession());
      const data = await fetchInboxParse({ ...opts, chatSessionId: sessionId, pathScope: opts.pathScope ?? parseScope });
      applySessionData(data, opts.targetSheetName);
      setInboxReady(true);
      if (data.appendMode) setAppendTargetSnapshotId(null);
      if (sessionId && (data.snapshotId || data.multiSheet)) {
        try {
          const loaded = await fetch(`${API}/chats/${sessionId}`);
          const chatData = await loaded.json();
          if (loaded.ok && chatData.snapshots?.length) {
            setChatTables(mapServerSnapshotsToTabs(chatData.snapshots));
          }
        } catch {
          /* applySessionData уже добавила вкладку */
        }
        await refreshChatSessions();
      }
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: data.assistantMessage || 'Готово.',
          reasoningTrace: data.reasoningTrace || null,
          artifact: data.multiSheet
            ? null
            : data.snapshotId
              ? {
                  snapshotId: data.snapshotId,
                  label: data.sourceFileName || 'Таблица',
                  rowCount: data.parsePreview?.rowCount ?? 0,
                }
              : null,
        },
      ]);
      if (data.multiSheet && Array.isArray(data.snapshots)) {
        setCurrentQuestion(null);
        setChatTables(mapSnapshotsToTables(data.snapshots, 'inbox'));
      }
      if (data.snapshotId && sessionId) {
        setActiveTableId(data.snapshotId);
        setSnapshotId(data.snapshotId);
        setPreviewPage(1);
        if (!data.recoveredFromChat) {
          try {
            await reloadSnapshotPage(data.snapshotId, 1);
          } catch (loadErr) {
            setChatMessages((prev) => [
              ...prev,
              {
                role: 'assistant',
                content: `Парс ок (${(data.parsePreview?.rowCount ?? 0).toLocaleString('ru-RU')} строк), но превью из БД не подтянулось: ${loadErr.message}`,
              },
            ]);
          }
        }
      }
      setActiveFilterCount(0);
      setWorkMode('result');
      setPreviewPage(1);
      return data;
    } catch (e) {
      if (e.validationReport) {
        setValidationReport(e.validationReport);
        setValidationDetailsOpen(true);
      }
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Не вышло: ${e.message}`,
          reasoningTrace: e.reasoningTrace || null,
        },
      ]);
      return null;
    } finally {
      parseInFlightRef.current = false;
      setAiLoading(false);
      setLoadingHint('');
    }
  };

  const fetchBatchStart = async (_files, _target, opts = {}) => fetchInboxParse(opts);

  const runBatchStart = async (_files, _target, opts = {}) => runInboxParse(opts);

  const fetchPlanPreview = async (userMessage, files, probe) => {
    const response = await fetch(`${API}/parse/plan-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userMessage,
        files: (files || []).map((f) => ({
          name: f.name,
          relativePath: f.relativePath || f.webkitRelativePath || f.name,
        })),
        probe,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { parsePlan: null, reasoningTrace: null };
    return {
      parsePlan: data.parsePlan || null,
      reasoningTrace: data.reasoningTrace || null,
    };
  };

  const fetchAutoStart = async (source, target, scenarioId, nextAnswers, targetSheetName) => {
    const formData = new FormData();
    formData.append('file', source);
    if (target) formData.append('target', target);
    if (projectId) formData.append('project_id', String(projectId));
    if (chatSessionId) formData.append('chatSessionId', String(chatSessionId));
    if (targetSheetName) formData.append('sheetName', targetSheetName);
    if (scenarioId) formData.append('scenarioId', scenarioId);
    if (nextAnswers) formData.append('orchestratorAnswers', JSON.stringify(nextAnswers));
    const response = await fetch(`${API}/parse/auto-start`, { method: 'POST', body: formData });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'auto-start failed');
    return data;
  };

  const autoStart = async (source, target, scenarioId, nextAnswers, targetSheetName) => {
    if (!source) return null;
    setAiLoading(true);
    const bigHint =
      source?.size > 2_000_000 ? 'Большой файл — может занять 1–3 минуты. Не закрывай вкладку.' : null;
    const isPdf = /\.pdf$/i.test(source?.name || '');
    setLoadingHint(
      bigHint ||
        (isPdf ? 'Читаю PDF, извлекаю таблицу…' : 'Читаю файл, строю превью… (Excel может занять до минуты)')
    );
    try {
      const data = await fetchAutoStart(source, target, scenarioId, nextAnswers, targetSheetName);
      applySessionData(data, targetSheetName);
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: data.assistantMessage || 'Готово.' },
      ]);
      if (data.snapshotId && chatSessionId) {
        const loaded = await fetch(`${API}/chats/${chatSessionId}`);
        const chatData = await loaded.json();
        if (loaded.ok) setChatTables(chatData.snapshots || []);
        await refreshChatSessions();
      }
      setPreviewPage(1);
      return data;
    } catch (e) {
      setChatMessages([{ role: 'assistant', content: `Не смогла разобрать файл: ${e.message}` }]);
      return null;
    } finally {
      setAiLoading(false);
      setLoadingHint('');
    }
  };

  const pickScenario = (scenarioId) => {
    if (!inboxReady) return;
    setNeedsScenarioChoice(false);
    startParseFromStaged(SCENARIO_PHRASES[scenarioId] || '', scenarioId);
  };

  const pickPdfKind = (kindId) => {
    if (!inboxReady) return;
    setNeedsScenarioChoice(false);
    setCurrentQuestion(null);
    setPendingQuestions([]);
    const next = { ...(orchestratorAnswers || {}), pick_pdf_kind: kindId };
    setOrchestratorAnswers(next);
    const scenarioMap = {
      broker_report: 'broker_pdf',
      depo: 'opif_depo',
      upd_ediweb: 'upd_ediweb',
      unknown_pdf: 'unknown_pdf',
    };
    runInboxParse({
      userMessage: 'разбери pdf',
      scenarioId: scenarioMap[kindId] || kindId,
      nextAnswers: next,
      targetSheetName: activeSheet || undefined,
    });
  };

  const confirmPdfParse = async () => {
    if (!aiFile || !parsePreview?.headers?.length) return;
    setAiLoading(true);
    setLoadingHint('Сохраняю в snapshot…');
    try {
      const fd = new FormData();
      fd.append('file', aiFile);
      fd.append('headers', JSON.stringify(parsePreview.headers));
      fd.append('rows', JSON.stringify(parsePreview.rows || []));
      fd.append('scenario_id', selectedScenario || 'pdf_extracted');
      if (projectId) fd.append('project_id', String(projectId));
      const res = await fetch(`${API}/pdf-parse-confirm`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Не удалось подтвердить парс');
      setSnapshotId(data.snapshotId);
      setActiveTableId(data.snapshotId);
      setNeedsConfirm(false);
      setCurrentQuestion(null);
      setPendingQuestions([]);
      setChatTables((prev) =>
        prev.map((t) =>
          t.isDraft || String(t.snapshotId).startsWith('draft-')
            ? {
                ...t,
                snapshotId: data.snapshotId,
                isDraft: false,
                rowCount: data.parsePreview?.rowCount ?? t.rowCount,
              }
            : t
        )
      );
      if (data.parsePreview) setParsePreview(data.parsePreview);
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Подтвердила парс: **${data.parsePreview?.rowCount ?? data.rowCount ?? 0}** строк в snapshot.`,
          artifact: {
            snapshotId: data.snapshotId,
            label: aiFile?.name || 'PDF',
            rowCount: data.parsePreview?.rowCount ?? data.rowCount ?? 0,
          },
        },
      ]);
      if (chatSessionId && data.snapshotId) {
        await refreshChatSessions();
      }
    } catch (e) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Не вышло подтвердить парс: ${e.message}` },
      ]);
    } finally {
      setAiLoading(false);
      setLoadingHint('');
    }
  };

  const startParseFromStaged = async (userMessage, scenarioIdOverride) => {
    if (!inboxReady) return;
    await runInboxParse({
      userMessage: userMessage || '',
      scenarioId: scenarioIdOverride,
      nextAnswers: orchestratorAnswers,
      targetSheetName: activeSheet || undefined,
    });
  };

  const resetSessionForNewFile = () => {
    setStagedProbe(null);
    setInboxReady(false);
    setInboxUploadCount(0);
    setAiFile(null);
    setParsePreview(null);
    setSnapshotId(null);
    setCompareResult(null);
    setCurrentRule(null);
    setLayoutAnalysis(null);
    setNeedsScenarioChoice(false);
    setNeedsConfirm(false);
    setSheetNames([]);
    setActiveSheet('');
    setSheetSessions({});
    setChatTables([]);
    setActiveTableId(null);
    setCurrentQuestion(null);
    setPendingQuestions([]);
    setOrchestratorAnswers({});
    setSelectedScenario(null);
    setScenarioName('');
  };

  const hasExistingChatWork = () =>
    chatTables.length > 0 ||
    Boolean(
      (snapshotId && !String(snapshotId).startsWith('draft-')) ||
        (activeTableId && !String(activeTableId).startsWith('draft-'))
    ) ||
    Boolean(parsePreview?.headers?.length) ||
    chatMessages.length > 0;

  const dedupeStagedFiles = (files) => {
    const seen = new Set();
    return files.filter((f) => {
      const key = `${f.webkitRelativePath || ''}|${f.name}|${f.size}|${f.lastModified}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const stageAttachments = async (files, { merge = false } = {}) => {
    const picked = dedupeStagedFiles(Array.from(files || []));
    if (!picked.length) return;

    let sid = chatSessionId;
    if (!sid) {
      try {
        sid = await ensureChatSession();
      } catch (e) {
        setChatMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: `Не могу создать чат: ${e.message}. Проверь, что сервер на :3001 запущен (cd server && node index.js).`,
          },
        ]);
        return;
      }
    }

    setAttachOpen(false);
    const keepChat = hasExistingChatWork();
    if (!keepChat) {
      resetSessionForNewFile();
    } else {
      setStagedProbe(null);
      setCurrentQuestion(null);
      setPendingQuestions([]);
    }

    setAiFile(picked[picked.length - 1]);
    setWorkMode(keepChat ? 'result' : 'parse');

    setAiLoading(true);
    setLoadingHint(`Загружаю в хранилище… 0/${picked.length}`);
    setUploadProgress(null);

    try {
      const uploaded = await uploadFilesToInbox(picked, (p) => {
        setUploadProgress(p);
        setLoadingHint(
          `Загружаю в хранилище… пачка ${p.chunk}/${p.total} (${p.files} файлов)`
        );
      });
      setInboxReady(true);
      setInboxUploadCount((prev) => (merge ? prev + uploaded.saved : uploaded.saved));
      const probe = uploaded.probe || (await fetchInboxProbe(''));
      setStagedProbe(probe);

      if (picked.length === 1) {
        try {
          const meta = await fetchSheetNames(picked[0]);
          if (meta.sheetNames?.length) {
            setSheetNames(meta.sheetNames);
            setActiveSheet(meta.defaultSheet || meta.sheetNames[0]);
          }
        } catch {
          /* не критично */
        }
      } else {
        setSheetNames([]);
        setActiveSheet('');
      }

      const intro = keepChat
        ? `Добавила **${uploaded.saved}** файл(ов) в хранилище (${uploaded.chunks} пачек). Вкладки **не трогаю**.`
        : `Загрузила **${uploaded.saved}** файл(ов) на сервер (${uploaded.chunks} пачек). **📎** — выбери что парсить. **Напиши задачу** в чате (сценарий, правила).`;
      const byKind = uploaded.byKind
        ? Object.entries(uploaded.byKind)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${k}: ${n}`)
            .join(', ')
        : '';
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: [intro, byKind ? `Разложила: ${byKind}.` : null, buildStagingMessage(probe)]
            .filter(Boolean)
            .join('\n\n'),
        },
      ]);
      setInboxStatus(intro);
      setInboxRefreshTick((t) => t + 1);
    } catch (e) {
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Не загрузила в хранилище: ${e.message}`,
        },
      ]);
    } finally {
      setAiLoading(false);
      setLoadingHint('');
      setUploadProgress(null);
    }
  };

  const fetchSheetNames = async (source) => {
    const formData = new FormData();
    formData.append('file', source);
    const response = await fetch(`${API}/parse/sheet-names`, { method: 'POST', body: formData });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'sheet-names failed');
    return data;
  };

  const runParseFromScope = async (userMessage = '') => {
    if (!parseScope?.path) {
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: 'Выбери **папку или файл** через 📎 — что парсить из хранилища.',
        },
      ]);
      return;
    }
    const msg = userMessage || inputText.trim();
    if (!hasParseBrief(msg)) {
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Выбрано: **${parseScope.path}**. ${PARSE_BRIEF_HINT}`,
        },
      ]);
      return;
    }
    setChatMessages((prev) => [...prev, { role: 'user', content: msg }]);
    setInputText('');
    await runInboxParse({
      userMessage: msg,
      pathScope: parseScope,
      scenarioId: orchestratorAnswers?.scenarioId,
      nextAnswers: orchestratorAnswers,
      targetSheetName: activeSheet || undefined,
    });
  };

  const handleWorkspaceUpload = async (fileList) => {
    const all = Array.from(fileList || []);
    const relevant = all.filter((f) =>
      /\.(pdf|xlsx|xls|xlsm|txt|csv|tsv|jpe?g|png|webp|gif|tiff?)$/i.test(f.name)
    );
    if (!relevant.length) {
      alert('Нет PDF, Excel или изображений в выборе');
      return;
    }
    await stageAttachments(relevant, { merge: hasExistingChatWork() });
  };

  const handleTargetFilePick = (t) => {
    setTargetFile(t);
    if (t) {
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Эталон **${t.name}** прикреплён. Напиши задачу — когда запустишь парс, сверю колонки.`,
        },
      ]);
    }
  };

  const answerPendingQuestion = (questionId, value) => {
    if (!inboxReady) return;
    const next = { ...(orchestratorAnswers || {}) };
    if (questionId === 'pick_scenario') next.scenarioId = value;
    if (questionId === 'pick_sheet') next.sheetName = value;
    if (questionId === 'pick_tree_flatten') {
      next.pick_tree_flatten = value;
      if (String(value).startsWith('scenario:')) {
        next.scenarioId = String(value).slice('scenario:'.length);
      }
    }
    if (questionId === 'pick_profile') next.profileId = value;
    if (questionId === 'pick_name_column') next.nameColumn = Number(value);
    if (questionId === 'pick_uk_quantity_column') next.quantityColumn = Number(value);
    if (questionId === 'pick_composite_column') next.compositeColumn = Number(value);
    if (questionId === 'pick_composite_field') {
      next.compositeExtracts = Array.isArray(next.compositeExtracts)
        ? [...next.compositeExtracts, value]
        : [value];
    }
    if (questionId === 'pick_merge_strategy') {
      next.mergeStrategy = value;
      next.pick_merge_strategy = value;
    }
    if (questionId === 'pdf_kind_choice') {
      next.pick_pdf_kind = value;
    }

    setOrchestratorAnswers(next);

    if (questionId === 'pdf_kind_choice') {
      const scenarioMap = {
        broker_report: 'broker_pdf',
        depo: 'opif_depo',
        upd_ediweb: 'upd_ediweb',
        unknown_pdf: 'unknown_pdf',
      };
      setNeedsScenarioChoice(false);
      setCurrentQuestion(null);
      setPendingQuestions([]);
      runInboxParse({
        userMessage: 'разбери pdf',
        scenarioId: scenarioMap[value] || value,
        nextAnswers: next,
        targetSheetName: activeSheet || undefined,
      });
      return;
    }

    if (questionId === 'pick_merge_strategy') {
      const lastUser =
        [...chatMessages].reverse().find((m) => m.role === 'user' && String(m.content || '').trim())
          ?.content || 'разбери файлы';
      runInboxParse({
        userMessage: lastUser,
        nextAnswers: next,
      });
      return;
    }

    if (questionId === 'pick_tree_flatten' && sheetNames.length > 1) {
      runInboxParse({
        userMessage: '',
        parseAllSheets: true,
        knownSheetNames: sheetNames,
      });
      return;
    }

    let sheetForParse = activeSheet || undefined;
    if (questionId === 'pick_tree_flatten' && value === 'confirm' && sheetForParse && /кс/i.test(sheetForParse)) {
      const osv =
        sheetNames.find((s) => /исходн.*осв/i.test(s)) ||
        sheetNames.find((s) => /осв/i.test(s) && !/кс/i.test(s));
      if (osv) {
        sheetForParse = osv;
        setActiveSheet(osv);
      }
    }
    runInboxParse({
      userMessage: '',
      pathScope: parseScope,
      scenarioId: next.scenarioId || null,
      nextAnswers: stripOpifHintsForScopedFile(next, parseScope),
      targetSheetName: sheetForParse,
    });
  };

  const buildUiContextForConverse = useCallback(() => {
    const activeTab = chatTables.find(
      (t) => t.snapshotId === activeTableId || t.snapshotId === snapshotId
    );
    return {
      fileName: aiFile?.name || activeTab?.sourceFileName || '',
      sheetName: activeSheet || activeTab?.sheetName || layoutAnalysis?.sheetName || '',
      scenarioName: scenarioName || '',
      scenarioId: selectedScenario || '',
      headers: parsePreview?.headers || [],
      tableMeta: parsePreview?.tableMeta || null,
      rowCount: parsePreview?.rowCount ?? parsePreview?.rows?.length ?? 0,
      sampleRow: parsePreview?.rows?.[0] || null,
      layoutSummary: layoutAnalysis?.recommended?.description || '',
    };
  }, [
    chatTables,
    activeTableId,
    snapshotId,
    aiFile,
    activeSheet,
    layoutAnalysis,
    scenarioName,
    selectedScenario,
    parsePreview,
  ]);

  const runConverse = useCallback(
    async (text, { skipUserBubble = false, messagesOverride = null } = {}) => {
      const userText = String(text || '').trim();
      if (!userText) return;
      if (!skipUserBubble) {
        setChatMessages((prev) => [...prev, { role: 'user', content: userText }]);
        setInputText('');
      }
      setAiLoading(true);
      const sid =
        activeTableId && !String(activeTableId).startsWith('draft-')
          ? activeTableId
          : snapshotId;
      const activeSnap = sid && !String(sid).startsWith('draft-') ? parseInt(sid, 10) : null;
      const msgs =
        messagesOverride ||
        [...chatMessages, { role: 'user', content: userText }].filter(
          (m) => m.role === 'user' || m.role === 'assistant'
        );
      try {
        const response = await fetch(`${API}/ai/converse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: userText,
            messages: msgs,
            chatSessionId: chatSessionId || null,
            projectId: projectId || null,
            activeSnapshotId: Number.isFinite(activeSnap) ? activeSnap : null,
            uiContext: buildUiContextForConverse(),
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || response.status);
        if (data.assistantMessage) {
          setChatMessages((prev) => [...prev, { role: 'assistant', content: data.assistantMessage }]);
        }
        if (data.tableOperation) {
          const sid =
            activeTableId && !String(activeTableId).startsWith('draft-')
              ? activeTableId
              : snapshotId;
          if (data.headers) {
            setParsePreview((prev) => ({
              ...(prev || {}),
              headers: data.headers,
            }));
          }
          if (sid && !String(sid).startsWith('draft-')) {
            await reloadSnapshotPage(sid, previewPage, {
              highlightCols: Array.isArray(data.newColumns) ? data.newColumns : [],
            });
          }
        }
        if (data.reconcileClarification && data.questions?.length) {
          setCurrentQuestion(data.questions[0]);
        }
        if (data.reconcileOperation && data.snapshotId) {
          const label = data.title || `Сверка #${data.snapshotId}`;
          await syncChatTablesAfterParse(data.snapshotId, label);
          setSnapshotId(data.snapshotId);
          setActiveTableId(data.snapshotId);
          setWorkMode('result');
          if (data.plan) setReconcilePlan(data.plan);
          await reloadSnapshotPage(data.snapshotId, 1);
        }
      } catch (e) {
        setChatMessages((prev) => [...prev, { role: 'assistant', content: `Сеть: ${e.message}` }]);
      } finally {
        setAiLoading(false);
      }
    },
    [
      chatMessages,
      chatSessionId,
      projectId,
      activeTableId,
      snapshotId,
      previewPage,
      reloadSnapshotPage,
      buildUiContextForConverse,
      syncChatTablesAfterParse,
    ]
  );

  const wantsParseStart = (msg, scenId) => {
    const t = String(msg || '').trim();
    if (!hasParseBrief(t)) return false;
    if (scenId) return true;
    if (isInboxTableBrief(t)) return true;
    if (
      /спарс|вытащ|возьми\s+данн|данн[ыеа]\s+1f|таблиц.*1\.1|таблиц.*1\.2|прекращ|не\s+исполн|репо|номер\s+сделки/i.test(
        t
      ) &&
      /1f\d{3}|брокер|депо/i.test(t)
    ) {
      return true;
    }
    return /разбер|парс|загруз|обработ|разлож|выгруз|depo|депо|брокер|ук\b|1f\d|начина|префикс|объедин|смерж|в\s+одну\s+таб|осв|карт|выгрузк|excel|xlsx|сч[её]т|58\.|76\.|01\b|созда(?:ть|й)\s+таблиц/i.test(
      t
    );
  };

  const wantsRuleRefine = (msg) =>
    /правил|сценари|разверн|плоск|иерарх|(?:добавь|создай|сделай|надо\s+созда(?:ть|й)|нужно\s+созда(?:ть|й))\s+(?:колонк|столбц)|(?:убери|удали)\s+(?:колонк|столбц)|можешь\s+сделать\s+(?:новый\s+)?(?:колонк|столбц)|нов(?:ую|ый|ое)\s+(?:колонк|столбц).*?(?:после|перед|назов)/i.test(
      String(msg || '')
    );

  const resolveTableCommandText = (raw, history) => {
    const t = String(raw || '').trim();
    if (!t || !/^колонк[ауеи]\s+\S/i.test(t)) return t;
    const prevUser = [...(history || [])]
      .reverse()
      .find((m) => m.role === 'user' && String(m.content || '').trim());
    if (!prevUser) return t;
    const prev = String(prevUser.content).trim();
    if (
      isTableCommand(prev) ||
      /(?:новую\s+)?(?:таблиц|вкладк)|(?:где|содержит|оставь|перенес)/i.test(prev)
    ) {
      return `${prev}. ${t}`;
    }
    return t;
  };

  const sendChat = async (overrideText, scenarioId) => {
    const text = (overrideText ?? inputText).trim();
    const effectiveText = resolveTableCommandText(text, chatMessages);
    const pendingTableConfirm = resolvePendingTableConfirmation(text, chatMessages);
    const tableActionMessage = pendingTableConfirm?.message || effectiveText;
    const hasFiles = inboxReady;
    const hasActiveTable = Boolean(
      (snapshotId && !String(snapshotId).startsWith('draft-')) ||
        (activeTableId && !String(activeTableId).startsWith('draft-')) ||
        parsePreview?.headers?.length
    );

    if (text && currentQuestion) {
      let resolved = resolveQuestionAnswerFromText(text, currentQuestion);
      if (resolved == null) {
        try {
          const resp = await fetch(`${API}/ai/resolve-answer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userText: text,
              question: currentQuestion,
              layoutMeta: layoutAnalysis || null,
            }),
          });
          const data = await resp.json();
          if (data?.ok && data.resolved?.value) resolved = data.resolved.value;
        } catch {
          /* fallback below */
        }
      }
      if (resolved != null) {
        setChatMessages((prev) => [...prev, { role: 'user', content: text }]);
        setInputText('');
        answerPendingQuestion(currentQuestion.id, resolved);
        return;
      }
      if (hasFiles) {
        setChatMessages((prev) => [...prev, { role: 'user', content: text }]);
        setInputText('');
        await runInboxParse({
          userMessage: text,
          scenarioId: orchestratorAnswers?.scenarioId,
          nextAnswers: orchestratorAnswers,
          targetSheetName: activeSheet || undefined,
        });
        return;
      }
    }

    if (text && !currentQuestion && needsScenarioChoice && sourceKind === 'pdf' && scenarioCandidates.length) {
      const lower = text.toLowerCase();
      const picked = scenarioCandidates.find(
        (c) =>
          lower.includes(String(c.label || '').toLowerCase()) ||
          lower.includes(String(c.scenarioId || '').replace(/_/g, ' '))
      );
      if (picked) {
        setChatMessages((prev) => [...prev, { role: 'user', content: text }]);
        setInputText('');
        pickPdfKind(picked.scenarioId);
        return;
      }
    }

    if (text && !currentQuestion && needsScenarioChoice) {
      const picked = resolveScenarioFromText(text, choiceScenarios);
      if (picked) {
        setChatMessages((prev) => [...prev, { role: 'user', content: text }]);
        setInputText('');
        pickScenario(picked);
        return;
      }
    }

    if (text && looksLikeReconcileIntent(text) && (projectId || chatSessionId)) {
      setChatMessages((prev) => [...prev, { role: 'user', content: text }]);
      setInputText('');
      await runConverse(text, { skipUserBubble: true });
      return;
    }

    const tableCmd =
      !looksLikeReconcileIntent(text) &&
      (isTableCommand(tableActionMessage) ||
        Boolean(pendingTableConfirm) ||
        looksLikeTableMutationIntent(text));
    const tableQuery = hasActiveTable && isTableQuery(text);
    const explicitReparse = /(?:спарс|разбер)\w*\s+(?:заново|снова|ещё\s*раз)|перепарс/i.test(text);
    const tableWorkOnSnapshot =
        hasActiveTable && (tableCmd || tableQuery || isTableCommand(text)) && !explicitReparse;
    /** Файл выбран в 📎 — любая задача ≥3 символов стартует парс, не LLM-болтовню */
    const scopedParseIntent =
      !looksLikeReconcileIntent(text) &&
      parseScope?.path &&
      hasParseBrief(text) &&
      !tableWorkOnSnapshot &&
      !tableCmd &&
      !tableQuery;

    if (
      hasFiles &&
      !looksLikeReconcileIntent(text) &&
      (wantsParseStart(text, scenarioId) || scopedParseIntent) &&
      !tableWorkOnSnapshot
    ) {
      if (!parseScope?.path) {
        setChatMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: 'Выбери **папку или файл** через 📎, потом напиши задачу и Enter.',
          },
        ]);
        return;
      }
      const sheetCount = sheetNames.length;
      const parseAllSheets =
        /все\s+лист|кажд\w+\s+лист|multi.?sheet|все\s+вкладк/i.test(text) ||
        (sheetCount > 1 && /все\s+лист|кажд\w+\s+лист/i.test(text));
      const cmdText = text;
      setChatMessages((prev) => [...prev, { role: 'user', content: text }]);
      setInputText('');
      setAiLoading(true);
      setLoadingHint('Строю план…');
      try {
        const scopedMetas = fileMetasFromParseScope(parseScope);
        const { parsePlan: plan, reasoningTrace: planTrace } = await fetchPlanPreview(
          cmdText,
          scopedMetas,
          scopedMetas.length ? null : stagedProbe
        );
        let nextAnswers = {
          ...orchestratorAnswers,
          ...(plan?.scenarioId ? { scenarioId: plan.scenarioId } : {}),
          ...(plan?.filePrefix ? { filePrefix: plan.filePrefix } : {}),
          ...(plan?.sheetName ? { sheetName: plan.sheetName } : {}),
          ...(plan?.brokerSection ? { brokerSection: plan.brokerSection } : {}),
        };
        nextAnswers = stripOpifHintsForScopedFile(nextAnswers, parseScope);
        const scopedScenarioId = resolveScenarioForScopedParse(
          scenarioId || plan?.scenarioId || nextAnswers?.scenarioId,
          parseScope
        );
        if (plan?.summary) {
          setOrchestratorAnswers(nextAnswers);
          setChatMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: `📋 План: **${plan.summary}**`,
              reasoningTrace: planTrace || null,
            },
          ]);
        }
        await runInboxParse({
          userMessage: cmdText,
          pathScope: parseScope,
          scenarioId: scopedScenarioId,
          nextAnswers,
          targetSheetName: activeSheet || plan?.sheetName || undefined,
          filePrefix: scopedScenarioId === 'opif_broker' ? plan?.filePrefix || nextAnswers?.filePrefix : undefined,
          parseAllSheets: plan?.parseAllSheets || parseAllSheets,
        });
      } catch (e) {
        setChatMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `Не смогла запустить парс: ${e.message}` },
        ]);
        setAiLoading(false);
        setLoadingHint('');
      }
      return;
    }

    if (text && isEgrulIntent(text)) {
      setChatMessages((prev) => [...prev, { role: 'user', content: text }]);
      setInputText('');
      await runEgrulFetch(text);
      return;
    }

    if (text && hasActiveTable && tableQuery && !tableCmd) {
      await runConverse(text);
      return;
    }

    if (text && !tableCmd && (!hasActiveTable || !wantsRuleRefine(text))) {
      await runConverse(text);
      return;
    }

    if (!text && !scenarioId) return;
    if (!hasFiles && !hasActiveTable) {
      await runConverse(text);
      return;
    }

    if (tableCmd && hasActiveTable && text) {
      setWorkMode('result');
      setChatMessages((prev) => [...prev, { role: 'user', content: text }]);
      setInputText('');
      const tableActionText = tableActionMessage;

      let previewForAction = parsePreview;
      if (!previewForAction?.headers?.length) {
        const sid =
          activeTableId && !String(activeTableId).startsWith('draft-')
            ? activeTableId
            : snapshotId;
        setAiLoading(true);
        try {
          if (sid) {
            const data = await reloadSnapshotPage(sid, previewPage);
            if (data?.headers?.length) {
              previewForAction = {
                headers: data.headers,
                rows: (data.rows || []).map(stripRowMeta),
                rowCount: data.total ?? data.rows?.length ?? 0,
              };
            }
          }
          if (!previewForAction?.headers?.length && sid) {
            throw new Error(
              'Таблица в БД есть, но превью не загрузилось. Обнови вкладку или открой таблицу слева — повторный парс файла не нужен.'
            );
          }
          if (!previewForAction?.headers?.length && hasFiles && !sid) {
            const boot = await fetchInboxParse({
              userMessage: '',
              scenarioId: orchestratorAnswers?.scenarioId || 'os_01_hierarchy',
              nextAnswers: orchestratorAnswers,
              targetSheetName: activeSheet || undefined,
            });
            applySessionData(boot, activeSheet || undefined);
            previewForAction = boot.parsePreview || null;
          }
        } catch (e) {
          setChatMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: `Нет таблицы для команды. Сначала ответь в чате — «да, развернуть» или «плоская таблица», потом повтори.\n${e.message}`,
            },
          ]);
          setAiLoading(false);
          return;
        }
        setAiLoading(false);
      }

      if (!previewForAction?.headers?.length) {
        setChatMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content:
              'Таблица ещё не готова. Напиши в чате, как развернуть — например **«да, развернуть»** или **«плоская таблица»**, потом повтори команду.',
          },
        ]);
        return;
      }

      setAiLoading(true);
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: '⏳ Обрабатываю команду по таблице результата…' },
      ]);
      try {
        const actionData = await runResultTableAction(tableActionText, previewForAction, [
          ...chatMessages,
          { role: 'user', content: text },
        ]);
        const basePreview = previewForAction;
        if (actionData.handled) {
          if (actionData.fromSnapshot) {
            if (actionData.command?.action === 'filter_rows' && snapshotId) {
              setPreviewPage(1);
              await reloadSnapshotPage(snapshotId, 1);
              const kept = actionData.rowCount ?? actionData.filterStats?.after;
              const removed = actionData.filterStats?.removed;
              const prevTotal = parsePreview?.rowCount;
              if (actionData.command?.filters?.length) {
                setActiveFilterCount(actionData.command.filters.length);
              }
              setChatTables((prev) =>
                prev.map((t) =>
                  t.snapshotId === snapshotId && kept != null ? { ...t, rowCount: kept } : t
                )
              );
              setChatMessages((prev) => [
                ...prev,
                {
                  role: 'assistant',
                  content: actionData.assistantMessage || 'Готово.',
                  filterResult:
                    kept != null
                      ? { kept, total: prevTotal, removed }
                      : null,
                },
              ]);
              setAiLoading(false);
              return;
            }
            if (actionData.command?.action === 'replace_values' && snapshotId) {
              setChatMessages((prev) => [
                ...prev,
                { role: 'assistant', content: actionData.assistantMessage || 'Готово.' },
              ]);
              setAiLoading(false);
              return;
            }
            if (actionData.command?.action === 'delete_column') {
              const sid =
                activeTableId && !String(activeTableId).startsWith('draft-')
                  ? activeTableId
                  : snapshotId;
              if (sid) {
                setPreviewPage(1);
                await reloadSnapshotPage(sid, 1);
                if (actionData.headers?.length) {
                  setParsePreview((prev) => ({
                    ...(prev || {}),
                    headers: actionData.headers,
                  }));
                }
              }
              setChatMessages((prev) => [
                ...prev,
                { role: 'assistant', content: actionData.assistantMessage || 'Готово.' },
              ]);
              setAiLoading(false);
              return;
            }
            if (actionData.command?.action === 'add_column') {
              const sid =
                activeTableId && !String(activeTableId).startsWith('draft-')
                  ? activeTableId
                  : snapshotId;
              if (sid) {
                const newCols = actionData.newColumns || [actionData.command?.newColumnName].filter(Boolean);
                if (actionData.headers?.length) {
                  setParsePreview((prev) => {
                    const headers = actionData.headers;
                    const newCol = newCols[0];
                    const rows = (prev?.rows || []).map((r) => ({
                      ...r,
                      ...(newCol ? { [newCol]: r[newCol] ?? '' } : {}),
                    }));
                    return { ...(prev || {}), headers, rows, rowCount: prev?.rowCount };
                  });
                }
                await reloadSnapshotPage(sid, previewPage, { highlightCols: newCols });
              }
              setChatMessages((prev) => [
                ...prev,
                { role: 'assistant', content: actionData.assistantMessage || 'Готово.' },
              ]);
              setAiLoading(false);
              return;
            }
            if (actionData.command?.action === 'fill_column') {
              const sid =
                activeTableId && !String(activeTableId).startsWith('draft-')
                  ? activeTableId
                  : snapshotId;
              if (sid) {
                const highlight =
                  actionData.command?.targetColumn || actionData.command?.newColumnName
                    ? [actionData.command.targetColumn || actionData.command.newColumnName]
                    : [];
                await reloadSnapshotPage(sid, previewPage, { highlightCols: highlight });
              }
              setChatMessages((prev) => [
                ...prev,
                { role: 'assistant', content: actionData.assistantMessage || 'Готово.' },
              ]);
              setAiLoading(false);
              return;
            }
            if (actionData.command?.action === 'split_to_table') {
              if (actionData.newSnapshotId) {
                const newSid = actionData.newSnapshotId;
                const tabLabel =
                  [actionData.tableLabel, actionData.rowCount]
                    .filter((x) => x != null && x !== '')
                    .join(' · ') ||
                  actionData.tableLabel ||
                  'выборка';
                setChatTables((prev) => {
                  if (prev.some((t) => t.snapshotId === newSid)) return prev;
                  return [
                    ...prev,
                    {
                      snapshotId: newSid,
                      label: tabLabel,
                      sheetName: actionData.tableLabel || 'выборка',
                      rowCount: actionData.rowCount,
                      sourceFileName: aiFile?.name || '',
                    },
                  ];
                });
                setActiveTableId(newSid);
                setSnapshotId(newSid);
                setPreviewPage(1);
                await reloadSnapshotPage(newSid, 1);
                if (chatSessionId) {
                  const loaded = await fetch(`${API}/chats/${chatSessionId}`);
                  const chatData = await loaded.json();
                  if (loaded.ok && chatData.snapshots?.length) {
                    setChatTables(chatData.snapshots);
                  }
                }
                if (chatSessionId) await refreshChatSessions();
              }
              setChatMessages((prev) => [
                ...prev,
                {
                  role: 'assistant',
                  content:
                    actionData.assistantMessage ||
                    (actionData.newSnapshotId
                      ? 'Готово.'
                      : 'Не удалось создать вкладку — обнови страницу (F5) и проверь, что API на :3001 запущен.'),
                },
              ]);
              setAiLoading(false);
              return;
            }
            if (actionData.command?.auditorRule) setEnrichAuditorRule(actionData.command.auditorRule);
            if (actionData.command?.sourceColumn) setEnrichSourceColumn(actionData.command.sourceColumn);
            if (actionData.command?.action === 'classify') setEnrichMode('classify');
            if (actionData.command?.action === 'extract') setEnrichMode('extract');
            setChatMessages((prev) => [
              ...prev,
              { role: 'assistant', content: actionData.assistantMessage || 'Готово.' },
            ]);
            setAiLoading(false);
            return;
          }
          if (actionData.command?.action === 'filter_rows' && Array.isArray(actionData.filteredRows)) {
            persistPreview({
              ...basePreview,
              rows: actionData.filteredRows,
              rowCount: actionData.rowCount ?? actionData.filteredRows.length,
            });
            setPreviewPage(1);
            setChatMessages((prev) => [
              ...prev,
              { role: 'assistant', content: actionData.assistantMessage || 'Фильтр применён.' },
            ]);
            setAiLoading(false);
            return;
          }
          if (actionData.command?.action === 'split_to_table' && Array.isArray(actionData.filteredRows)) {
            const previewNote =
              basePreview?.rowCount &&
              basePreview.rowCount > (actionData.filterStats?.before ?? basePreview?.rows?.length ?? 0)
                ? `\n\n⚠️ Обработано только превью (${actionData.filterStats?.before ?? basePreview?.rows?.length ?? 0} из ${basePreview.rowCount}). Дождись полного парса в БД — тогда split сохранится во вкладку.`
                : '';
            setChatMessages((prev) => [
              ...prev,
              {
                role: 'assistant',
                content:
                  (actionData.assistantMessage || 'Не удалось создать вкладку.') +
                  previewNote +
                  (actionData.needsSnapshot
                    ? '\n\n⚠️ Таблица ещё не в БД — перезагрузи файл и дождись snapshot, потом повтори split.'
                    : ''),
              },
            ]);
            setAiLoading(false);
            return;
          }
          if (actionData.needsSnapshot) {
            setChatMessages((prev) => [
              ...prev,
              {
                role: 'assistant',
                content:
                  actionData.assistantMessage ||
                  'Команда требует snapshot в БД. Дождись полного парса или перезагрузи файл.',
              },
            ]);
            setAiLoading(false);
            return;
          }
          if (actionData.deleteColumn) {
            const hit = actionData.deleteColumn;
            const nextHeaders = basePreview.headers.filter((h) => h !== hit);
            const nextRows = (basePreview.rows || []).map((row) => {
              const copy = { ...row };
              delete copy[hit];
              return copy;
            });
            persistPreview({
              ...basePreview,
              headers: nextHeaders,
              rows: nextRows,
              rowCount: nextRows.length,
            });
            setChatMessages((prev) => [
              ...prev,
              { role: 'assistant', content: actionData.assistantMessage || `Убрала колонку «${hit}».` },
            ]);
            setAiLoading(false);
            return;
          }
          if (Array.isArray(actionData.enriched)) {
            const nextPreview = applyEnrichmentToPreview(basePreview, actionData.enriched);
            const newCols = (actionData.command?.extractFields || [])
              .map((f) => f.target_column)
              .filter(Boolean);
            const fromEnriched = new Set();
            for (const e of actionData.enriched) {
              Object.keys(e.values || {}).forEach((k) => fromEnriched.add(k));
            }
            persistPreview(nextPreview, {
              highlightCols: newCols.length ? newCols : [...fromEnriched],
            });
            if (actionData.command?.auditorRule) setEnrichAuditorRule(actionData.command.auditorRule);
            if (actionData.command?.sourceColumn) setEnrichSourceColumn(actionData.command.sourceColumn);
            if (actionData.command?.action === 'classify') setEnrichMode('classify');
            if (actionData.command?.action === 'extract') setEnrichMode('extract');
            setChatMessages((prev) => [
              ...prev,
              { role: 'assistant', content: actionData.assistantMessage || 'Готово.' },
            ]);
            setAiLoading(false);
            return;
          }
          if (actionData.assistantMessage) {
            setChatMessages((prev) => [...prev, { role: 'assistant', content: actionData.assistantMessage }]);
            setAiLoading(false);
            return;
          }
        } else if (!actionData.handled && !isTableCommand(tableActionText)) {
          setAiLoading(false);
          await runConverse(text, { skipUserBubble: true });
          return;
        } else if (actionData.assistantMessage || actionData.fromSnapshot) {
          setChatMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: actionData.assistantMessage || 'Не поняла команду для этой таблицы.',
            },
          ]);
          setAiLoading(false);
          return;
        }
      } catch (e) {
        setChatMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `Не смогла выполнить команду по таблице: ${e.message}` },
        ]);
        setAiLoading(false);
        return;
      }
      setAiLoading(false);

      const deleteIntent = /(удал\S*|убер\S*|remove|delete)/i.test(text);
      const removeColumnMatch =
        text.match(/(?:удал\S*|убер\S*|remove|delete)\s+(?:колонк[ауи]?|column)\s+["«']?([^"»'\n]+)/i) ||
        text.match(/(?:удал\S*|убер\S*|remove|delete)\s+["«']?([^"»'\n]+)/i);

      if (deleteIntent) {
        const rawRequested = String(removeColumnMatch?.[1] || '').trim();
        const requestedNorm = normalizeText(rawRequested);
        const headerNorms = parsePreview.headers.map((h) => ({
          header: h,
          norm: normalizeText(h),
        }));

        // exact first, then "contains"
        let hit =
          headerNorms.find((x) => x.norm === requestedNorm)?.header ||
          headerNorms.find((x) => requestedNorm && x.norm.includes(requestedNorm))?.header;

        // common short aliases
        if (!hit) {
          const aliasMap = {
            группа: 'Группа',
            подразделение: 'Подразделение',
            ос: 'ОС',
            год: 'Год',
            тип: 'тип',
          };
          const alias = aliasMap[requestedNorm];
          if (alias) {
            hit = headerNorms.find((x) => x.norm === normalizeText(alias))?.header;
          }
        }

        if (!hit) {
          setChatMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content:
                `Не нашла колонку «${rawRequested || '...'}» в текущем результате.\n` +
                `Доступные: ${parsePreview.headers.slice(0, 8).join(', ')}${parsePreview.headers.length > 8 ? '…' : ''}`,
            },
          ]);
          return;
        }

        const nextHeaders = parsePreview.headers.filter((h) => h !== hit);
        const nextRows = (parsePreview.rows || []).map((row) => {
          const copy = { ...row };
          delete copy[hit];
          return copy;
        });

        setParsePreview({
          ...parsePreview,
          headers: nextHeaders,
          rows: nextRows,
          rowCount: nextRows.length,
        });
        if (activeSheet) {
          setSheetSessions((prev) => ({
            ...prev,
            [activeSheet]: {
              ...(prev[activeSheet] || {}),
              parsePreview: {
                ...(parsePreview || {}),
                headers: nextHeaders,
                rows: nextRows,
                rowCount: nextRows.length,
              },
            },
          }));
        }
        setChatMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `Ок, убрала колонку «${hit}» из текущей таблицы результата.` },
        ]);
        return;
      }

      await runConverse(text, { skipUserBubble: true });
      return;
    }

    const newMessages = text ? [...chatMessages, { role: 'user', content: text }] : chatMessages;
    if (text) {
      setChatMessages(newMessages);
      setInputText('');
    }
    setAiLoading(true);

    const formData = new FormData();
    formData.append('profileFamily', 'os');
    formData.append('messages', JSON.stringify(newMessages.length ? newMessages : [{ role: 'user', content: SCENARIO_PHRASES[scenarioId] || 'продолжить' }]));
    formData.append('file', aiFile);
    if (currentRule) formData.append('currentRule', JSON.stringify(currentRule));
    if (layoutAnalysis) formData.append('layoutAnalysis', JSON.stringify(layoutAnalysis));
    if (activeSheet) formData.append('sheetName', activeSheet);
    if (targetFile) formData.append('target', targetFile);
    if (projectId) formData.append('project_id', String(projectId));
    if (orchestratorAnswers && Object.keys(orchestratorAnswers).length) {
      formData.append('orchestratorAnswers', JSON.stringify(orchestratorAnswers));
    }
    if (scenarioId) formData.append('scenarioId', scenarioId);
    if (chatSessionId) formData.append('chatSessionId', String(chatSessionId));

    try {
      const response = await fetch(`${API}/ai/chat`, { method: 'POST', body: formData });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setChatMessages((prev) => [...prev, { role: 'assistant', content: `Ошибка: ${data.error || response.status}` }]);
        return;
      }
      applySessionData(data);
      setRuleDiff(data.ruleDiff);
      setPreviewPage(1);
      if (data.assistantMessage) {
        setChatMessages((prev) => [...prev, { role: 'assistant', content: data.assistantMessage }]);
      }
    } catch (e) {
      setChatMessages((prev) => [...prev, { role: 'assistant', content: 'Сеть: ' + e.message }]);
    } finally {
      setAiLoading(false);
    }
  };

  const applyEnrichmentToPreview = useCallback((basePreview, enrichedRows) => {
    if (!basePreview) return null;
    const rows = (basePreview.rows || []).map((r) => ({ ...r }));
    const extraHeaders = new Set();
    for (const e of enrichedRows || []) {
      const idx = Number(e.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) continue;
      const values = e.values || {};
      for (const k of Object.keys(values)) {
        rows[idx][k] = values[k];
        extraHeaders.add(k);
      }
    }
    const headers = [...(basePreview.headers || [])];
    for (const h of extraHeaders) {
      if (!headers.includes(h)) headers.push(h);
    }
    return { ...basePreview, headers, rows, rowCount: rows.length };
  }, []);

  const localExtract = useCallback((rows, sourceColumn) => {
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const text = String((rows[i] && rows[i][sourceColumn]) ?? '');
      const dm = text.match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/);
      const withoutDate = text.replace(/\b\d{2}\.\d{2}\.\d{4}\b/g, ' ');
      const m80 = withoutDate.match(/\b(80-\d+)\b/i);
      const nums = [...withoutDate.matchAll(/\b\d{6,}\b/g)].map((m) => m[0]);
      const inventory = m80 ? m80[1] : nums.find((n) => n.length >= 8) || nums[nums.length - 1] || null;
      let address = null;
      const afterAddress = text.match(/по\s+адресу[:\s]*([^,]+(?:,\s*[^,]+){1,4})/i);
      if (afterAddress?.[1]) address = afterAddress[1].trim();
      out.push({
        index: i,
        values: {
          inventory_extracted: inventory,
          date_extracted: dm ? dm[0] : null,
          address_extracted: address,
        },
      });
    }
    return out;
  }, []);

  const persistPreview = useCallback(
    (nextPreview, options = {}) => {
      setParsePreview(nextPreview);
      if (options.highlightCols?.length) {
        setHighlightHeaders(options.highlightCols);
        setPreviewPage(1);
        requestAnimationFrame(() => {
          const el = tableScrollRef.current;
          if (el) el.scrollLeft = el.scrollWidth;
        });
      }
      if (activeSheet) {
        setSheetSessions((prev) => ({
          ...prev,
          [activeSheet]: {
            ...(prev[activeSheet] || {}),
            snapshotId,
            parsePreview: nextPreview,
          },
        }));
      }
    },
    [activeSheet]
  );

  const rowsForTableAction = useCallback(
    (message, previewOverride = null) => {
      const all = previewOverride?.rows || parsePreview?.rows || [];
      const isClassifyOnly =
        /(проанализ|классиф)/i.test(message) &&
        !/(вытащи|извлеки|перенес|убер\S*|удал\S*).*?(инвентар|номер|дат)/i.test(message);
      if (isClassifyOnly && all.length > CLASSIFY_ROW_LIMIT) {
        return { rows: all.slice(0, CLASSIFY_ROW_LIMIT), truncated: true, total: all.length };
      }
      return { rows: all, truncated: false, total: all.length };
    },
    [parsePreview]
  );

  const runResultTableAction = async (message, previewOverride = null, chatContext = null) => {
    const resolveSnapshotId = () => {
      const candidates = [activeTableId, snapshotId];
      for (const c of candidates) {
        if (c && !String(c).startsWith('draft-')) return c;
      }
      const activeTab =
        chatTables.find((t) => t.snapshotId === activeTableId) ||
        chatTables.find((t) => t.snapshotId === snapshotId);
      if (activeTab?.snapshotId && !String(activeTab.snapshotId).startsWith('draft-')) {
        return activeTab.snapshotId;
      }
      return null;
    };

    const materializePreviewSnapshot = async (preview) => {
      if (!preview?.headers?.length || !preview?.rows?.length) return null;
      const total = preview.rowCount ?? preview.rows.length;
      const body = {
        headers: preview.headers,
        rows: preview.rows,
        rowCount: total,
        sourceFileName: aiFile?.name || 'preview',
        sheetName: activeSheet || preview.sheetName || 'лист',
        scenarioId: selectedScenario || orchestratorAnswers?.scenarioId || null,
        projectId: projectId || undefined,
        chatSessionId: chatSessionId || undefined,
      };
      const response = await fetch(`${API}/parse/snapshots/import-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.snapshotId) return null;
      const sid = data.snapshotId;
      setSnapshotId(sid);
      setActiveTableId(sid);
      const tabLabel = [body.sourceFileName, body.sheetName, data.rowCount ?? total]
        .filter((x) => x != null && x !== '')
        .join(' · ');
      setChatTables((prev) => {
        const withoutDrafts = prev.filter((t) => !t.isDraft);
        if (withoutDrafts.some((t) => t.snapshotId === sid)) return withoutDrafts;
        return [
          ...withoutDrafts,
          {
            snapshotId: sid,
            label: tabLabel,
            sheetName: body.sheetName,
            rowCount: data.rowCount ?? total,
            sourceFileName: body.sourceFileName,
          },
        ];
      });
      if (chatSessionId) syncChatTablesAfterParse(sid, tabLabel);
      return sid;
    };

    let sid = resolveSnapshotId();
    const previewForMaterialize = previewOverride || parsePreview;
    const previewRowsCount = previewForMaterialize?.rows?.length || 0;
    const totalRows = previewForMaterialize?.rowCount ?? previewRowsCount;
    const needsDbImport =
      !sid &&
      totalRows > previewRowsCount &&
      aiFile &&
      (sourceKind === 'text_1c' || /\.(txt|csv|tsv)$/i.test(aiFile.name || ''));
    if (needsDbImport) {
      try {
        const fd = new FormData();
        fd.append('file', aiFile);
        if (chatSessionId) fd.append('chatSessionId', String(chatSessionId));
        if (projectId) fd.append('projectId', String(projectId));
        const imp = await fetch(`${API}/parse/snapshots/import-text`, { method: 'POST', body: fd });
        const impData = await imp.json().catch(() => ({}));
        if (imp.ok && impData.snapshotId) {
          sid = impData.snapshotId;
          setSnapshotId(sid);
          setActiveTableId(sid);
          setParsePreview((prev) => ({
            headers: impData.parsePreview?.headers || prev?.headers || [],
            rows: impData.parsePreview?.rows || prev?.rows || [],
            rowCount: impData.parsePreview?.rowCount ?? prev?.rowCount ?? totalRows,
          }));
          const tabLabel = [aiFile.name, impData.rowCount ?? totalRows]
            .filter((x) => x != null && x !== '')
            .join(' · ');
          setChatTables((prev) => {
            if (prev.some((t) => t.snapshotId === sid)) return prev;
            return [
              ...prev.filter((t) => !t.isDraft),
              {
                snapshotId: sid,
                label: tabLabel,
                sheetName: aiFile.name,
                rowCount: impData.rowCount ?? totalRows,
                sourceFileName: aiFile.name,
              },
            ];
          });
          if (chatSessionId) syncChatTablesAfterParse(sid, tabLabel);
        }
      } catch {
        /* fallback to preview-only path */
      }
    }

    if (
      !sid &&
      previewForMaterialize?.headers?.length &&
      previewForMaterialize?.rows?.length &&
      (previewRowsCount >= totalRows || /новую\s+таблиц|новая\s+таблиц|split_to_table|переименуй\s+колонк|удали\s+колонк/i.test(message))
    ) {
      sid = await materializePreviewSnapshot(previewForMaterialize);
    }

    const recentMessages = (chatContext || chatMessages)
      .filter((m) => m?.role === 'user' || m?.role === 'assistant')
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }));
    const tableActionPayload = {
      message,
      messages: recentMessages,
      chatSessionId: chatSessionId || undefined,
    };
    if (sid) {
      const response = await fetch(`${API}/parse/snapshots/${sid}/apply-operation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...tableActionPayload,
          logChat: true,
          options: {
            threshold: Number(enrichThreshold) || 0.7,
            auditorRule: enrichAuditorRule,
            maxUnique: 80,
          },
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `apply-operation ${response.status}`);
      if (data.handled && data.newSnapshotId) {
        return {
          ...data,
          enriched: null,
          fromSnapshot: true,
        };
      }
      if (data.handled) {
        if (data.headers) {
          const newCols = data.newColumns || (data.command?.newColumnName ? [data.command.newColumnName] : []);
          setParsePreview((prev) => {
            const headers = data.headers;
            const newCol = newCols[0];
            const rows = (prev?.rows || []).map((r) => ({
              ...r,
              ...(newCol ? { [newCol]: r[newCol] ?? '' } : {}),
            }));
            return {
              ...(prev || {}),
              headers,
              rows: newCol && prev?.rows?.length ? rows : prev?.rows,
              rowCount: prev?.rowCount,
            };
          });
        }
        const mutating =
          data.headers ||
          data.command?.action === 'replace_values' ||
          data.command?.action === 'filter_rows' ||
          data.command?.action === 'delete_column' ||
          data.command?.action === 'move_column' ||
          data.command?.action === 'rename_column' ||
          data.command?.action === 'add_column' ||
          data.command?.action === 'duplicate_column' ||
          data.command?.action === 'undo_last' ||
          (data.affectedRows != null && data.affectedRows > 0);
        if (mutating) {
          const highlightCols =
            data.newColumns ||
            (data.command?.action === 'replace_values' && data.command?.column
              ? [data.command.column]
              : []);
          await reloadSnapshotPage(sid, previewPage, { highlightCols });
        }
      }
      return {
        ...data,
        enriched: null,
        fromSnapshot: true,
      };
    }

    const preview = previewOverride || parsePreview;
    const { rows, truncated, total } = rowsForTableAction(message, preview);
    const response = await fetch(`${API}/ai/result-table-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...tableActionPayload,
        headers: preview.headers,
        rows,
        options: {
          threshold: Number(enrichThreshold) || 0.7,
          auditorRule: enrichAuditorRule,
          maxUnique: 80,
          truncatedMeta: truncated ? { total, processed: rows.length } : null,
        },
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `result-table-action ${response.status}`);
    if (data.needsSnapshot) {
      return {
        ...data,
        handled: false,
        fromSnapshot: false,
      };
    }
    return data;
  };

  const runEnrichment = async () => {
    if (workMode !== 'result') {
      setWorkMode('result');
    }
    if (!parsePreview?.headers?.length) {
      setEnrichError('Сначала нужна таблица результата — загрузи файл и дождись разбора.');
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Нет таблицы результата. Сначала загрузи Excel и дождись превью.' },
      ]);
      return;
    }
    if (!snapshotId && !parsePreview?.rows?.length) {
      setEnrichError('В превью нет строк для обогащения.');
      return;
    }
    if (!enrichSourceColumn) {
      setEnrichError('Выбери колонку для обогащения.');
      return;
    }
    setEnrichError('');
    setEnrichLoading(true);
    setChatMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        content:
          enrichMode === 'classify'
            ? `⏳ Запускаю ИИ-классификацию по колонке «${enrichSourceColumn}»… подожди, это не мгновенно.`
            : `⏳ Извлекаю дату и адрес из колонки «${enrichSourceColumn}»…`,
      },
    ]);
    try {
      const extractMsg = `Вытащи инвентарный номер и дату из колонки ${enrichSourceColumn}.`;
      const classifyMsg = `Проанализируй колонку ${enrichSourceColumn}: ${enrichAuditorRule}`;
      const msg = enrichMode === 'extract' ? extractMsg : classifyMsg;
      const actionData = await runResultTableAction(msg);

      if (actionData.fromSnapshot && actionData.handled) {
        setChatMessages((prev) => [
          ...prev.slice(0, -1),
          { role: 'assistant', content: actionData.assistantMessage || 'Готово.' },
        ]);
      } else if (enrichMode === 'extract' && Array.isArray(actionData.enriched)) {
        const nextPreview = applyEnrichmentToPreview(parsePreview, actionData.enriched);
        const newCols = Object.keys(actionData.enriched[0]?.values || {});
        persistPreview(nextPreview, { highlightCols: newCols });
        setChatMessages((prev) => [
          ...prev.slice(0, -1),
          {
            role: 'assistant',
            content:
              actionData.assistantMessage ||
              `Готово: добавила колонки из «${enrichSourceColumn}». Прокрути таблицу вправо.`,
          },
        ]);
      } else if (!snapshotId) {
        const { rows } = rowsForTableAction(msg);
        const enrichedRows = enrichMode === 'extract' ? localExtract(rows, enrichSourceColumn) : [];
        if (enrichedRows.length) {
          persistPreview(applyEnrichmentToPreview(parsePreview, enrichedRows), {
            highlightCols: Object.keys(enrichedRows[0]?.values || {}),
          });
        }
        setChatMessages((prev) => [
          ...prev.slice(0, -1),
          { role: 'assistant', content: actionData.assistantMessage || 'Готово (локально).' },
        ]);
      } else {
        setChatMessages((prev) => [
          ...prev.slice(0, -1),
          { role: 'assistant', content: actionData.assistantMessage || 'Готово.' },
        ]);
      }
    } catch (e) {
      setEnrichError(e.message);
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Ошибка обогащения: ${e.message}. Бэк на :3001 запущен?` },
      ]);
    } finally {
      setEnrichLoading(false);
    }
  };

  const hydrateSheetSession = useCallback((session) => {
    if (!session) return;
    if (session.layoutAnalysis) setLayoutAnalysis(session.layoutAnalysis);
    setNeedsScenarioChoice(Boolean(session.needsScenarioChoice));
    setNeedsConfirm(Boolean(session.needsConfirm));
    setScenarioCandidates(session.scenarioCandidates || []);
    setTreeSample(session.treeSample || []);
    setPendingQuestions(session.pendingQuestions || []);
    setCurrentQuestion(session.currentQuestion || null);
    setOrchestratorAnswers(session.orchestratorAnswers || {});
    setSelectedScenario(session.selectedScenario || null);
    setScenarioName(session.scenarioName || '');
    setRouteConfidence(session.routeConfidence ?? null);
    setSourceKind(session.sourceKind || '');
    setCurrentRule(session.currentRule || null);
    setSnapshotId(session.snapshotId ?? null);
    setParsePreview(session.parsePreview || null);
    setCompareResult(session.compareResult || null);
    setWarnings(session.warnings || []);
    setValidationReport(session.validationReport || null);
    setValidationDetailsOpen(false);
    setChatMessages(session.chatMessages || []);
    setPreviewPage(1);
  }, []);

  const handleSelectSheet = (sheet) => {
    if (!sheet || sheet === activeSheet) return;

    if (activeSheet) {
      setSheetSessions((prev) => ({
        ...prev,
        [activeSheet]: {
          ...(prev[activeSheet] || {}),
          chatMessages,
          currentRule,
          snapshotId,
          parsePreview,
          compareResult,
          warnings,
          layoutAnalysis,
          selectedScenario,
          scenarioName,
          routeConfidence,
          sourceKind,
          needsScenarioChoice,
          scenarioCandidates,
          treeSample,
          pendingQuestions,
          currentQuestion,
          orchestratorAnswers,
        },
      }));
    }

    setActiveSheet(sheet);
    const cached = sheetSessions[sheet];
    if (cached) {
      hydrateSheetSession(cached);
    }
  };

  const saveRule = async () => {
    if (!ruleJsonText) return alert('Нет правила');
    let rule;
    try {
      rule = JSON.parse(ruleJsonText);
    } catch {
      return alert('JSON некорректен');
    }
    const pid = projectId || '1';
    try {
      const response = await fetch(`${API}/parsing-rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: parseInt(pid, 10),
          source: 'OS',
          rule_json: rule,
          name: rule.meta?.name,
          fixture_file_name: aiFile?.name,
          expected_row_count: parsePreview?.rowCount,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      alert('Сохранено #' + data.id);
    } catch (e) {
      alert(e.message);
    }
  };

  const previewRows = parsePreview?.rows || [];
  const previewHeaders = parsePreview?.headers || [];
  const tableLayoutLabel =
    parsePreview?.tableMeta?.tableLayout === 'uk_osv_wide' ? 'ОСВ 58 wide' : null;
  const totalRows = snapshotId ? parsePreview?.rowCount || 0 : previewRows.length;
  const totalPreviewPages = Math.max(1, Math.ceil(totalRows / previewPageSize));
  const safePreviewPage = Math.min(previewPage, totalPreviewPages);
  const pageRows = snapshotId
    ? previewRows
    : previewRows.slice((safePreviewPage - 1) * previewPageSize, safePreviewPage * previewPageSize);

  const tableTabs = useMemo(() => {
    if (chatTables.length > 0) return chatTables;
    if (parsePreview?.headers?.length) {
      const sheetLabel =
        activeSheet || layoutAnalysis?.sheetName || sheetNames[0] || aiFile?.name || 'Таблица';
      return [
        {
          snapshotId: snapshotId || `draft-${sheetLabel}`,
          label: sheetLabel,
          sheetName: activeSheet || layoutAnalysis?.sheetName || '',
          rowCount: parsePreview.rowCount ?? previewRows.length,
          sourceFileName: aiFile?.name || '',
          isDraft: !snapshotId,
        },
      ];
    }
    return [];
  }, [
    chatTables,
    parsePreview,
    snapshotId,
    activeSheet,
    layoutAnalysis,
    aiFile,
    previewRows.length,
  ]);

  const choiceScenarios = scenarios
    .filter((s) =>
      (scenarioCandidates.length ? scenarioCandidates : ['os_01_hierarchy', 'os_01_flat']).includes(s.id)
    )
    .sort((a, b) => {
      if (!needsScenarioChoice) return 0;
      if (a.id === 'os_01_hierarchy') return -1;
      if (b.id === 'os_01_hierarchy') return 1;
      return 0;
    });

  const pdfKindOptions = useMemo(() => {
    if (!needsScenarioChoice || sourceKind !== 'pdf') return [];
    return (scenarioCandidates || []).map((c) => ({
      id: c.scenarioId,
      label: c.label || c.scenarioId,
      score: c.score,
      confidence: c.confidence,
    }));
  }, [needsScenarioChoice, sourceKind, scenarioCandidates]);

  const pdfKindChoicePending = needsScenarioChoice && sourceKind === 'pdf' && pdfKindOptions.length > 0;
  const pdfDraftPending =
    sourceKind === 'pdf' && !snapshotId && parsePreview?.headers?.length && needsConfirm;
  const formatChatDate = (iso) => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  const searchedRows = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    if (!q) return pageRows;
    return pageRows.filter((row) =>
      Object.values(row).some((v) => String(v ?? '').toLowerCase().includes(q))
    );
  }, [pageRows, tableSearch]);

  const displayScenario =
    scenarioName || scenarios.find((s) => s.id === selectedScenario)?.name || 'Авто';
  const currentChat = useMemo(
    () => chatSessions.find((c) => c.id === chatSessionId),
    [chatSessions, chatSessionId]
  );
  const confidencePct = routeConfidence != null ? Math.round(routeConfidence * 100) : null;
  const pageStart = totalRows ? (safePreviewPage - 1) * previewPageSize + 1 : 0;
  const pageEnd = Math.min(safePreviewPage * previewPageSize, totalRows);

  const renderChatBubble = (role, content, extra = null) => {
    const isUser = role === 'user';
    return (
      <div className={`mv2-chat-row mv2-chat-row--${isUser ? 'user' : 'assistant'}`}>
        <div className={`mv2-avatar mv2-avatar--${isUser ? 'user' : 'martin'}`}>
          {isUser ? '👤' : 'M'}
        </div>
        <div className={`mv2-bubble mv2-bubble--${isUser ? 'user' : 'assistant'}`}>
          <div className="mv2-bubble__name">{isUser ? 'Аудитор' : 'Martin'}</div>
          <div>{formatChatContent(content)}</div>
          {extra}
        </div>
      </div>
    );
  };

  const renderMessage = (m, i) => {
    const traceExtra = m.reasoningTrace ? <ReasoningTrace trace={m.reasoningTrace} /> : null;
    if (m.artifact) {
      return (
        <div key={i}>
          {renderChatBubble(
            'assistant',
            `📊 **${m.artifact.label}** — ${Number(m.artifact.rowCount).toLocaleString('ru-RU')} строк${m.artifact.snapshotId ? ` (#${m.artifact.snapshotId})` : ''}. Таблица слева, вкладки сверху.`,
            traceExtra
          )}
        </div>
      );
    }
    if (m.filterResult) {
      const { kept, total } = m.filterResult;
      return (
        <div key={i}>
          {renderChatBubble(
            'assistant',
            `✓ Фильтр: ${Number(kept).toLocaleString('ru-RU')}${total ? ` из ${Number(total).toLocaleString('ru-RU')}` : ''}`,
            traceExtra
          )}
        </div>
      );
    }
    return (
      <div key={i}>{renderChatBubble(m.role, m.content, traceExtra)}</div>
    );
  };

  const renderPdfKindChoiceCards = () => {
    if (!pdfKindChoicePending) return null;
    return (
      <div className="mv2-pdf-kind-cards">
        <div className="mv2-pdf-kind-cards__title">Какой это PDF?</div>
        <div className="mv2-merge-actions">
          {pdfKindOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className="mv2-merge-action-btn"
              onClick={() => pickPdfKind(opt.id)}
              disabled={aiLoading}
            >
              {opt.label}
              {opt.score != null ? ` · score ${opt.score}` : ''}
              {opt.confidence != null && opt.score == null
                ? ` · ${Math.round(opt.confidence * 100)}%`
                : ''}
            </button>
          ))}
        </div>
      </div>
    );
  };

  const renderMergeStrategyCards = () => {
    if (currentQuestion?.id !== 'pick_merge_strategy') return null;
    const groups = currentQuestion.groups || structureGroups || [];
    return (
      <div className="mv2-merge-groups">
        {groups.map((g, i) => (
          <div key={g.key || i} className="mv2-merge-group-card">
            <div className="mv2-merge-group-card__title">
              Группа {i + 1}: {g.label || g.kind}
            </div>
            <div className="mv2-merge-group-card__meta">
              {g.fileCount || 0} файл(ов)
              {g.sampleNames?.length ? ` · ${g.sampleNames.slice(0, 2).join(', ')}` : ''}
            </div>
            {g.sampleHeaders?.length > 0 && (
              <div className="mv2-merge-group-card__headers">
                {g.sampleHeaders.slice(0, 4).join(' · ')}
              </div>
            )}
          </div>
        ))}
        <div className="mv2-merge-actions">
          {(currentQuestion.options || []).map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="mv2-merge-action-btn"
              onClick={() => answerPendingQuestion('pick_merge_strategy', opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    );
  };

  const startAppendToTable = () => {
    const sid =
      activeTableId && !String(activeTableId).startsWith('draft-')
        ? activeTableId
        : snapshotId && !String(snapshotId).startsWith('draft-')
          ? snapshotId
          : null;
    if (!sid) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Сначала открой таблицу с данными — потом добавим строки.' },
      ]);
      return;
    }
    setAppendTargetSnapshotId(sid);
    setChatMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        content:
          'Режим **дозаписи**: выбери **один файл** в 📎 и напиши задачу (или Enter) — строки добавятся в текущую таблицу.',
      },
    ]);
  };

  const renderQuestionInChat = () => {
    if (aiLoading) return null;

    if (currentQuestion) {
      const optionsHint = currentQuestion.options?.length
        ? `\n\nМожно ответить текстом, например:\n${currentQuestion.options.map((o) => `• ${o.label}`).join('\n')}`
        : '';
      const prompt = String(currentQuestion.promptTemplate || '').trim();
      const lastAssistant = [...chatMessages].reverse().find((m) => m.role === 'assistant' && !m.artifact);
      const alreadyAsked =
        prompt.length > 24 &&
        lastAssistant?.content &&
        normalizeText(lastAssistant.content).includes(normalizeText(prompt).slice(0, 48));
      if (alreadyAsked) {
        if (!optionsHint) return null;
        return renderChatBubble('assistant', `Жду ответ в поле ниже.${optionsHint}`);
      }
      return renderChatBubble('assistant', `${prompt}${optionsHint}`);
    }

    if (needsScenarioChoice && sourceKind === 'pdf' && pdfKindOptions.length) {
      return renderChatBubble(
        'assistant',
        'Не могу однозначно определить тип PDF. Выбери кнопкой ниже или напиши в чате: брокер, депо, УПД.'
      );
    }

    if (needsScenarioChoice && choiceScenarios.length) {
      return renderChatBubble(
        'assistant',
        `Как развернуть файл? Напиши в чате.\n\n${choiceScenarios.map((s) => `• ${s.name}`).join('\n')}`
      );
    }

    return null;
  };

  return (
    <div className="martin-v2">
      <header className="mv2-topbar">
        <div className="mv2-brand">
          <span className="mv2-brand__logo">M</span>
          <span>Martin</span>
          <span className="mv2-brand__sub">by BankFuture</span>
        </div>
        <div className="mv2-topbar__meta">
          <span className="mv2-pill mv2-pill--chat" title="Текущий чат">
            {currentChat?.title || 'Новый чат'}
          </span>
          <span className="mv2-pill mv2-pill--scenario">Сценарий: {displayScenario}</span>
          {tableLayoutLabel && (
            <span className="mv2-pill mv2-pill--layout" title="Многоуровневая шапка как в Excel">
              {tableLayoutLabel}
            </span>
          )}
          {aiLoading ? (
            <span className="mv2-pill mv2-pill--loading" title={loadingHint || 'Работаю'}>
              {loadingHint || 'Работаю…'}
            </span>
          ) : inboxReady ? (
            <span className="mv2-pill mv2-pill--staged">В хранилище · Enter</span>
          ) : (
            parsePreview &&
            snapshotId && <span className="mv2-pill mv2-pill--ready">Ready</span>
          )}
          {confidencePct != null && (
            <span className="mv2-pill mv2-pill--confidence">Confidence: {confidencePct}%</span>
          )}
          {validationReport && (
            <button
              type="button"
              className={`mv2-pill mv2-pill--validation${validationReport.ok ? ' mv2-pill--validation-ok' : ' mv2-pill--validation-fail'}`}
              onClick={() => setValidationDetailsOpen((v) => !v)}
              title={validationReport.summary}
            >
              Валидация: {validationReport.ok ? 'ок' : 'отказ'}
            </button>
          )}
          {sourceKind === 'pdf' && aiFile ? (
            <button
              type="button"
              className="btn-link mv2-pill"
              onClick={() => setPdfColumnEditorOpen(true)}
            >
              Настроить колонки
            </button>
          ) : null}
          {sourceKind === 'pdf' && scenarioResolution ? (
            <PdfScenarioBadge
              scenarioResolution={scenarioResolution}
              onOpenEditor={() => setPdfColumnEditorOpen(true)}
            />
          ) : null}
        </div>
        <div className="mv2-topbar__actions">
          <button type="button" className="mv2-icon-btn" title="История" onClick={() => setHistoryOpen(true)}>
            🕐
          </button>
          <button type="button" className="mv2-icon-btn" title="Новый чат" onClick={createNewChat}>
            +
          </button>
        </div>
      </header>

      {pdfColumnEditorOpen && aiFile && sourceKind === 'pdf' ? (
        <PdfColumnEditor
          file={aiFile}
          meta={{
            projectId: projectId || null,
            sectionId: scenarioResolution?.parseScenario?.signals?.sectionId || null,
            docKind: scenarioResolution?.catalogScenarioId || 'unknown',
            brokerSubtype: layoutAnalysis?.pdfProbe?.brokerSubtype || null,
            scenarioName: scenarioResolution?.parseScenario?.scenarioName || '',
          }}
          onClose={() => setPdfColumnEditorOpen(false)}
          onSaved={() => {
            setPdfColumnEditorOpen(false);
            runInboxParse({
              userMessage: 'разбери pdf',
              nextAnswers: orchestratorAnswers,
              targetSheetName: activeSheet || undefined,
            });
          }}
        />
      ) : null}

      <div className="mv2-body" ref={bodyLayoutRef}>
        <WorkspaceTree
          api={API}
          chatSessionId={chatSessionId}
          refreshKey={inboxRefreshTick}
          uploading={aiLoading && Boolean(uploadProgress)}
          uploadProgress={uploadProgress}
          onUploadPick={handleWorkspaceUpload}
          onInboxChanged={(msg) => {
            setInboxReady(false);
            setInboxUploadCount(0);
            setStagedProbe(null);
            setParseScope(null);
            setInboxStatus(msg || '');
            setInboxRefreshTick((t) => t + 1);
            if (msg) {
              setChatMessages((prev) => [...prev, { role: 'assistant', content: msg }]);
            }
          }}
        />
        <main className="mv2-table-pane">
          {aiLoading && (
            <div className="mv2-progress-strip" aria-hidden>
              <div className="mv2-progress-strip__bar" />
            </div>
          )}
          <div className="mv2-tabs">
            {tableTabs.map((t) => {
              const active =
                activeTableId === t.snapshotId ||
                (!activeTableId && t.isDraft && parsePreview);
              return (
                <button
                  key={t.snapshotId}
                  type="button"
                  className={`mv2-tab${active ? ' mv2-tab--active' : ''}`}
                  onClick={() => switchActiveTable(t.snapshotId)}
                >
                  {active && <span className="mv2-tab__dot" />}
                  {formatTableTab(t)}
                  <span
                    role="button"
                    tabIndex={0}
                    className="mv2-tab__close"
                    title="Убрать"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeTableFromChat(t.snapshotId);
                    }}
                  >
                    ×
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mv2-table-toolbar">
            {inboxStatus && <span className="mv2-inbox-status">{inboxStatus}</span>}
            {appendTargetSnapshotId && (
              <span className="mv2-append-badge" title="Дозапись в открытую таблицу">
                + в таблицу #{appendTargetSnapshotId}
              </span>
            )}
            {pdfDraftPending && (
              <>
                <button
                  type="button"
                  className="mv2-export-btn mv2-export-btn--confirm"
                  onClick={confirmPdfParse}
                  disabled={aiLoading}
                  title="Импортировать черновик в snapshot"
                >
                  Подтвердить парс
                </button>
                <button
                  type="button"
                  className="mv2-export-btn"
                  onClick={() => setPdfColumnEditorOpen(true)}
                  disabled={aiLoading}
                >
                  Настроить колонки
                </button>
              </>
            )}
            {(snapshotId || activeTableId) &&
              !String(snapshotId || activeTableId).startsWith('draft-') && (
                <>
                  <button
                    type="button"
                    className="mv2-export-btn"
                    onClick={() => downloadSnapshotExport('csv')}
                    disabled={aiLoading}
                    title="Скачать CSV"
                  >
                    CSV
                  </button>
                  <button
                    type="button"
                    className="mv2-export-btn"
                    onClick={() => downloadSnapshotExport('xlsx')}
                    disabled={aiLoading}
                    title="Скачать XLSX"
                  >
                    XLSX
                  </button>
                  <button
                    type="button"
                    className="mv2-export-btn mv2-export-btn--reconcile"
                    onClick={openReconcilePanel}
                    disabled={aiLoading || reconcileLoading}
                    title="Сверить таблицы проекта"
                  >
                    Сверить
                  </button>
                  <button
                    type="button"
                    className="mv2-append-btn"
                    onClick={startAppendToTable}
                    disabled={aiLoading}
                    title="Добавить файл в эту таблицу"
                  >
                    + Добавить файл
                  </button>
                </>
              )}
            <label className="mv2-search">
              <span>🔍</span>
              <input
                type="search"
                placeholder="Search in table"
                value={tableSearch}
                onChange={(e) => setTableSearch(e.target.value)}
                disabled={!parsePreview}
              />
            </label>
            {activeFilterCount > 0 && (
              <span className="mv2-filter-badge">Filters ({activeFilterCount})</span>
            )}
          </div>

          {validationReport && validationDetailsOpen && (
            <div className={`mv2-validation-panel${validationReport.ok ? ' mv2-validation-panel--ok' : ' mv2-validation-panel--fail'}`}>
              <div className="mv2-validation-panel__title">
                {validationReport.ok ? 'Валидация пройдена' : 'Валидация не пройдена'}
              </div>
              <p className="mv2-validation-panel__summary">{validationReport.summary}</p>
              <ul className="mv2-validation-panel__checks">
                {(validationReport.checks || []).map((c) => (
                  <li key={c.id} className={`mv2-validation-check mv2-validation-check--${c.status}`}>
                    <strong>{c.title}</strong>
                    <span className="mv2-validation-check__status">{c.status}</span>
                    {c.status !== 'pass' && (
                      <span className="mv2-validation-check__detail">
                        ожидалось: {c.expected}
                        {c.actual ? ` · получено: ${c.actual}` : ''}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {reconcilePanelOpen && (
            <div className="mv2-reconcile-panel">
              <div className="mv2-reconcile-panel__title">Сверка таблиц</div>
              <div className="mv2-reconcile-panel__row">
                <label>
                  Слева
                  <select
                    value={reconcileLeftRef}
                    onChange={(e) => setReconcileLeftRef(e.target.value)}
                    disabled={reconcileLoading}
                  >
                    <option value="">— выбери —</option>
                    {(reconcileCatalog || []).map((s) => (
                      <option key={s.ref} value={s.ref}>
                        {s.label}
                        {s.needsParse ? ' (inbox)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Справа
                  <select
                    value={reconcileRightRef}
                    onChange={(e) => setReconcileRightRef(e.target.value)}
                    disabled={reconcileLoading}
                  >
                    <option value="">— выбери —</option>
                    {(reconcileCatalog || []).map((s) => (
                      <option key={s.ref} value={s.ref}>
                        {s.label}
                        {s.needsParse ? ' (inbox)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="mv2-reconcile-panel__actions">
                <button
                  type="button"
                  className="mv2-export-btn"
                  disabled={reconcileLoading || !reconcileLeftRef || !reconcileRightRef}
                  onClick={async () => {
                    const left = reconcileCatalog.find((s) => s.ref === reconcileLeftRef);
                    const right = reconcileCatalog.find((s) => s.ref === reconcileRightRef);
                    if (!left || !right) return;
                    setReconcileLoading(true);
                    try {
                      const msg = `сверь ${left.label} с ${right.label}`;
                      const data = await fetchReconcilePlan(msg);
                      setReconcilePlan(data.plan);
                    } catch (e) {
                      setChatMessages((prev) => [
                        ...prev,
                        { role: 'assistant', content: `План сверки: ${e.message}` },
                      ]);
                    } finally {
                      setReconcileLoading(false);
                    }
                  }}
                >
                  Составить план
                </button>
                <button
                  type="button"
                  className="mv2-export-btn mv2-export-btn--reconcile"
                  disabled={reconcileLoading || !reconcilePlan}
                  onClick={() => runReconcileExecute(reconcilePlan)}
                >
                  Запустить
                </button>
                <button
                  type="button"
                  className="mv2-export-btn"
                  onClick={() => {
                    setReconcilePanelOpen(false);
                    setReconcilePlan(null);
                  }}
                >
                  Закрыть
                </button>
              </div>
              {reconcilePlan && (
                <div className="mv2-reconcile-panel__plan">
                  <div>
                    <strong>{reconcilePlan.left?.label || reconcilePlan.left?.ref}</strong>
                    {' ↔ '}
                    <strong>{reconcilePlan.right?.label || reconcilePlan.right?.ref}</strong>
                  </div>
                  <div>
                    Ключи: {(reconcilePlan.leftKeys || []).join(', ') || '—'} /{' '}
                    {(reconcilePlan.rightKeys || []).join(', ') || '—'}
                  </div>
                  <div>
                    Колонки:{' '}
                    {(reconcilePlan.valuePairs || [])
                      .map((p) => `${p.left}↔${p.right}`)
                      .join(', ') || 'пересечение заголовков'}
                  </div>
                </div>
              )}
            </div>
          )}

          <div ref={tableScrollRef} className="mv2-table-area table-container">
            {pdfKindChoicePending && (
              <div className="mv2-empty">
                <span className="mv2-empty__icon">📄</span>
                <p>Сначала выбери тип PDF в чате справа — таблицу покажу после разбора.</p>
              </div>
            )}
            {!parsePreview && !pdfKindChoicePending && (
              <div className="mv2-empty">
                <span className="mv2-empty__icon">📊</span>
                <p>
                  {inboxReady
                    ? `В хранилище ${inboxUploadCount} файл(ов) — выбери что парсить в чате`
                    : 'Прикрепи файл в чате — сначала уйдёт в хранилище на сервере'}
                </p>
              </div>
            )}
            {parsePreview && !pdfKindChoicePending && (
              <>
                {rowsLoading && <p className="hint" style={{ padding: '0.5rem' }}>Загружаю страницу…</p>}
                <ExcelGridTable
                  headers={previewHeaders}
                  rows={searchedRows}
                  tableMeta={parsePreview?.tableMeta}
                  highlightHeaders={highlightHeaders}
                  rowOffset={(safePreviewPage - 1) * previewPageSize}
                />
              </>
            )}
          </div>

          {parsePreview && (
            <footer className="mv2-pager">
              <span>
                {pageStart}–{pageEnd} of {Number(totalRows).toLocaleString('ru-RU')} rows
              </span>
              <div className="mv2-pager__nav">
                <button
                  type="button"
                  className="mv2-pager__btn"
                  disabled={safePreviewPage <= 1}
                  onClick={() => setPreviewPage((p) => p - 1)}
                >
                  ←
                </button>
                <span>
                  {safePreviewPage} / {totalPreviewPages}
                </span>
                <button
                  type="button"
                  className="mv2-pager__btn"
                  disabled={safePreviewPage >= totalPreviewPages}
                  onClick={() => setPreviewPage((p) => p + 1)}
                >
                  →
                </button>
              </div>
            </footer>
          )}
        </main>

        <div
          className={`mv2-resizer${resizing ? ' mv2-resizer--active' : ''}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Ширина чата"
          title="Потяни — изменить ширину таблицы и чата"
          onMouseDown={(e) => {
            e.preventDefault();
            setResizing(true);
            document.body.classList.add('mv2-resizing');
          }}
        />

        <aside
          className="mv2-chat"
          aria-label="Чат с Martin"
          style={{ width: chatWidth }}
        >
          <div className="mv2-chat__thread">
            {chatMessages.length === 0 && !aiLoading && !currentQuestion && (
              renderChatBubble(
                'assistant',
                'Привет! **Слева** — заливка в Хранилище. **📎** — выбери папку или файл. **Напиши задачу** в чате (правила, сценарий) — потом Enter.'
              )
            )}
            {chatMessages.map((m, i) => renderMessage(m, i))}
            {renderQuestionInChat()}
            {renderMergeStrategyCards()}
            {renderPdfKindChoiceCards()}
            {aiLoading && <MartinLoader hint={loadingHint || 'Думаю…'} />}
          </div>

          <div className="mv2-chat__footer">
            {parseScope?.path && (
              <div className="mv2-staging">
                <span className="mv2-staging__chip" title="Выбрано для парса">
                  {parseScope.type === 'file' ? '📄' : '📁'} {parseScope.path}
                </span>
                {!aiLoading && (
                  <span className="mv2-staging__hint">задача + Enter</span>
                )}
                <button
                  type="button"
                  className="mv2-staging__clear"
                  onClick={() => setParseScope(null)}
                  title="Сбросить выбор"
                >
                  ×
                </button>
              </div>
            )}

            <div className="mv2-input-box">
              <textarea
                rows={2}
                placeholder={
                  currentQuestion
                    ? 'Ответь Martin в чате…'
                    : parsePreview
                      ? 'Спроси про таблицу, фильтр, или напиши что угодно…'
                      : inboxReady
                        ? parseScope?.path
                          ? 'разбери ОС, брокер 1F018, депо…'
                          : '📎 — выбери что парсить, потом напиши задачу'
                        : 'Загрузи файлы слева в Хранилище…'
                }
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendChat();
                  }
                }}
              />
              <div className="mv2-input-toolbar">
                <div className="mv2-input-toolbar__left" ref={attachMenuRef}>
                  <button
                    type="button"
                    className={`mv2-clip-btn${parseScope?.path ? ' mv2-clip-btn--active' : ''}`}
                    title="Выбрать что парсить из хранилища"
                    disabled={aiLoading}
                    onClick={() => setAttachOpen((v) => !v)}
                  >
                    📎
                  </button>
                  {attachOpen && (
                    <InboxPicker
                      api={API}
                      chatSessionId={chatSessionId}
                      refreshKey={inboxRefreshTick}
                      parseScope={parseScope}
                      onParseScopeChange={setParseScope}
                      onParseSelected={() => runParseFromScope()}
                      disabled={aiLoading}
                      variant="attach"
                      onClose={() => setAttachOpen(false)}
                    />
                  )}
                </div>
                <button
                  type="button"
                  className="mv2-send-round"
                  title="Отправить"
                  onClick={() => sendChat()}
                  disabled={
                    aiLoading ||
                    (!inputText.trim() &&
                      !parseScope?.path &&
                      !inboxReady &&
                      !parsePreview &&
                      !currentQuestion &&
                      !needsScenarioChoice)
                  }
                >
                  ↑
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {historyOpen && (
        <div className="mv2-history-overlay" onClick={() => setHistoryOpen(false)}>
          <aside className="mv2-history-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="mv2-history-drawer__head">
              <strong>История</strong>
              <button type="button" className="mv2-icon-btn" onClick={() => setHistoryOpen(false)}>×</button>
            </div>
            <div style={{ padding: '0.5rem 1rem', display: 'flex', gap: '0.35rem' }}>
              <button type="button" className="btn secondary" onClick={createNewChat}>+ Новый</button>
              <button type="button" className="btn secondary" onClick={purgeAllChats}>Очистить все</button>
            </div>
            <div className="mv2-history-drawer__list">
              {chatSessions.map((c) => (
                <div key={c.id} className={`anton-sessions__item-wrap${chatSessionId === c.id ? ' anton-sessions__item-wrap--active' : ''}`}>
                  <button type="button" className="anton-sessions__item" onClick={() => { switchChat(c.id); setHistoryOpen(false); }}>
                    <span className="anton-sessions__item-title">{c.title || 'Новый чат'}</span>
                    <span className="anton-sessions__item-meta">{formatChatDate(c.updatedAt || c.createdAt)}</span>
                  </button>
                  <button type="button" className="anton-sessions__item-delete" onClick={(e) => deleteChat(c.id, e)}>×</button>
                </div>
              ))}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
