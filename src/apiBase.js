/**
 * Базовый URL API.
 * - VITE_API_BASE — явный override при сборке (например https://auditor.corp/api)
 * - PROD без override — same-origin /api (nginx reverse proxy)
 * - DEV — напрямую :3001 (Vite proxy ненадёжен для тысяч multipart-файлов)
 */
import { getAuthToken } from './auth.js';

export function apiBase() {
  const configured = String(import.meta.env.VITE_API_BASE || '').trim();
  if (configured) {
    return configured.replace(/\/$/, '');
  }
  if (import.meta.env.PROD) {
    return `${window.location.origin}/api`;
  }
  const host = window.location.hostname || '127.0.0.1';
  return `${window.location.protocol}//${host}:3001/api`;
}

/** Legacy OPIF routes без префикса /api: /upload, /trades, /audit, /ping */
export function legacyApiRoot() {
  const configured = String(import.meta.env.VITE_API_ROOT || '').trim();
  if (configured) {
    return configured.replace(/\/$/, '');
  }
  if (import.meta.env.PROD) {
    return window.location.origin;
  }
  const host = window.location.hostname || '127.0.0.1';
  return `${window.location.protocol}//${host}:3001`;
}

export function apiAuditorQuery(slug, extra = {}) {
  const q = new URLSearchParams({ auditor: slug || 'anton', ...extra });
  return q.toString();
}

export function normalizeUploadPath(p) {
  let n = String(p || '').replace(/\\/g, '/').trim();
  n = n.replace(/^\.\//, '');
  n = n.replace(/^[a-zA-Z]:\//, '');
  n = n.replace(/^\/+/, '');
  return n;
}

/** POST multipart — XHR стабильнее fetch на больших FormData в Chrome/Windows. */
export function postFormData(url, formData, { timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.timeout = timeoutMs;
    const token = getAuthToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.onload = () => {
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        text: xhr.responseText,
      });
    };
    xhr.onerror = () =>
      reject(new Error(`XHR network error (status=${xhr.status}, readyState=${xhr.readyState})`));
    xhr.ontimeout = () => reject(new Error(`XHR timeout ${timeoutMs}ms`));
    xhr.onabort = () => reject(new Error('XHR aborted'));
    xhr.send(formData);
  });
}
