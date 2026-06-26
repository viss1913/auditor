import { useState } from 'react';

const ROLE_KEY = 'auditor_auth_role';
const USER_ID_KEY = 'auditor_auth_user_id';
const NAME_KEY = 'auditor_auth_name';

export function getAuthToken() {
  try {
    return localStorage.getItem('auditor_auth_token') || '';
  } catch {
    return '';
  }
}

export function getAuthEmail() {
  try {
    return localStorage.getItem('auditor_auth_email') || '';
  } catch {
    return '';
  }
}

export function getAuthRole() {
  try {
    return localStorage.getItem(ROLE_KEY) || '';
  } catch {
    return '';
  }
}

export function getAuthUserId() {
  try {
    const v = localStorage.getItem(USER_ID_KEY);
    return v ? parseInt(v, 10) : null;
  } catch {
    return null;
  }
}

export function getAuthFullName() {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
}

export function setAuthToken(token) {
  localStorage.setItem('auditor_auth_token', token || '');
}

export function setAuthSession({ token, email, role, userId, fullName }) {
  setAuthToken(token);
  if (email) localStorage.setItem('auditor_auth_email', email);
  if (role) localStorage.setItem(ROLE_KEY, role);
  if (userId != null) localStorage.setItem(USER_ID_KEY, String(userId));
  if (fullName) localStorage.setItem(NAME_KEY, fullName);
}

export function clearAuthToken() {
  localStorage.removeItem('auditor_auth_token');
  localStorage.removeItem('auditor_auth_email');
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(USER_ID_KEY);
  localStorage.removeItem(NAME_KEY);
}

export function authHeaders(extra = {}) {
  const token = getAuthToken();
  if (!token) return { ...extra };
  return { ...extra, Authorization: `Bearer ${token}` };
}

/** Подмешивает Bearer во все fetch к API бэкенда */
export function installFetchAuth() {
  if (typeof window === 'undefined' || window.__auditorFetchAuth) return;
  const orig = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const needsAuth =
      url.includes(':3001') ||
      url.startsWith('/api') ||
      url.includes('/api/') ||
      /^\/(upload|trades|audit|ping)(\/|\?|$)/.test(url);
    if (!needsAuth || url.includes('/api/auth/login')) {
      return orig(input, init);
    }
    const token = getAuthToken();
    if (!token) return orig(input, init);
    const headers = new Headers(init.headers || {});
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
    return orig(input, { ...init, headers });
  };
  window.__auditorFetchAuth = true;
}
