import React, { useState, useRef, useMemo } from 'react';
import './index.css';

function parseDate(str) {
  if (!str) return new Date(0);
  const [d, m, y] = str.split('.');
  return new Date(`${y}-${m}-${d}`);
}

const PAGE = {
  AI_MARTIN: 'ai_martin',
  OPIF_ISHODNYE: 'opif_ishodnye',
  OPIF_UK: 'opif_uk',
  OPIF_BROKER: 'opif_broker',
  OPIF_DEPO: 'opif_depo',
  OPIF_AUDIT: 'opif_audit',
  AUDIT_CONTRACTS: 'audit_contracts',
  AUDIT_DEALS: 'audit_deals',
};

function App() {
  const [page, setPage] = useState(PAGE.AI_MARTIN);
  const [opifExpanded, setOpifExpanded] = useState(true);
  const [activeTab, setActiveTab] = useState('uk'); // для данных: uk | broker | depo | audit
  const [sourceMode, setSourceMode] = useState('classic'); // 'classic' | 'ai' — переключение УК/ИИ УК внутри раздела
  const [ukFiles, setUkFiles] = useState([]);
  const [brokerFiles, setBrokerFiles] = useState([]);
  const [depoFiles, setDepoFiles] = useState([]);
  const [aiUkFiles, setAiUkFiles] = useState([]);
  const [aiBrokerFiles, setAiBrokerFiles] = useState([]);
  const [aiDepoFiles, setAiDepoFiles] = useState([]);
  const [ukData, setUkData] = useState([]);
  const [brokerData, setBrokerData] = useState([]);
  const [depoData, setDepoData] = useState([]);
  const [auditData, setAuditData] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [auditPage, setAuditPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [auditFilter, setAuditFilter] = useState('all'); // all | errors | ok
  const [auditDebug, setAuditDebug] = useState(false);
  const [auditPreview, setAuditPreview] = useState(null);
  const [auditPreviewLoading, setAuditPreviewLoading] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiRule, setAiRule] = useState(null);
  const [aiPreview, setAiPreview] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const rowsPerPage = 100;
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const response = await fetch(`http://localhost:3001/trades?source=${activeTab}`);
      if (response.ok) {
        const data = await response.json();
        if (activeTab === 'uk') setUkData(data);
        else if (activeTab === 'broker') setBrokerData(data);
        else setDepoData(data);
      }
    } catch (error) {
      console.error('Ошибка загрузки данных:', error);
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    if (page === PAGE.OPIF_UK) setActiveTab('uk');
    else if (page === PAGE.OPIF_BROKER) setActiveTab('broker');
    else if (page === PAGE.OPIF_DEPO) setActiveTab('depo');
    else if (page === PAGE.OPIF_AUDIT) setActiveTab('audit');
  }, [page]);

  React.useEffect(() => {
    if (activeTab && activeTab !== 'audit') {
      fetchData();
    }
    setSearchQuery('');
    setCurrentPage(1);
    setSourceMode('classic');
  }, [activeTab]);

  const runAuditPreview = async () => {
    setAuditPreviewLoading(true);
    setAuditPreview(null);
    try {
      const response = await fetch('http://localhost:3001/audit/preview');
      if (!response.ok) throw new Error('Ошибка сервера');
      const data = await response.json();
      setAuditPreview(data);
    } catch (error) {
      alert('Ошибка: ' + error.message);
    } finally {
      setAuditPreviewLoading(false);
    }
  };

  const runAudit = async () => {
    setAuditLoading(true);
    try {
      const url = auditDebug ? 'http://localhost:3001/audit?debug=1' : 'http://localhost:3001/audit';
      const response = await fetch(url);
      if (!response.ok) throw new Error('Ошибка сервера');
      const data = await response.json();
      setAuditData(data);
      setAuditPage(1);
      setAuditFilter('all');
    } catch (error) {
      alert('Ошибка при аудите: ' + error.message);
    } finally {
      setAuditLoading(false);
    }
  };

  const currentFiles = activeTab === 'uk' ? ukFiles : (activeTab === 'broker' ? brokerFiles : depoFiles);
  const rawData = activeTab === 'uk' ? ukData : (activeTab === 'broker' ? brokerData : depoData);

  const currentData = useMemo(() => {
    const sorted = [...rawData].sort((a, b) => parseDate(a.registrationDate || a.period) - parseDate(b.registrationDate || b.period));
    if (!searchQuery.trim()) return sorted;
    const q = searchQuery.toLowerCase().trim();
    return sorted.filter(r =>
      (r.name || '').toLowerCase().includes(q) ||
      (r.regNum || '').toLowerCase().includes(q) ||
      (r.isin || '').toLowerCase().includes(q) ||
      (r.registrationDate || r.period || '').includes(q) ||
      (r.operationType || '').toLowerCase().includes(q)
    );
  }, [rawData, searchQuery]);

  // Фильтрация аудита
  const filteredAudit = useMemo(() => {
    if (auditFilter === 'all') return auditData;
    if (auditFilter === 'errors') return auditData.filter(r => !r.brokerFound || !r.depoFound);
    if (auditFilter === 'ok') return auditData.filter(r => r.brokerFound && r.depoFound);
    return auditData;
  }, [auditData, auditFilter]);

  const auditErrors = auditData.filter(r => !r.brokerFound || !r.depoFound).length;
  const auditOk = auditData.filter(r => r.brokerFound && r.depoFound).length;

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files);
    if (activeTab === 'uk') setUkFiles(files);
    else if (activeTab === 'broker') setBrokerFiles(files);
    else if (activeTab === 'depo') setDepoFiles(files);
    e.target.value = '';
  };

  const handleFolderSelect = (e) => {
    const allFiles = Array.from(e.target.files);
    const filtered = allFiles.filter(f => f.name.startsWith('1F018_'));
    console.log(`[DEBUG] В папке: ${allFiles.length}, 1F018_: ${filtered.length}`);
    setBrokerFiles(filtered);
    e.target.value = '';
  };

  const openFileDialog = () => { if (fileInputRef.current) fileInputRef.current.click(); };
  const openFolderDialog = () => { if (folderInputRef.current) folderInputRef.current.click(); };

  const formatQty = (val) => {
    const n = parseFloat(val);
    if (isNaN(n)) return '0';
    return Number.isInteger(n) ? n.toLocaleString('ru-RU') : n.toLocaleString('ru-RU', { maximumFractionDigits: 4 });
  };
  const formatAmount = (val) => {
    const n = parseFloat(val);
    if (isNaN(n)) return '0.00';
    return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const formatFee = (val) => {
    const n = parseFloat(val);
    if (isNaN(n) || n === 0) return '-';
    return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const exportCsv = () => {
    const headers = activeTab === 'uk'
      ? ['Дата рег.', 'Вид сделки', 'Название', 'Счет', 'Рег. №', 'ISIN', 'Валюта', 'Кол-во', 'Сумма', 'Комиссия', 'Источник']
      : ['Дата рег.', 'Вид сделки', 'Название', 'Счет', 'Рег. №', 'ISIN', 'Валюта', 'Кол-во', 'Сумма', 'Комиссия', 'Источник'];
    const rows = currentData.map(r => (activeTab === 'uk' ? [
      r.registrationDate, r.operationType, r.name, r.debit_account, r.regNum, r.isin, r.currency,
      String(Number(r.quantity)).replace('.', ','),
      String(r.amount).replace('.', ','),
      String(r.fee).replace('.', ',')
    ] : [
      r.registrationDate || r.period, r.operationType, r.name, r.debit_account, r.regNum, r.isin, r.currency,
      String(Number(r.quantity)).replace('.', ','),
      String(r.amount).replace('.', ','),
      String(r.fee).replace('.', ',')
    ]).map(v => {
      const s = String(v ?? '');
      if (s.includes(';') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    }).join(';'));
    const csv = '\uFEFF' + [headers.join(';'), ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeTab}_export_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportAuditCsv = () => {
    const headers = ['Дата рег.', 'Вид сделки', 'Название', 'Рег. №', 'ISIN', 'Кол-во', 'Сумма', 'Валюта', 'УК↔Брокер', 'УК↔ДЕПО', 'ДЕПО кол-во'];
    const rows = filteredAudit.map(r => [
      r.registrationDate, r.operationType, r.name, r.regNum, r.isin,
      String(r.quantity).replace('.', ','),
      String(r.amount).replace('.', ','),
      r.currency,
      r.brokerFound ? 'Найдено' : 'НЕ НАЙДЕНО',
      r.depoFound ? 'Найдено' : 'НЕ НАЙДЕНО', r.depoGroupQty != null ? r.depoGroupQty : ''
    ].map(v => {
      const s = String(v ?? '');
      if (s.includes(';') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    }).join(';'));
    const csv = '\uFEFF' + [headers.join(';'), ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runParsing = async (mode = 'overwrite') => {
    const filesToUpload = activeTab === 'uk' ? ukFiles : (activeTab === 'broker' ? brokerFiles : depoFiles);
    if (filesToUpload.length === 0) { alert('Выберите файлы для загрузки.'); return; }
    setLoading(true);
    const formData = new FormData();
    formData.append('type', activeTab);
    formData.append('mode', mode);
    filesToUpload.forEach(file => formData.append('files', file));
    try {
      const response = await fetch('http://localhost:3001/upload', { method: 'POST', body: formData });
      if (!response.ok) { const e = await response.json(); throw new Error(e.error || 'Ошибка сервера'); }
      const data = await response.json();
      if (activeTab === 'uk') setUkData(data);
      else if (activeTab === 'broker') setBrokerData(data);
      else setDepoData(data);
      setCurrentPage(1); setSearchQuery('');
      if (activeTab === 'uk') setUkFiles([]);
      else if (activeTab === 'broker') setBrokerFiles([]);
      else setDepoFiles([]);
      alert(`Загружено ${data.length} записей!`);
    } catch (error) {
      alert(`Ошибка: ${error.message}`);
    } finally { setLoading(false); }
  };

  const generateAiRule = async () => {
    if (aiUkFiles.length === 0) { alert('Сначала выбери файл!'); return; }
    if (!aiPrompt.trim()) { alert('Введите описание правил парсинга.'); return; }
    setAiLoading(true);
    const formData = new FormData();
    formData.append('file', aiUkFiles[0]);
    formData.append('prompt', aiPrompt);
    try {
      const response = await fetch('http://localhost:3001/api/ai/generate-rule-from-file', {
        method: 'POST',
        body: formData
      });
      if (!response.ok) throw new Error('Ошибка связи с AI');
      const data = await response.json();
      setAiRule(data.rule);
      setAiPreview(data.preview);
    } catch (error) {
      alert('Ошибка AI: ' + error.message);
    } finally {
      setAiLoading(false);
    }
  };

  const runAiParsing = async () => {
    if (!aiRule) return;
    setLoading(true);
    const formData = new FormData();
    formData.append('type', 'uk');
    formData.append('mode', 'append');
    formData.append('ruleJson', JSON.stringify(aiRule));
    aiUkFiles.forEach(file => formData.append('files', file));

    try {
      const response = await fetch('http://localhost:3001/upload', { method: 'POST', body: formData });
      if (!response.ok) throw new Error('Ошибка парсинга');
      const data = await response.json();
      setUkData(data);
      alert(`Успех! Спарсили ${data.length} записей через AI!`);
      setActiveTab('uk');
    } catch (error) {
      alert('Ошибка: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const clearAllData = async () => {
    if (!confirm('Удалить все данные по этому источнику?')) return;
    try {
      const response = await fetch(`http://localhost:3001/trades?source=${activeTab}`, { method: 'DELETE' });
      if (response.ok) {
        if (activeTab === 'uk') setUkData([]);
        else if (activeTab === 'broker') setBrokerData([]);
        else setDepoData([]);
        setSearchQuery('');
        alert('Данные удалены.');
      }
    } catch (error) { alert('Не удалось удалить: ' + error.message); }
  };

  const totalPages = Math.ceil(currentData.length / rowsPerPage) || 1;
  const safePage = Math.min(currentPage, totalPages);
  const currentRows = currentData.slice((safePage - 1) * rowsPerPage, safePage * rowsPerPage);

  const auditTotalPages = Math.ceil(filteredAudit.length / rowsPerPage) || 1;
  const safeAuditPage = Math.min(auditPage, auditTotalPages);
  const auditRows = filteredAudit.slice((safeAuditPage - 1) * rowsPerPage, safeAuditPage * rowsPerPage);

  const isOpifDataPage = page === PAGE.OPIF_UK || page === PAGE.OPIF_BROKER || page === PAGE.OPIF_DEPO;

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-brand">BankFuture Audit</div>
        <nav className="sidebar-nav">
          <button
            className={`sidebar-item ${page === PAGE.AI_MARTIN ? 'active' : ''}`}
            onClick={() => setPage(PAGE.AI_MARTIN)}
          >
            <span className="sidebar-icon">🤖</span>
            AI Martin
          </button>
          <div className="sidebar-group">
            <button
              className="sidebar-group-title"
              onClick={() => setOpifExpanded(!opifExpanded)}
              aria-expanded={opifExpanded}
            >
              <span className="sidebar-icon">🗄️</span>
              Аудит ОПИФ
            </button>
            {opifExpanded && (
              <div className="sidebar-sub">
                <button className={`sidebar-sub-item ${page === PAGE.OPIF_ISHODNYE ? 'active' : ''}`} onClick={() => setPage(PAGE.OPIF_ISHODNYE)}>Исходные файлы</button>
                <button className={`sidebar-sub-item ${page === PAGE.OPIF_UK ? 'active' : ''}`} onClick={() => setPage(PAGE.OPIF_UK)}>УК</button>
                <button className={`sidebar-sub-item ${page === PAGE.OPIF_BROKER ? 'active' : ''}`} onClick={() => setPage(PAGE.OPIF_BROKER)}>Брокер</button>
                <button className={`sidebar-sub-item ${page === PAGE.OPIF_DEPO ? 'active' : ''}`} onClick={() => setPage(PAGE.OPIF_DEPO)}>ДЕПО</button>
                <button className={`sidebar-sub-item ${page === PAGE.OPIF_AUDIT ? 'active' : ''}`} onClick={() => setPage(PAGE.OPIF_AUDIT)}>Аудит</button>
              </div>
            )}
          </div>
          <button className={`sidebar-item ${page === PAGE.AUDIT_CONTRACTS ? 'active' : ''}`} onClick={() => setPage(PAGE.AUDIT_CONTRACTS)}>
            <span className="sidebar-icon">📄</span>
            Аудит договоров
          </button>
          <button className={`sidebar-item ${page === PAGE.AUDIT_DEALS ? 'active' : ''}`} onClick={() => setPage(PAGE.AUDIT_DEALS)}>
            <span className="sidebar-icon">🔍</span>
            Аудит сделок
          </button>
        </nav>
        <div className="sidebar-footer">
          <button className="sidebar-item">Выход</button>
        </div>
      </aside>

      <main className="main-content">
        <header className="main-header">
          <h1 className="main-title">BankFuture Audit</h1>
          <p className="main-tagline">Система аудита и сверки сделок по данным УК, брокера и депозитария</p>
        </header>

        {/* Переключение УК / ИИ УК внутри раздела */}
        {isOpifDataPage && (
          <div className="tabs source-sub-tabs">
            <button className={`tab-btn ${sourceMode === 'classic' ? 'active' : ''}`} onClick={() => setSourceMode('classic')}>
              {activeTab === 'uk' ? 'УК' : activeTab === 'broker' ? 'Брокер' : 'ДЕПО'}
            </button>
            <button className={`tab-btn ai-tab ${sourceMode === 'ai' ? 'active' : ''}`} onClick={() => setSourceMode('ai')}>
              🤖 ИИ {activeTab === 'uk' ? 'УК' : activeTab === 'broker' ? 'Брокер' : 'ДЕПО'}
            </button>
          </div>
        )}

        {/* AI Martin — первый экран */}
        {page === PAGE.AI_MARTIN && (
          <div className="panel">
            <h2>AI Martin</h2>
            <p className="hint">Ассистент для работы с данными и правилами парсинга. Задайте вопрос или перейдите в раздел УК → ИИ УК для генерации правил из файлов.</p>
            <div className="panel" style={{ background: '#f8fafc', padding: '1.5rem', border: '1px solid var(--border-color)' }}>
              <p style={{ marginBottom: '1rem', color: 'var(--text-secondary)' }}>Сообщение от Martin:</p>
              <p style={{ marginBottom: '1.5rem' }}>Здравствуйте. Я помогу с анализом отчётности и настройкой парсинга. Выберите раздел «Аудит ОПИФ» → «УК» → «ИИ УК» для загрузки файла и генерации правил.</p>
              <label className="hint">Введите сообщение:</label>
              <textarea className="search-input" style={{ minHeight: '100px', marginTop: '0.5rem' }} placeholder="В разработке: диалог с AI Martin" readOnly />
            </div>
          </div>
        )}

        {/* Исходные файлы — заглушка */}
        {page === PAGE.OPIF_ISHODNYE && (
          <div className="panel" style={{ textAlign: 'center', padding: '3rem' }}>
            <h2>Исходные файлы</h2>
            <p className="hint">Раздел в разработке. Здесь будет хранилище загруженных файлов.</p>
          </div>
        )}

        {/* Аудит договоров — заглушка */}
        {page === PAGE.AUDIT_CONTRACTS && (
          <div className="panel" style={{ textAlign: 'center', padding: '3rem' }}>
            <h2>Аудит договоров</h2>
            <p className="hint">Раздел в разработке.</p>
          </div>
        )}

        {/* Аудит сделок — заглушка */}
        {page === PAGE.AUDIT_DEALS && (
          <div className="panel" style={{ textAlign: 'center', padding: '3rem' }}>
            <h2>Аудит сделок</h2>
            <p className="hint">Раздел в разработке. Сверка УК↔Брокер↔ДЕПО доступна в разделе «Аудит ОПИФ» → «Аудит».</p>
          </div>
        )}

        {/* ===== АУДИТ (Аудит ОПИФ → Аудит) ===== */}
        {page === PAGE.OPIF_AUDIT && (
        <div>
          <div className="panel" style={{ textAlign: 'center' }}>
            <h2>Аудит сделок</h2>
            <p className="hint" style={{ marginTop: '0.5rem' }}>
              Берём каждую сделку из УК и ищем совпадения у Брокера (по дате рег. + бумага + кол-во + сумма) и в ДЕПО (по дате + бумага + кол-во). УК «Покупка» = ДЕПО «Зачисление ЦБ» (тип buy).
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', justifyContent: 'center', marginTop: '1rem' }}>
              <button className="btn secondary" onClick={runAuditPreview} disabled={auditPreviewLoading}>
                {auditPreviewLoading ? '⏳ Загружаю...' : '🔑 Проверить ключи (подготовка к аудиту)'}
              </button>
              <button className="btn" style={{ fontSize: '1.1rem', padding: '0.6rem 1.5rem' }}
                onClick={runAudit} disabled={auditLoading}>
                {auditLoading ? '⏳ Проверяю...' : '▶ Запустить аудит'}
              </button>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '0.8rem', justifyContent: 'center' }}>
              <input type="checkbox" checked={auditDebug} onChange={e => setAuditDebug(e.target.checked)} />
              <span>Отладка: логи в консоли сервера + в ответе (ключи, суммы УК/ДЕПО)</span>
            </label>
          </div>

          {auditPreview && (
            <div className="panel" style={{ marginTop: '1rem' }}>
              <h3>Подготовка к аудиту — что в базах и какие ключи строятся</h3>
              <p className="hint">{auditPreview.hint}</p>
              <p><strong>Записей:</strong> УК: {auditPreview.counts.uk}, Брокер: {auditPreview.counts.broker}, ДЕПО: {auditPreview.counts.depo} · Карта reg↔ISIN: {auditPreview.regToIsinSize} пар</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
                <div>
                  <h4>Пример данных УК (дата рег., операция, рег.№/ISIN, кол-во)</h4>
                  <pre style={{ background: '#f1f5f9', color: '#1e293b', padding: '10px', borderRadius: 8, fontSize: '0.85em', overflow: 'auto', maxHeight: 200 }}>
                    {auditPreview.sampleUk.map((r, i) => `${(i + 1)}. ${r.registration_date} | ${r.operation_type || ''} | reg:${r.reg_number} isin:${r.isin} | ${r.quantity}`).join('\n') || '—'}
                  </pre>
                </div>
                <div>
                  <h4>Пример данных ДЕПО</h4>
                  <pre style={{ background: '#f1f5f9', color: '#1e293b', padding: '10px', borderRadius: 8, fontSize: '0.85em', overflow: 'auto', maxHeight: 200 }}>
                    {auditPreview.sampleDepo.map((r, i) => `${(i + 1)}. ${r.registration_date} | ${r.operation_type || ''} | reg:${r.reg_number} isin:${r.isin} | ${r.quantity}`).join('\n') || '—'}
                  </pre>
                </div>
              </div>
              <div style={{ marginTop: '1rem' }}>
                <h4>Ключи УК (дата|бумага|buy/sell) → сумма</h4>
                <pre style={{ background: '#f1f5f9', color: '#1e293b', padding: '10px', borderRadius: 8, fontSize: '0.85em', overflow: 'auto', maxHeight: 180 }}>
                  {auditPreview.ukKeys.map(({ key, qty }) => `${key} → ${qty}`).join('\n') || '—'}
                </pre>
              </div>
              <div style={{ marginTop: '0.5rem' }}>
                <h4>Ключи ДЕПО</h4>
                <pre style={{ background: '#f1f5f9', color: '#1e293b', padding: '10px', borderRadius: 8, fontSize: '0.85em', overflow: 'auto', maxHeight: 180 }}>
                  {auditPreview.depoKeys.map(({ key, qty }) => `${key} → ${qty}`).join('\n') || '—'}
                </pre>
              </div>
              <div style={{ marginTop: '1rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                <span className="status-badge" style={{ background: '#238636' }}>Совпадают по ключу: {auditPreview.commonKeys.length}</span>
                {auditPreview.onlyInUk.length > 0 && <span className="status-badge" style={{ background: '#da3633' }}>Только в УК: {auditPreview.onlyInUk.length}</span>}
                {auditPreview.onlyInDepo.length > 0 && <span className="status-badge" style={{ background: '#9e6a03' }}>Только в ДЕПО: {auditPreview.onlyInDepo.length}</span>}
              </div>
              {auditPreview.onlyInUk.length > 0 && (
                <details style={{ marginTop: '0.5rem' }}>
                  <summary>Ключи только в УК (нет в ДЕПО)</summary>
                  <pre style={{ background: '#f1f5f9', color: '#1e293b', padding: 8, fontSize: '0.8em', maxHeight: 120, overflow: 'auto' }}>
                    {auditPreview.onlyInUk.map(({ key, qty }) => `${key} → ${qty}`).join('\n')}
                  </pre>
                </details>
              )}
              {auditPreview.onlyInDepo.length > 0 && (
                <details style={{ marginTop: '0.5rem' }}>
                  <summary>Ключи только в ДЕПО (нет в УК)</summary>
                  <pre style={{ background: '#f1f5f9', color: '#1e293b', padding: 8, fontSize: '0.8em', maxHeight: 120, overflow: 'auto' }}>
                    {auditPreview.onlyInDepo.map(({ key, qty }) => `${key} → ${qty}`).join('\n')}
                  </pre>
                </details>
              )}
              {auditPreview.commonKeys.length > 0 && (
                <details style={{ marginTop: '0.5rem' }}>
                  <summary>Общие ключи (УК кол-во vs ДЕПО кол-во, совпало?)</summary>
                  <pre style={{ background: '#f1f5f9', color: '#1e293b', padding: 8, fontSize: '0.8em', maxHeight: 150, overflow: 'auto' }}>
                    {auditPreview.commonKeys.map(({ key, ukQty, depoQty, match }) => `${key} → УК:${ukQty} ДЕПО:${depoQty} ${match ? '✅' : '❌'}`).join('\n')}
                  </pre>
                </details>
              )}
            </div>
          )}

          {auditData.length > 0 && (
            <div className="panel">
              <div className="panel-header">
                <h2>Результаты аудита</h2>
                <div className="stats">
                  <span className="status-badge accent">Всего: {auditData.length}</span>
                  <span className="status-badge" style={{ background: '#238636' }}>✅ Ок: {auditOk}</span>
                  {auditErrors > 0 && <span className="status-badge" style={{ background: '#da3633' }}>❌ Проблем: {auditErrors}</span>}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px', marginBottom: '1rem', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {['all', 'errors', 'ok'].map(f => (
                    <button key={f} className={`btn secondary ${auditFilter === f ? 'tab-btn active' : ''}`}
                      onClick={() => { setAuditFilter(f); setAuditPage(1); }}
                      style={{ padding: '6px 14px' }}>
                      {f === 'all' ? 'Все' : f === 'errors' ? '❌ Проблемы' : '✅ Совпало'}
                    </button>
                  ))}
                </div>
                <span style={{ flex: 1 }} />
                <button className="btn secondary" onClick={exportAuditCsv}>⬇ CSV</button>
              </div>

              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Дата рег.</th>
                      <th>Операция</th>
                      <th>Название</th>
                      <th>Рег. №</th>
                      <th>ISIN</th>
                      <th style={{ textAlign: 'right' }}>Кол-во</th>
                      <th style={{ textAlign: 'right' }}>Сумма</th>
                      <th>Вал.</th>
                      <th style={{ textAlign: 'center' }}>УК↔Брокер</th>
                      <th style={{ textAlign: 'center' }}>УК↔ДЕПО</th>
                      {auditRows.some(r => r._debug) && <th title="Ключ группы, сумма УК, сумма ДЕПО">Отладка</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {auditRows.map((row, i) => {
                      const allOk = row.brokerFound && row.depoFound;
                      return (
                        <tr key={i} style={{ background: allOk ? 'rgba(35,134,54,0.05)' : 'rgba(218,54,51,0.07)' }}>
                          <td>{row.registrationDate}</td>
                          <td>{row.operationType}</td>
                          <td title={row.name}>{row.name.length > 28 ? row.name.substring(0, 28) + '...' : row.name}</td>
                          <td>{row.regNum}</td>
                          <td>{row.isin}</td>
                          <td style={{ textAlign: 'right' }}>{formatQty(row.quantity)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{formatAmount(row.amount)}</td>
                          <td>{row.currency}</td>
                          <td style={{ textAlign: 'center' }}>
                            {row.brokerFound
                              ? <span className="audit-ok">✅ Найдено</span>
                              : <span className="audit-err">❌ Не найдено</span>}
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            {row.depoFound
                              ? <span className="audit-ok">✅ Депо ок</span>
                              : <span className="audit-err">❌ Не найдено</span>}
                            {row.depoGroupQty != null && row.depoGroupQty !== '' && (
                              <span title={`УК по группе: ${row.ukGroupQty}, ДЕПО по группе: ${row.depoGroupQty}`} style={{ marginLeft: 4, opacity: 0.8 }}>(УК:{formatQty(row.ukGroupQty)} ДЕПО:{formatQty(row.depoGroupQty)})</span>
                            )}
                          </td>
                          {row._debug && (
                            <td style={{ fontSize: '0.85em', maxWidth: 220 }} title={row._debug.groupKey}>
                              ключ: {String(row._debug.groupKey || '').slice(0, 35)}… | УК:{formatQty(row._debug.ukGroupQty)} ДЕПО:{formatQty(row._debug.depoGroupQty)}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="pagination">
                <button className="btn secondary" onClick={() => setAuditPage(1)} disabled={safeAuditPage === 1}>«</button>
                <button className="btn secondary" onClick={() => setAuditPage(p => Math.max(1, p - 1))} disabled={safeAuditPage === 1}>Назад</button>
                <span className="page-info">{safeAuditPage} / {auditTotalPages}</span>
                <button className="btn secondary" onClick={() => setAuditPage(p => Math.min(auditTotalPages, p + 1))} disabled={safeAuditPage === auditTotalPages}>Вперёд</button>
                <button className="btn secondary" onClick={() => setAuditPage(auditTotalPages)} disabled={safeAuditPage === auditTotalPages}>»</button>
              </div>
            </div>
          )}
        </div>
      )}

        {/* ===== ИИ УК (внутри раздела УК) ===== */}
        {page === PAGE.OPIF_UK && sourceMode === 'ai' && (
        <div className="panel animate-in">
          <h2>ИИ Парсинг УК (Qwen)</h2>
          <p className="hint">Загрузите файл карточки счёта УК и опишите, какие данные нужно извлечь (счета Дт/Кт, период).</p>

          <div style={{ marginTop: '1.5rem' }}>
            <input type="file" onChange={e => setAiUkFiles(Array.from(e.target.files))} style={{ marginBottom: '1rem' }} />
            <textarea
              className="search-input"
              style={{ width: '100%', minHeight: '100px', padding: '10px', fontSize: '1rem' }}
              placeholder='Пример: "Мне нужны данные если Д счет номер 58.1, а Ксчет номер 76 с 1 января 2025 года по 30 мая 2025"'
              value={aiPrompt}
              onChange={e => setAiPrompt(e.target.value)}
            />
            <button
              className="btn"
              style={{ marginTop: '1rem', width: '100%' }}
              onClick={generateAiRule}
              disabled={aiLoading}
            >
              {aiLoading ? '⏳ Генерация...' : '🔮 Сгенерировать правило'}
            </button>
          </div>

          {aiRule && (
            <div style={{ marginTop: '2rem', borderTop: '1px solid #30363d', paddingTop: '1.5rem' }}>
              <h3>Сгенерированное правило:</h3>
              <pre style={{ background: '#f1f5f9', padding: '15px', borderRadius: '8px', overflowX: 'auto', fontSize: '0.9rem', color: '#1e40af', border: '1px solid #e2e8f0' }}>
                {JSON.stringify(aiRule, null, 2)}
              </pre>

              <div style={{ marginTop: '1rem' }}>
                <h4>Фрагмент данных (на чем учились):</h4>
                <div style={{ maxHeight: '150px', overflowY: 'auto', fontSize: '0.8rem', opacity: 0.7, background: '#f1f5f9', padding: '10px', border: '1px solid #e2e8f0' }}>
                  {aiPreview}
                </div>
              </div>

              <button
                className="btn accent"
                style={{ marginTop: '1.5rem', width: '100%', padding: '1rem' }}
                onClick={runAiParsing}
                disabled={loading}
              >
                {loading ? '⚙️ Парсим...' : '🚀 Запустить парсинг по этому правилу'}
              </button>
            </div>
          )}
        </div>
      )}

        {/* ===== ИИ Брокер / ИИ ДЕПО — заглушки ===== */}
        {page === PAGE.OPIF_BROKER && sourceMode === 'ai' && (
        <div className="panel animate-in" style={{ textAlign: 'center', padding: '3rem' }}>
          <h2>🤖 ИИ Брокер</h2>
          <p className="hint" style={{ fontSize: '1.2rem', marginTop: '1rem' }}>В разработке.</p>
          <p>Раздел в подготовке. Пока доступен ИИ УК.</p>
        </div>
      )}
        {page === PAGE.OPIF_DEPO && sourceMode === 'ai' && (
        <div className="panel animate-in" style={{ textAlign: 'center', padding: '3rem' }}>
          <h2>🤖 ИИ ДЕПО</h2>
          <p className="hint" style={{ fontSize: '1.2rem', marginTop: '1rem' }}>В разработке.</p>
          <p>Раздел в подготовке. Пока доступен ИИ УК.</p>
        </div>
      )}

        {/* ===== УК / Брокер / ДЕПО — классический режим (загрузка + таблица) ===== */}
        {isOpifDataPage && sourceMode === 'classic' && (
        <>
          <div className="panel">
            <input ref={fileInputRef} type="file" multiple
              accept={activeTab === 'depo' ? ".pdf" : ".xls,.xlsx,.xlsm"}
              style={{ display: 'none' }} onChange={handleFileSelect} />
            <input ref={folderInputRef} type="file" webkitdirectory="" multiple
              style={{ display: 'none' }} onChange={handleFolderSelect} />
            <div className="upload-zone" style={{ cursor: 'pointer' }}>
              <h3>Загрузка: {activeTab === 'uk' ? 'УК Документы' : (activeTab === 'broker' ? 'Брокер (1F018_*)' : 'ДЕПО PDF')}</h3>
              {activeTab === 'broker' ? (
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', marginBottom: '0.5rem' }}>
                  <button className="btn secondary" onClick={openFolderDialog}>📁 Выбрать папку (авто-фильтр 1F018_)</button>
                  <button className="btn secondary" onClick={openFileDialog}>📄 Выбрать файлы вручную</button>
                </div>
              ) : (
                <p onClick={openFileDialog}>Перетащите файлы сюда или нажмите для выбора.</p>
              )}
              <p>Выбрано: {currentFiles.length} файл(ов)</p>
              {currentFiles.length > 0 && (
                <div className="files-cloud">
                  {currentFiles.map(f => <span key={f.webkitRelativePath || f.name} className="status-badge" title={f.webkitRelativePath}>{f.name}</span>)}
                </div>
              )}
            </div>
          </div>

          <div className="panel" style={{ textAlign: 'center' }}>
            <h2>{activeTab === 'uk' ? 'Парсинг УК' : (activeTab === 'broker' ? 'Парсинг Брокера' : 'Парсинг ДЕПО')}</h2>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '15px', marginTop: '1rem' }}>
              <button className="btn" onClick={() => runParsing('overwrite')} disabled={loading || currentFiles.length === 0}>
                {loading ? 'Загрузка...' : 'Заменить всё'}
              </button>
              <button className="btn secondary" onClick={() => runParsing('append')} disabled={loading || currentFiles.length === 0}>
                {loading ? 'Загрузка...' : 'Добавить к текущим'}
              </button>
              <button className="btn danger" onClick={clearAllData} disabled={loading || rawData.length === 0}>
                Удалить базу
              </button>
            </div>
            <p className="hint" style={{ marginTop: '1rem' }}>
              {activeTab === 'uk' ? 'Дт 58.01 / Кт 76' : (activeTab === 'broker' ? 'Раздел 1.2: Обязательства не исполнены' : 'Выписка о движении ЦБ (PDF)')}
            </p>
          </div>

          {rawData.length > 0 && (
            <div className="panel">
              <div className="panel-header">
                <h2>{activeTab === 'uk' ? 'Данные УК' : (activeTab === 'broker' ? 'Данные Брокера' : 'Данные ДЕПО')}</h2>
                <div className="stats">
                  <span className="status-badge accent">Записей: {rawData.length}</span>
                  {searchQuery && <span className="status-badge accent">Найдено: {currentData.length}</span>}
                  <span className="status-badge gray">Стр. {safePage} из {totalPages}</span>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px', marginBottom: '1rem', alignItems: 'center' }}>
                <input type="text" className="search-input"
                  placeholder="🔍 Поиск по названию, ISIN, рег. №, дате, виду сделки..."
                  value={searchQuery} onChange={e => { setSearchQuery(e.target.value); setCurrentPage(1); }} />
                {searchQuery && <button className="btn secondary" onClick={() => { setSearchQuery(''); setCurrentPage(1); }}>✕</button>}
                <button className="btn secondary" onClick={exportCsv} disabled={currentData.length === 0}>⬇ CSV</button>
              </div>

              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Дата рег. ↑</th>
                      <th>Вид сделки</th>
                      <th>Название</th>
                      <th>Счет</th>
                      <th>Рег. №</th>
                      <th>ISIN</th>
                      <th>Вал.</th>
                      <th style={{ textAlign: 'right' }}>Кол-во</th>
                      <th style={{ textAlign: 'right' }}>Сумма</th>
                      <th style={{ textAlign: 'right' }}>Комиссии</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentRows.map((row, i) => (
                      <tr key={i}>
                        <td>{row.registrationDate || row.period || ''}</td>
                        <td>{row.operationType || ''}</td>
                        <td title={row.name}>{row.name.length > 30 ? row.name.substring(0, 30) + '...' : row.name}</td>
                        <td>{row.debit_account || ''}</td>
                        <td>{row.regNum || ''}</td>
                        <td>{row.isin || ''}</td>
                        <td>{row.currency || ''}</td>
                        <td style={{ textAlign: 'right' }}>{formatQty(row.quantity)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{formatAmount(row.amount)}</td>
                        <td style={{ textAlign: 'right', color: row.fee > 0 ? '#ff4757' : 'inherit' }}>{formatFee(row.fee)}</td>
                      </tr>
                    ))}
                    {currentRows.length === 0 && (
                      <tr><td colSpan={10} style={{ textAlign: 'center', padding: '2rem', opacity: 0.5 }}>Ничего не нашли по запросу «{searchQuery}»</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="pagination">
                <button className="btn secondary" onClick={() => setCurrentPage(1)} disabled={safePage === 1}>«</button>
                <button className="btn secondary" onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={safePage === 1}>Назад</button>
                <span className="page-info">{safePage} / {totalPages}</span>
                <button className="btn secondary" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}>Вперёд</button>
                <button className="btn secondary" onClick={() => setCurrentPage(totalPages)} disabled={safePage === totalPages}>»</button>
              </div>
            </div>
          )}
        </>
        )}
      </main>
    </div>
  );
}

export default App;
