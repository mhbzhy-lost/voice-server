// ---------------------------------------------------------------------------
// SPA Router & Global Application State
// ---------------------------------------------------------------------------
window.app = {
  state: {
    user: null,
    token: null,
  },

  _currentPage: null,

  async init() {
    // Try to restore session from localStorage
    const token = localStorage.getItem('voice_token');
    if (token) {
      api.token = token;
      try {
        const data = await api.get('/api/auth/me');
        this.state.user = data.user;
        this.state.token = token;
        // Reconnect WebSocket
        connectWS(token).catch((e) =>
          console.warn('WS reconnect after restore failed', e)
        );
      } catch {
        // Token expired or invalid – clear it
        localStorage.removeItem('voice_token');
        api.token = null;
      }
    }

    window.addEventListener('hashchange', () => this.route());
    this.route();
  },

  route() {
    // Clean up previous page
    if (this._currentPage && typeof this._currentPage.destroy === 'function') {
      this._currentPage.destroy();
    }
    this._currentPage = null;

    const hash = window.location.hash.slice(1) || '/login';
    const parts = hash.split('/').filter(Boolean);
    const path = parts[0] || 'login';
    const param = parts[1];

    // Redirect to login if not authenticated
    if (!this.state.user && path !== 'login') {
      window.location.hash = '#/login';
      return;
    }

    const appEl = document.getElementById('app');

    if (path === 'login') {
      this._currentPage = window.loginPage;
      appEl.innerHTML = window.loginPage.render();
      window.loginPage.init();
    } else if (path === 'lobby') {
      this._currentPage = window.lobbyPage;
      window.lobbyPage.render().then((html) => {
        appEl.innerHTML = html;
        window.lobbyPage.init();
      });
    } else if (path === 'profile') {
      this._currentPage = window.profilePage;
      appEl.innerHTML = window.profilePage.render();
      window.profilePage.init();
    } else if (path === 'room' && param) {
      this._currentPage = window.roomPage;
      window.roomPage.render(parseInt(param, 10)).then((html) => {
        appEl.innerHTML = html;
        window.roomPage.init(parseInt(param, 10));
      });
    } else {
      // Unknown route – go to lobby
      window.location.hash = '#/lobby';
    }
  },

  async login(token, user) {
    this.state.user = user;
    this.state.token = token;
    api.token = token;
    localStorage.setItem('voice_token', token);

    // Establish WebSocket connection
    try {
      await connectWS(token);
    } catch (e) {
      console.warn('Initial WS connection failed', e);
    }

    window.location.hash = '#/lobby';
  },

  logout() {
    api.post('/api/auth/logout').catch(() => {});
    this.state.user = null;
    this.state.token = null;
    api.token = null;
    localStorage.removeItem('voice_token');
    disconnectWS();
    window.location.hash = '#/login';
  },
};

// Boot
document.addEventListener('DOMContentLoaded', () => app.init());
