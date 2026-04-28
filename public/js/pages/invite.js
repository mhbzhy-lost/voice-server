// ---------------------------------------------------------------------------
// Invite landing page (#/invite/:token) — 校验邀请并完成注册
// ---------------------------------------------------------------------------
window.invitePage = {
  _token: null,

  render(token) {
    this._token = token;
    return `
      <div class="auth-container">
        <div class="auth-card" id="invite-card">
          <h1>在线语音</h1>
          <p class="auth-subtitle">自托管语音通讯</p>
          <div id="invite-body">
            <div class="loading">正在校验邀请...</div>
          </div>
        </div>
      </div>
    `;
  },

  async init(token) {
    this._token = token || this._token;
    const body = document.getElementById('invite-body');

    let result;
    try {
      result = await api.get('/api/invites/check/' + encodeURIComponent(this._token));
    } catch (e) {
      this._renderError(body, '邀请校验失败：' + (e.message || '网络错误'));
      return;
    }

    if (!result || !result.valid) {
      const reason = result && result.reason;
      let msg = '邀请校验失败';
      if (reason === 'not-found') msg = '邀请链接无效或已被撤销';
      else if (reason === 'expired') msg = '邀请链接已过期';
      this._renderError(body, msg);
      return;
    }

    this._renderForm(body);
  },

  _renderError(body, message) {
    body.innerHTML = `
      <div class="error-msg">${escapeHtml(message)}</div>
      <div class="modal-actions" style="justify-content:center;margin-top:16px;">
        <button id="btn-invite-back" class="btn-secondary">返回登录</button>
      </div>
    `;
    document.getElementById('btn-invite-back').addEventListener('click', () => {
      window.location.hash = '#/login';
    });
  },

  _renderForm(body) {
    body.innerHTML = `
      <h2 class="auth-form-title">注册账号</h2>
      <p class="invite-hint">你被邀请加入语音服务，请创建账号。</p>
      <form id="invite-form">
        <div id="invite-error" class="error-msg hidden"></div>
        <div class="form-group">
          <label for="invite-username">用户名</label>
          <input type="text" id="invite-username" required autocomplete="username" placeholder="请输入用户名" />
        </div>
        <div class="form-group">
          <label for="invite-password">密码</label>
          <input type="password" id="invite-password" required autocomplete="new-password" placeholder="请输入密码" />
        </div>
        <div class="form-group">
          <label for="invite-password2">确认密码</label>
          <input type="password" id="invite-password2" required autocomplete="new-password" placeholder="请再次输入密码" />
        </div>
        <button type="submit" id="invite-submit" class="btn-primary btn-full">注册</button>
      </form>
    `;

    const form = document.getElementById('invite-form');
    const errorEl = document.getElementById('invite-error');
    const userEl = document.getElementById('invite-username');
    const pw1El = document.getElementById('invite-password');
    const pw2El = document.getElementById('invite-password2');
    const submitBtn = document.getElementById('invite-submit');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = userEl.value.trim();
      const password = pw1El.value;
      const password2 = pw2El.value;

      errorEl.classList.add('hidden');

      if (!username || !password) {
        errorEl.textContent = '请填写所有字段。';
        errorEl.classList.remove('hidden');
        return;
      }
      if (password !== password2) {
        errorEl.textContent = '两次输入的密码不一致。';
        errorEl.classList.remove('hidden');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '请稍候...';

      try {
        const data = await api.post('/api/auth/register', {
          username,
          password,
          inviteToken: this._token,
        });
        await app.login(data.token, data.user);
      } catch (err) {
        errorEl.textContent = err.message || '注册失败';
        errorEl.classList.remove('hidden');
        submitBtn.disabled = false;
        submitBtn.textContent = '注册';
      }
    });
  },

  destroy() {
    this._token = null;
  },
};
