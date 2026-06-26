import { useState } from 'react';
import { apiBase } from './apiBase';
import { setAuthSession } from './auth';

export default function LoginStub({ onSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${apiBase()}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Не пустили');
        return;
      }
      setAuthSession({
        token: data.token,
        email: data.email || email.trim(),
        role: data.role || 'auditor',
        userId: data.userId,
        fullName: data.fullName,
      });
      onSuccess?.(data);
    } catch {
      setError('Сервер не отвечает — проверь Immers или npm run dev');
    } finally {
      setLoading(false);
    }
  };

  const canSubmit = email.trim() && password.trim();

  return (
    <div className="login-stub">
      <form className="login-stub__card" onSubmit={submit}>
        <h1>Аудитор</h1>
        <p className="login-stub__sub">Вход в систему</p>
        <label className="login-stub__label">
          Email
          <input
            type="email"
            className="login-stub__input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="demo@bankfuture.ru"
            autoComplete="username"
            autoFocus
          />
        </label>
        <label className="login-stub__label">
          Пароль
          <input
            type="password"
            className="login-stub__input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••"
            autoComplete="current-password"
          />
        </label>
        {error ? <p className="login-stub__error">{error}</p> : null}
        <button type="submit" className="login-stub__btn" disabled={loading || !canSubmit}>
          {loading ? 'Входим…' : 'Войти'}
        </button>
        <p className="login-stub__hint">
          Immers: <code>admin@corp.local</code> / <code>Auditor2026!</code>
          <br />
          Босс: <code>boss@bankfuture.ru</code> / <code>Auditor2026!</code>
        </p>
      </form>
    </div>
  );
}
