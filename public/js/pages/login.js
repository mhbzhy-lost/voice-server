// ---------------------------------------------------------------------------
// Login / Register page
// ---------------------------------------------------------------------------
window.loginPage = {
  render() {
    return `
      <div class="auth-container">
        <div class="auth-card">
          <h1>在线语音</h1>
          <p class="auth-subtitle">自托管语音通讯</p>
          <div class="tab-bar">
            <button class="tab active" data-tab="login">登录</button>
            <button class="tab" data-tab="register">注册</button>
          </div>
          <form id="auth-form">
            <div id="auth-error" class="error-msg hidden"></div>
            <div class="form-group">
              <label for="auth-username">用户名</label>
              <input
                type="text"
                id="auth-username"
                required
                autocomplete="username"
                placeholder="请输入用户名"
              />
            </div>
            <div class="form-group">
              <label for="auth-password">密码</label>
              <input
                type="password"
                id="auth-password"
                required
                autocomplete="current-password"
                placeholder="请输入密码"
              />
            </div>
            <button type="submit" id="auth-submit" class="btn-primary btn-full">
              登录
            </button>
          </form>
        </div>
      </div>
    `;
  },

  init() {
    let mode = 'login';
    const form = document.getElementById('auth-form');
    const errorEl = document.getElementById('auth-error');
    const usernameInput = document.getElementById('auth-username');
    const passwordInput = document.getElementById('auth-password');
    const submitBtn = document.getElementById('auth-submit');

    // Tab switching
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) =>
          t.classList.remove('active')
        );
        tab.classList.add('active');
        mode = tab.dataset.tab;
        submitBtn.textContent = mode === 'login' ? '登录' : '注册';
        errorEl.classList.add('hidden');
      });
    });

    // Form submit
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = usernameInput.value.trim();
      const password = passwordInput.value;

      if (!username || !password) {
        errorEl.textContent = '请填写所有字段。';
        errorEl.classList.remove('hidden');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '请稍候...';
      errorEl.classList.add('hidden');

      try {
        const data = await api.post(`/api/auth/${mode}`, { username, password });
        await app.login(data.token, data.user);
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.classList.remove('hidden');
        submitBtn.disabled = false;
        submitBtn.textContent = mode === 'login' ? '登录' : '注册';
      }
    });
  },
};
