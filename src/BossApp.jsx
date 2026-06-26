import { clearAuthToken, getAuthRole, setAuthSession } from './auth';

export default function BossApp() {
  const role = getAuthRole();

  const logout = () => {
    clearAuthToken();
    window.location.reload();
  };

  return (
    <div className="boss-app">
      <aside className="boss-sidebar">
        <div className="boss-sidebar__brand">Панель руководителя</div>
        <nav className="boss-nav">
          <span className="boss-nav__item boss-nav__item--active">Обзор</span>
          <span className="boss-nav__item boss-nav__item--soon">Аудиторы</span>
          <span className="boss-nav__item boss-nav__item--soon">Проекты</span>
          <span className="boss-nav__item boss-nav__item--soon">ИИ-помощник</span>
        </nav>
        <button type="button" className="boss-sidebar__logout" onClick={logout}>
          Выход
        </button>
      </aside>
      <main className="boss-main">
        <h1>Обзор команды</h1>
        <p className="boss-main__sub">
          Роль: <strong>{role || 'boss'}</strong>. Разделы аудиторов, активности и ИИ-сводок подключим следующим
          шагом.
        </p>
        <div className="boss-cards">
          <div className="boss-card">
            <div className="boss-card__title">Аудиторы</div>
            <div className="boss-card__value">—</div>
          </div>
          <div className="boss-card">
            <div className="boss-card__title">Проекты в работе</div>
            <div className="boss-card__value">—</div>
          </div>
          <div className="boss-card">
            <div className="boss-card__title">Ошибки парсинга</div>
            <div className="boss-card__value">—</div>
          </div>
        </div>
      </main>
    </div>
  );
}
