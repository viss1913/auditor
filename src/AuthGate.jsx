import { useEffect, useState } from 'react';
import { apiBase } from './apiBase';
import {
  authHeaders,
  clearAuthToken,
  getAuthRole,
  getAuthToken,
  setAuthSession,
} from './auth';
import LoginStub from './LoginStub';
import App from './App';
import BossApp from './BossApp';

export default function AuthGate() {
  const [authed, setAuthed] = useState(() => Boolean(getAuthToken()));
  const [role, setRole] = useState(() => getAuthRole());
  const [checking, setChecking] = useState(() => Boolean(getAuthToken()));

  useEffect(() => {
    const token = getAuthToken();
    if (!token) {
      setChecking(false);
      return;
    }
    fetch(`${apiBase()}/auth/me`, { headers: authHeaders() })
      .then(async (r) => {
        if (!r.ok) {
          clearAuthToken();
          setAuthed(false);
          setRole('');
          return;
        }
        const data = await r.json();
        if (data.authenticated) {
          setAuthSession({
            token,
            email: data.email,
            role: data.role,
            userId: data.userId,
            fullName: data.fullName,
          });
          setRole(data.role || getAuthRole());
        }
      })
      .catch(() => {
        /* бэк выключен — пускаем с токеном */
      })
      .finally(() => setChecking(false));
  }, []);

  const onLogin = (data) => {
    setAuthed(true);
    setRole(data?.role || getAuthRole());
  };

  if (checking) {
    return (
      <div className="login-stub">
        <p className="login-stub__sub">Проверяем вход…</p>
      </div>
    );
  }

  if (!authed) {
    return <LoginStub onSuccess={onLogin} />;
  }

  if (role === 'boss') {
    return <BossApp />;
  }

  return <App />;
}
