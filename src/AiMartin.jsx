import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import './martin-v2.css';

const API = 'http://localhost:3001/api';
const CLASSIFY_ROW_LIMIT = 120;
const SNAPSHOT_PAGE_SIZE = 200;
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
  if (t.sheetName) {
    const count =
      t.rowCount != null ? ` (${Number(t.rowCount).toLocaleString('ru-RU')})` : '';
    return `${t.sheetName}${count}`;
  }
  const label = String(t.label || t.sourceFileName || '').trim();
  let title = label.replace(/\.(xlsx|xls|xlsm|pdf|txt|csv)$/i, '').slice(0, 28);
  if (/ · \d/.test(label)) {
    title = label.slice(0, 36);
  } else if (/1f018|брокер/i.test(label)) title = 'Брокер';
  else if (/депо|depo|pdf/i.test(label) && !/58/i.test(label)) title = 'Депо';
  else if (/58\.?1|ук|uk|карт/i.test(label)) title = 'УК 58.01';
  const count =
    t.rowCount != null ? ` (${Number(t.rowCount).toLocaleString('ru-RU')})` : '';
  return `${title || `Таблица #${t.snapshotId}`}${count}`;
}

export default function AiMartin() {
  const [workMode, setWorkMode] = useState('source');
  const [sheetNames, setSheetNames] = useState([]);
  const [activeSheet, setActiveSheet] = useState('');
  const [sheetSessions, setSheetSessions] = useState({});
  const [chatMessages, setChatMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [aiFile, setAiFile] = useState(null);
  const [stagedFiles, setStagedFiles] = useState([]);
  const [stagedProbe, setStagedProbe] = useState(null);
  const [targetFile, setTargetFile] = useState(null);
  const [currentRule, setCurrentRule] = useState(null);
  const [parsePreview, setParsePreview] = useState(null);
  const [snapshotId, setSnapshotId] = useState(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [warnings, setWarnings] = useState([]);
  const [ruleDiff, setRuleDiff] = useState(null);
  const [layoutAnalysis, setLayoutAnalysis] = useState(null);
  const [compareResult, setCompareResult] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [loadingHint, setLoadingHint] = useState('');
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [ruleJsonText, setRuleJsonText] = useState('');
  const [previewPage, setPreviewPage] = useState(1);
  const [scenarios, setScenarios] = useState([]);
  const [selectedScenario, setSelectedScenario] = useState(null);
  const [scenarioName, setScenarioName] = useState('');
  const [routeConfidence, setRouteConfidence] = useState(null);
  const [sourceKind, setSourceKind] = useState('');
  const [needsScenarioChoice, setNeedsScenarioChoice] = useState(false);
  const [scenarioCandidates, setScenarioCandidates] = useState([]);
  const [treeSample, setTreeSample] = useState([]);
  const [pendingQuestions, setPendingQuestions] = useState([]);
  const [currentQuestion, setCurrentQuestion] = useState(null);
  const [orchestratorAnswers, setOrchestratorAnswers] = useState({});
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
  const chatFileInputRef = useRef(null);
  const chatFolderInputRef = useRef(null);
  const chatTargetInputRef = useRef(null);
  const attachMenuRef = useRef(null);
  const bodyLayoutRef = useRef(null);
  const chatWidthRef = useRef(readInitialChatWidth());
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
    fetch(`${API}/projects`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data) && data.length) setProjectId(String(data[0].id));
      })
      .catch(() => {});
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
      setParsePreview((prev) => ({
        headers: data.headers || prev?.headers || [],
        rows,
        rowCount: data.total ?? prev?.rowCount ?? rows.length,
      }));
      if (options.highlightCols?.length) {
        setHighlightHeaders(options.highlightCols);
        requestAnimationFrame(() => {
          const el = tableScrollRef.current;
          if (el) el.scrollLeft = el.scrollWidth;
        });
      }
      return data;
    } finally {
      setRowsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!snapshotId) return;
    reloadSnapshotPage(snapshotId, previewPage);
  }, [snapshotId, previewPage, reloadSnapshotPage]);

  const refreshChatSessions = useCallback(async (pid) => {
    if (!pid) return [];
    const response = await fetch(`${API}/projects/${pid}/chats`);
    const data = await response.json();
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
    setChatTables(data.snapshots || []);
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

  const ensureChatSession = useCallback(async () => {
    if (!projectId) return null;
    let list = chatSessions;
    if (!list.length) {
      list = await refreshChatSessions(projectId);
    }
    if (list.length) {
      const first = list[0];
      if (chatSessionId !== first.id) {
        await loadChatSession(first.id);
      }
      return first.id;
    }
    const response = await fetch(`${API}/projects/${projectId}/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Новый чат' }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'create chat failed');
    await refreshChatSessions(projectId);
    setChatSessionId(data.chat.id);
    setChatTables([]);
    setChatMessages([]);
    setActiveTableId(null);
    setSnapshotId(null);
    setParsePreview(null);
    return data.chat.id;
  }, [projectId, chatSessions, chatSessionId, refreshChatSessions, loadChatSession]);

  useEffect(() => {
    if (!projectId) return;
    ensureChatSession().catch(() => {});
  }, [projectId]);

  const deleteChat = async (id, e) => {
    e?.stopPropagation?.();
    if (!id) return;
    if (!confirm('Удалить этот чат?')) return;
    const response = await fetch(`${API}/chats/${id}`, { method: 'DELETE' });
    if (!response.ok) return;
    const list = await refreshChatSessions(projectId);
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
      }
    }
  };

  const purgeAllChats = async () => {
    if (!projectId) return;
    if (!confirm('Удалить все чаты проекта? Таблицы в чатах останутся в БД, но привязки пропадут.')) return;
    const response = await fetch(`${API}/projects/${projectId}/chats`, { method: 'DELETE' });
    if (!response.ok) return;
    setChatSessionId(null);
    setChatMessages([]);
    setChatTables([]);
    setActiveTableId(null);
    setSnapshotId(null);
    setParsePreview(null);
    resetSessionForNewFile();
    await refreshChatSessions(projectId);
    await createNewChat();
  };

  const createNewChat = async () => {
    if (!projectId) return;
    const response = await fetch(`${API}/projects/${projectId}/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Новый чат' }),
    });
    const data = await response.json();
    if (!response.ok) return;
    resetSessionForNewFile();
    setChatMessages([]);
    setChatTables([]);
    setActiveTableId(null);
    setChatSessionId(data.chat.id);
    await refreshChatSessions(projectId);
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
    await refreshChatSessions(projectId);
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
              sourceFileName: label,
              rowCount: parsePreview?.rowCount,
            },
          ];
        });
        setActiveTableId(sid);
        await refreshChatSessions(projectId);
      }
    },
    [chatSessionId, parsePreview, projectId, refreshChatSessions]
  );

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
    setPreviewPage(1);

    if (data.multiSheet && Array.isArray(data.snapshots)) {
      setCurrentQuestion(null);
      setPendingQuestions([]);
      setNeedsScenarioChoice(false);
      setWorkMode('result');
      if (data.sheetNames?.length) setSheetNames(data.sheetNames);
      if (data.snapshots[0]?.sheetName) setActiveSheet(data.snapshots[0].sheetName);
      setChatTables(mapSnapshotsToTables(data.snapshots, aiFile?.name || ''));
      if (chatSessionId) refreshChatSessions(projectId);
      return;
    }

    if (data.parsePreview?.headers?.length) {
      const sheetLabel =
        effectiveSheet ||
        data.layoutAnalysis?.sheetName ||
        incomingSheetNames[0] ||
        aiFile?.name ||
        'лист';
      const draftTab = {
        snapshotId: data.snapshotId || `draft-${sheetLabel}`,
        label: [sheetLabel, data.parsePreview.rowCount].filter((x) => x != null && x !== '').join(' · '),
        sheetName: sheetLabel,
        rowCount: data.parsePreview.rowCount,
        sourceFileName: aiFile?.name || '',
        isDraft: !data.snapshotId,
      };
      setChatTables((prev) => {
        if (data.snapshotId && prev.some((t) => t.snapshotId === data.snapshotId)) return prev;
        if (!data.snapshotId && prev.some((t) => t.isDraft)) return [draftTab];
        if (prev.length > 0 && data.multiSheet) return prev;
        if (prev.length > 0 && !data.snapshotId) return prev;
        return [draftTab];
      });
    }

    if (data.snapshotId && chatSessionId) {
      const label = [aiFile?.name, effectiveSheet].filter(Boolean).join(' · ');
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
        },
      }));
    }
  };

  const buildStagingMessage = (probe) => {
    if (!probe) return 'Файлы прикреплены. Напиши задачу или нажми **Отправить**.';
    const parts = [`Прикреплено **${probe.fileCount || 0}** файл(ов). Парс **не запущен**.`];
    if (probe.suggestedScenario) {
      parts.push(`Похоже на сценарий: **${probe.suggestedScenario}**.`);
    }
    if (probe.byKind?.pdf) parts.push(`PDF: ${probe.byKind.pdf}.`);
    if (probe.prefixMatches != null && probe.prefix) {
      parts.push(`С префиксом \`${probe.prefix}\`: **${probe.prefixMatches}**.`);
    }
    if (probe.sampleNames?.length) {
      parts.push(`Примеры: ${probe.sampleNames.slice(0, 3).join(', ')}.`);
    }
    parts.push('Напиши задачу («депо», «брокер 1F018», «плоско»…) или **Отправить** с пустым полем.');
    return parts.join('\n');
  };

  const probeStaged = async (files) => {
    if (!files?.length) return null;
    if (files.length === 1 && files[0].size < 8_000_000) {
      const formData = new FormData();
      formData.append('file', files[0]);
      const response = await fetch(`${API}/parse/probe`, { method: 'POST', body: formData });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'probe failed');
      return data.probe;
    }
    const response = await fetch(`${API}/parse/probe-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: files.map((f) => ({
          name: f.name,
          relativePath: f.webkitRelativePath || f.name,
        })),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'probe-meta failed');
    return data.probe;
  };

  const fetchBatchStart = async (files, target, opts = {}) => {
    const {
      userMessage = '',
      scenarioId,
      nextAnswers,
      targetSheetName,
      filePrefix,
      parseAllSheets,
      knownSheetNames,
      chatSessionId: chatSessionIdOverride,
    } = opts;
    const sheetCount = knownSheetNames?.length ?? sheetNames.length;
    const multiSheetMode =
      parseAllSheets === true ||
      parseAllSheets === '1' ||
      (parseAllSheets !== false &&
        files?.length === 1 &&
        sheetCount > 1 &&
        !nextAnswers?.sheetName &&
        !targetSheetName);
    const formData = new FormData();
    for (const f of files) formData.append('files', f);
    if (target) formData.append('target', target);
    if (projectId) formData.append('project_id', String(projectId));
    const sid = chatSessionIdOverride || chatSessionId;
    if (sid) formData.append('chatSessionId', String(sid));
    if (multiSheetMode) {
      formData.append('parseAllSheets', '1');
    } else if (targetSheetName) {
      formData.append('sheetName', targetSheetName);
    }
    if (scenarioId) formData.append('scenarioId', scenarioId);
    if (filePrefix) formData.append('filePrefix', filePrefix);
    if (nextAnswers) formData.append('orchestratorAnswers', JSON.stringify(nextAnswers));
    formData.append('userMessage', userMessage);
    const response = await fetch(`${API}/parse/batch-start`, { method: 'POST', body: formData });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'batch-start failed');
    return data;
  };

  const runBatchStart = async (files, target, opts = {}) => {
    if (!files?.length) return null;
    setAiLoading(true);
    const bigHint =
      files.some((f) => f.size > 2_000_000) || files.length > 5
        ? 'Много файлов или большой объём — подожди, не закрывай вкладку.'
        : null;
    setLoadingHint(bigHint || 'Разбираю файлы…');
    try {
      const sessionId = opts.chatSessionId || chatSessionId || (await ensureChatSession());
      let data = await fetchBatchStart(files, target, { ...opts, chatSessionId: sessionId });
      const knownSheets = opts.knownSheetNames?.length ?? sheetNames.length;
      if (knownSheets > 1 && data.previewIsTentative && !data.multiSheet) {
        data = await fetchBatchStart(files, target, {
          ...opts,
          chatSessionId: sessionId,
          parseAllSheets: true,
          knownSheetNames: opts.knownSheetNames || sheetNames,
          nextAnswers: undefined,
          targetSheetName: undefined,
        });
      }
      applySessionData(data, opts.targetSheetName);
      setStagedFiles([]);
      setStagedProbe(null);
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: data.assistantMessage || 'Готово.',
          artifact: data.multiSheet
            ? null
            : data.snapshotId
              ? {
                  snapshotId: data.snapshotId,
                  label: files[0]?.name || 'Таблица',
                  rowCount: data.parsePreview?.rowCount ?? 0,
                }
              : null,
        },
      ]);
      if (data.multiSheet && Array.isArray(data.snapshots)) {
        setChatTables(mapSnapshotsToTables(data.snapshots, files[0]?.name || ''));
        if (sessionId) {
          const loaded = await fetch(`${API}/chats/${sessionId}`);
          const chatData = await loaded.json();
          if (loaded.ok && chatData.snapshots?.length) {
            setChatTables(chatData.snapshots);
          }
          await refreshChatSessions(projectId);
        }
      } else if (data.snapshotId && sessionId) {
        const loaded = await fetch(`${API}/chats/${sessionId}`);
        const chatData = await loaded.json();
        if (loaded.ok) setChatTables(chatData.snapshots || []);
        await refreshChatSessions(projectId);
      }
      setActiveFilterCount(0);
      setWorkMode('result');
      setPreviewPage(1);
      return data;
    } catch (e) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Не смогла разобрать: ${e.message}` },
      ]);
      return null;
    } finally {
      setAiLoading(false);
      setLoadingHint('');
    }
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
    setLoadingHint(
      bigHint || 'Читаю файл, строю превью… (Excel может занять до минуты)'
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
        await refreshChatSessions(projectId);
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
    const files = stagedFiles.length ? stagedFiles : aiFile ? [aiFile] : [];
    if (!files.length) return;
    setNeedsScenarioChoice(false);
    startParseFromStaged(SCENARIO_PHRASES[scenarioId] || '', scenarioId);
  };

  const startParseFromStaged = async (userMessage, scenarioIdOverride) => {
    const files = stagedFiles.length ? stagedFiles : aiFile ? [aiFile] : [];
    if (!files.length) return;
    await runBatchStart(files, targetFile, {
      userMessage: userMessage || '',
      scenarioId: scenarioIdOverride,
      nextAnswers: orchestratorAnswers,
      targetSheetName: activeSheet || undefined,
    });
  };

  const resetSessionForNewFile = () => {
    setStagedProbe(null);
    setParsePreview(null);
    setSnapshotId(null);
    setCompareResult(null);
    setCurrentRule(null);
    setLayoutAnalysis(null);
    setNeedsScenarioChoice(false);
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

  const fetchSheetNames = async (source) => {
    const formData = new FormData();
    formData.append('file', source);
    const response = await fetch(`${API}/parse/sheet-names`, { method: 'POST', body: formData });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'sheet-names failed');
    return data;
  };

  const handleFilesPick = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setAttachOpen(false);
    if (files[0]?.webkitRelativePath) {
      await handleFolderPick(fileList);
      return;
    }
    if (files.length === 1) {
      await handleSourceFilePick(files[0]);
      return;
    }
    resetSessionForNewFile();
    setAiFile(files[0]);
    setStagedFiles(files);
    setWorkMode('parse');
    if (!chatSessionId) await ensureChatSession();
    setChatMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        content: `Прикрепила **${files.length}** файлов. Напиши задачу в чате — разберу пакетом.`,
      },
    ]);
  };

  const handleSourceFilePick = async (f) => {
    if (!f) {
      setAiFile(null);
      setStagedFiles([]);
      return;
    }
    setAttachOpen(false);
    resetSessionForNewFile();
    setAiFile(f);
    setStagedFiles([f]);
    setWorkMode('parse');
    setChatMessages([]);
    setCurrentQuestion(null);
    setPendingQuestions([]);

    if (projectId) {
      try {
        const response = await fetch(`${API}/projects/${projectId}/chats`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: f.name || 'Новый чат' }),
        });
        const data = await response.json();
        if (response.ok) {
          setChatSessionId(data.chat.id);
          setChatTables([]);
          await refreshChatSessions(projectId);
        }
      } catch {
        if (!chatSessionId) await ensureChatSession();
      }
    } else if (!chatSessionId) {
      await ensureChatSession();
    }

    let sheetToParse = undefined;
    let meta = null;
    try {
      meta = await fetchSheetNames(f);
      if (meta.sheetNames?.length) {
        setSheetNames(meta.sheetNames);
        sheetToParse = meta.defaultSheet || meta.sheetNames[0];
        setActiveSheet(sheetToParse);
      }
    } catch {
      /* probe / batch-start подхватят */
    }

    const sheetCount = meta?.sheetNames?.length ?? 0;
    if (sheetCount > 1) {
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `В файле **${sheetCount}** листа — разбираю все и покажу вкладками…`,
        },
      ]);
    } else {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Разбираю **${f.name}**…` },
      ]);
    }
    await runBatchStart([f], null, {
      userMessage: '',
      parseAllSheets: sheetCount > 1,
      knownSheetNames: meta?.sheetNames,
    });
  };

  const handleFolderPick = async (fileList) => {
    const all = Array.from(fileList || []);
    const relevant = all.filter((f) => /\.(pdf|xlsx|xls|xlsm|txt|csv|tsv)$/i.test(f.name));
    if (!relevant.length) {
      alert('В папке нет PDF или Excel.');
      return;
    }
    resetSessionForNewFile();
    setStagedFiles(relevant);
    setAiFile(relevant[0]);
    setWorkMode('parse');
    if (!chatSessionId) await ensureChatSession();
    setSheetNames([]);
    setActiveSheet('');

    try {
      const probe = await probeStaged(relevant);
      setStagedProbe(probe);
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: buildStagingMessage(probe) },
      ]);
    } catch (e) {
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Папка: **${relevant.length}** файлов. Напиши задачу («депо», «брокер»…).\n(${e.message})`,
        },
      ]);
    }
  };

  const handleTargetFilePick = (t) => {
    setTargetFile(t);
    if (t && stagedFiles.length && parsePreview) {
      runBatchStart(stagedFiles, t, {
        userMessage: '',
        targetSheetName: activeSheet || undefined,
        nextAnswers: orchestratorAnswers,
      });
    }
  };

  const answerPendingQuestion = (questionId, value) => {
    const files = stagedFiles.length ? stagedFiles : aiFile ? [aiFile] : [];
    if (!files.length) return;
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

    setOrchestratorAnswers(next);

    if (questionId === 'pick_tree_flatten' && sheetNames.length > 1) {
      runBatchStart(files, targetFile, {
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
    runBatchStart(files, targetFile, {
      userMessage: '',
      scenarioId: next.scenarioId || null,
      nextAnswers: next,
      targetSheetName: sheetForParse,
    });
  };

  const sendChat = async (overrideText, scenarioId) => {
    const text = (overrideText ?? inputText).trim();
    const hasFiles = stagedFiles.length > 0 || aiFile;

    if (text && currentQuestion) {
      const resolved = resolveQuestionAnswerFromText(text, currentQuestion);
      if (resolved != null) {
        setChatMessages((prev) => [...prev, { role: 'user', content: text }]);
        setInputText('');
        answerPendingQuestion(currentQuestion.id, resolved);
        return;
      }
      if (hasFiles) {
        setChatMessages((prev) => [...prev, { role: 'user', content: text }]);
        setInputText('');
        await runBatchStart(stagedFiles.length ? stagedFiles : [aiFile], targetFile, {
          userMessage: text,
          scenarioId: orchestratorAnswers?.scenarioId,
          nextAnswers: orchestratorAnswers,
          targetSheetName: activeSheet || undefined,
        });
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

    const tableCommandIntent =
      /(вытащи|извлек|перенес|убер|удал|очист)/i.test(text) &&
      /(колонк|инвентар|номер|дат)/i.test(text);
    const filterLike =
      /фильтр|оставь\s+(?:только|строк)|только\s+(?:строк|если|где|по)|убери\s+строк|удали\s+строк|исключи\s+строк/i.test(
        text
      ) ||
      /(?:а|и)\s+ещ[её]|только\s+по\s+/i.test(text) ||
      /\bname\s*=/i.test(text) ||
      /debit[_\s]?account\s*=/i.test(text) ||
      /credit[_\s]?account\s*=/i.test(text);
    const classifyLike =
      /(проанализ|классиф|определи|подумай|отправь\s+на\s+анализ|аренд|ремонт|движим|недвижим|имуществ)/i.test(text) &&
      !tableCommandIntent &&
      !filterLike;
    const effectiveResultMode =
      workMode === 'result' || tableCommandIntent || classifyLike || filterLike;

    if (!parsePreview && !effectiveResultMode) {
      if (!hasFiles) {
        alert('Сначала прикрепи файл, PDF или папку.');
        return;
      }
      const files = stagedFiles.length ? stagedFiles : [aiFile];
      if (text) {
        setChatMessages((prev) => [...prev, { role: 'user', content: text }]);
        setInputText('');
      }
      await runBatchStart(files, targetFile, {
        userMessage: text || SCENARIO_PHRASES[scenarioId] || '',
        scenarioId: scenarioId || orchestratorAnswers?.scenarioId,
        nextAnswers: orchestratorAnswers,
        targetSheetName: activeSheet || undefined,
      });
      return;
    }

    if (!text && !scenarioId) return;
    if (!hasFiles) {
      alert('Сначала прикрепи исходник Excel.');
      return;
    }

    if (effectiveResultMode && text) {
      setWorkMode('result');
      setChatMessages((prev) => [...prev, { role: 'user', content: text }]);
      setInputText('');

      let previewForAction = parsePreview;
      if (!previewForAction?.headers?.length) {
        setAiLoading(true);
        try {
          const boot = await fetchBatchStart(
            stagedFiles.length ? stagedFiles : [aiFile],
            targetFile,
            {
              userMessage: '',
              scenarioId: orchestratorAnswers?.scenarioId || 'os_01_hierarchy',
              nextAnswers: orchestratorAnswers,
              targetSheetName: activeSheet || undefined,
            }
          );
          applySessionData(boot, activeSheet || undefined);
          previewForAction = boot.parsePreview || null;
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
        const actionData = await runResultTableAction(text, previewForAction, [
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

      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content:
            'Режим результата. Примеры:\n' +
            '• «Вытащи инвентарный номер и дату из колонки ОС»\n' +
            '• «Убери из колонки ОС номер и дату» (очистить текст ячейки)\n' +
            '• «удали колонку Группа» (убрать всю колонку)',
        },
      ]);
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
    const sid = snapshotId;
    const recentMessages = (chatContext || chatMessages)
      .filter((m) => m?.role === 'user' || m?.role === 'assistant')
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }));
    if (sid) {
      const response = await fetch(`${API}/parse/snapshots/${sid}/apply-operation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          logChat: true,
          chatSessionId: chatSessionId || undefined,
          messages: recentMessages,
          options: {
            threshold: Number(enrichThreshold) || 0.7,
            auditorRule: enrichAuditorRule,
            maxUnique: 80,
          },
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `apply-operation ${response.status}`);
      if (data.handled && data.headers) {
        setParsePreview((prev) => ({
          ...(prev || {}),
          headers: data.headers,
          rowCount: prev?.rowCount,
        }));
        await reloadSnapshotPage(sid, previewPage, {
          highlightCols: data.newColumns || [],
        });
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
        message,
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
    if (m.artifact) {
      return (
        <div key={i}>
          {renderChatBubble(
            'assistant',
            `📊 **${m.artifact.label}** — ${Number(m.artifact.rowCount).toLocaleString('ru-RU')} строк${m.artifact.snapshotId ? ` (#${m.artifact.snapshotId})` : ''}. Таблица слева, вкладки сверху.`
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
            `✓ Фильтр: ${Number(kept).toLocaleString('ru-RU')}${total ? ` из ${Number(total).toLocaleString('ru-RU')}` : ''}`
          )}
        </div>
      );
    }
    return <div key={i}>{renderChatBubble(m.role, m.content)}</div>;
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
          <span className="mv2-pill mv2-pill--scenario">Сценарий: {displayScenario}</span>
          {parsePreview && snapshotId && (
            <span className="mv2-pill mv2-pill--ready">Ready</span>
          )}
          {confidencePct != null && (
            <span className="mv2-pill mv2-pill--confidence">Confidence: {confidencePct}%</span>
          )}
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

      <div className="mv2-body" ref={bodyLayoutRef}>
        <main className="mv2-table-pane">
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

          <div ref={tableScrollRef} className="mv2-table-area table-container">
            {!parsePreview && (
              <div className="mv2-empty">
                <span className="mv2-empty__icon">📊</span>
                <p>
                  {stagedFiles.length
                    ? 'Файл прикреплён — напиши задачу в чате и нажми Отправить'
                    : 'Прикрепи файл в чате — таблица появится здесь'}
                </p>
              </div>
            )}
            {parsePreview && (
              <>
                {rowsLoading && <p className="hint" style={{ padding: '0.5rem' }}>Загружаю страницу…</p>}
                <table className="data-table">
                  <thead>
                    <tr>
                      {previewHeaders.map((h) => (
                        <th key={h} className={highlightHeaders.includes(h) ? 'col-new' : undefined}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {searchedRows.map((row, ri) => (
                      <tr key={ri}>
                        {previewHeaders.map((h) => (
                          <td key={h} className={highlightHeaders.includes(h) ? 'col-new' : undefined}>
                            {row[h] ?? ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
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
                'Привет! Прикрепи скрепкой Excel, PDF или папку — разберу и выложу таблицы слева. Дальше всё через чат: фильтр, колонки, классификация.'
              )
            )}
            {chatMessages.map((m, i) => renderMessage(m, i))}
            {renderQuestionInChat()}
            {aiLoading && (
              <div className="mv2-typing">
                <div className="mv2-avatar mv2-avatar--martin">M</div>
                <span>{loadingHint || 'Думаю…'}</span>
              </div>
            )}
          </div>

          <div className="mv2-chat__footer">
            {(stagedFiles.length > 0 || aiFile) && (
              <div className="mv2-staging">
                {(stagedFiles.length ? stagedFiles : aiFile ? [aiFile] : []).slice(0, 6).map((f) => (
                  <span
                    key={f.webkitRelativePath || f.name}
                    className={`mv2-staging__chip${f.webkitRelativePath ? ' mv2-staging__chip--folder' : ''}`}
                    title={f.webkitRelativePath || f.name}
                  >
                    {f.webkitRelativePath ? `📁 ${f.webkitRelativePath}` : `📄 ${f.name}`}
                  </span>
                ))}
                {stagedFiles.length > 6 && (
                  <span className="mv2-staging__chip">+{stagedFiles.length - 6} файлов</span>
                )}
              </div>
            )}

            <input
              ref={chatFileInputRef}
              type="file"
              accept=".xls,.xlsx,.xlsm,.txt,.csv,.tsv,.pdf"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) handleFilesPick(e.target.files);
                e.target.value = '';
              }}
            />
            <input
              ref={chatFolderInputRef}
              type="file"
              webkitdirectory=""
              directory=""
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) handleFolderPick(e.target.files);
                e.target.value = '';
              }}
            />
            <input
              ref={chatTargetInputRef}
              type="file"
              accept=".xls,.xlsx,.xlsm"
              hidden
              onChange={(e) => {
                handleTargetFilePick(e.target.files?.[0] || null);
                e.target.value = '';
              }}
            />

            <div className="mv2-input-box">
              <textarea
                rows={2}
                placeholder={
                  currentQuestion
                    ? 'Ответь Martin в чате…'
                    : parsePreview
                      ? 'Фильтр, замени в колонке, классифицируй…'
                      : stagedFiles.length > 0
                        ? 'депо, брокер, ук… (Enter — отправить)'
                        : 'Напиши задачу или прикрепи файл…'
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
                    className="mv2-clip-btn"
                    title="Прикрепить"
                    disabled={aiLoading}
                    onClick={() => setAttachOpen((v) => !v)}
                  >
                    📎
                  </button>
                  {attachOpen && (
                    <div className="mv2-attach-menu">
                      <button
                        type="button"
                        onClick={() => {
                          setAttachOpen(false);
                          chatFileInputRef.current?.click();
                        }}
                      >
                        <span>📄</span> Файл или несколько
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAttachOpen(false);
                          chatFolderInputRef.current?.click();
                        }}
                      >
                        <span>📁</span> Папка целиком
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAttachOpen(false);
                          chatTargetInputRef.current?.click();
                        }}
                      >
                        <span>📑</span> Эталон Excel
                      </button>
                    </div>
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
                      !aiFile &&
                      !stagedFiles.length &&
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
