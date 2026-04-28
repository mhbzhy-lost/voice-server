// ---------------------------------------------------------------------------
// Invite management page (#/invites) — 仅超管
// ---------------------------------------------------------------------------
window.invitesPage = {
  _toastTimer: null,

  render() {
    return `
      <div class="lobby-container invites-page">
        <header class="lobby-header">
          <div class="lobby-header-left">
            <h1>邀请管理</h1>
          </div>
          <div class="user-info">
            <button id="btn-back-lobby" class="btn-secondary btn-sm">返回大厅</button>
          </div>
        </header>

        <div class="auth-card invite-form" style="max-width:640px;margin:0 auto 16px;">
          <h2 class="auth-form-title">新建邀请</h2>
          <div id="invite-create-error" class="error-msg hidden"></div>
          <div id="invite-create-success" class="success-msg hidden"></div>
          <div class="form-group">
            <label for="invite-days">有效天数（1 - 365）</label>
            <input type="number" id="invite-days" min="1" max="365" value="1" />
          </div>
          <div class="modal-actions" style="justify-content:flex-start;">
            <button id="btn-create-invite" class="btn-primary">生成邀请</button>
          </div>
          <div id="invite-just-created" class="invite-created hidden"></div>
        </div>

        <div class="invite-list-wrap" style="max-width:960px;margin:0 auto;">
          <h2 class="auth-form-title" style="text-align:left;">邀请列表</h2>
          <div id="invite-list" class="invite-list">
            <div class="loading">正在加载邀请...</div>
          </div>
        </div>

        <div id="invite-toast" class="invite-toast hidden"></div>
      </div>
    `;
  },

  init() {
    if (!app.state.user || app.state.user.role !== 'superadmin') {
      alert('仅超级管理员可以访问邀请管理');
      window.location.hash = '#/lobby';
      return;
    }

    document.getElementById('btn-back-lobby').addEventListener('click', () => {
      window.location.hash = '#/lobby';
    });

    document.getElementById('btn-create-invite').addEventListener('click', () => {
      this._createInvite();
    });

    this._refresh();
  },

  async _createInvite() {
    const daysEl = document.getElementById('invite-days');
    const errEl = document.getElementById('invite-create-error');
    const okEl = document.getElementById('invite-create-success');
    const justEl = document.getElementById('invite-just-created');
    const btn = document.getElementById('btn-create-invite');

    errEl.classList.add('hidden');
    okEl.classList.add('hidden');
    justEl.classList.add('hidden');
    justEl.innerHTML = '';

    let days = parseInt(daysEl.value, 10);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      errEl.textContent = '有效天数需在 1 - 365 之间';
      errEl.classList.remove('hidden');
      return;
    }

    btn.disabled = true;
    try {
      const data = await api.post('/api/invites', { days });
      const token = data && data.invite && data.invite.token;
      if (!token) throw new Error('返回数据缺少 token');
      const url = this._buildInviteUrl(token);

      okEl.textContent = '邀请创建成功';
      okEl.classList.remove('hidden');

      justEl.innerHTML = `
        <div class="invite-created-row">
          <span class="invite-created-label">邀请链接：</span>
          <input type="text" class="invite-created-url" id="invite-just-url" readonly value="${escapeHtml(url)}" />
          <button class="btn-secondary btn-sm" id="btn-copy-just">复制</button>
        </div>
      `;
      justEl.classList.remove('hidden');
      document.getElementById('btn-copy-just').addEventListener('click', () => {
        this._copy(url);
      });

      await this._refresh();
    } catch (e) {
      errEl.textContent = '创建失败：' + (e.message || '未知错误');
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  },

  async _refresh() {
    const container = document.getElementById('invite-list');
    if (!container) return;
    container.innerHTML = '<div class="loading">正在加载邀请...</div>';
    try {
      const data = await api.get('/api/invites');
      const invites = (data && data.invites) || [];
      container.innerHTML = this._renderList(invites);
      this._bindListActions(invites);
    } catch (e) {
      container.innerHTML = '<div class="error-msg">加载邀请失败：' + escapeHtml(e.message) + '</div>';
    }
  },

  _renderList(invites) {
    if (!invites.length) {
      return '<div class="empty-state">暂无邀请，先去新建一个吧。</div>';
    }
    const rows = invites.map((iv) => {
      const created = iv.created_at ? new Date(iv.created_at).toLocaleString('zh-CN') : '—';
      const expires = iv.expires_at ? new Date(iv.expires_at).toLocaleString('zh-CN') : '—';
      const statusLabel = iv.status === 'expired' ? '已过期' : '待用';
      const statusCls = iv.status === 'expired' ? 'status-expired' : 'status-pending';
      const useCount = typeof iv.use_count === 'number' ? iv.use_count : 0;
      return `
        <tr>
          <td>${escapeHtml(created)}</td>
          <td>${escapeHtml(expires)}</td>
          <td><span class="invite-status ${statusCls}">${statusLabel}</span></td>
          <td>${useCount}</td>
          <td>
            <button class="btn-secondary btn-sm btn-copy-invite" data-token="${escapeHtml(iv.token)}">复制链接</button>
            <button class="btn-secondary btn-sm btn-delete-invite" data-id="${iv.id}">删除</button>
          </td>
        </tr>
      `;
    }).join('');

    return `
      <table class="user-table invite-table">
        <thead>
          <tr>
            <th>创建时间</th>
            <th>过期时间</th>
            <th>状态</th>
            <th>已使用次数</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  },

  _bindListActions() {
    const container = document.getElementById('invite-list');
    if (!container) return;

    container.querySelectorAll('.btn-copy-invite').forEach((btn) => {
      btn.addEventListener('click', () => {
        const token = btn.dataset.token;
        const url = this._buildInviteUrl(token);
        this._copy(url);
      });
    });

    container.querySelectorAll('.btn-delete-invite').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('确认删除该邀请？已注册的用户不会受影响。')) return;
        const id = btn.dataset.id;
        btn.disabled = true;
        try {
          await api.del('/api/invites/' + encodeURIComponent(id));
          await this._refresh();
        } catch (e) {
          alert('删除失败：' + (e.message || '未知错误'));
          btn.disabled = false;
        }
      });
    });
  },

  _buildInviteUrl(token) {
    return window.location.origin + '/#/invite/' + token;
  },

  async _copy(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      this._showToast('已复制');
    } catch (e) {
      this._showToast('复制失败');
    }
  },

  _showToast(msg) {
    const el = document.getElementById('invite-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      el.classList.add('hidden');
    }, 1600);
  },

  destroy() {
    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
      this._toastTimer = null;
    }
  },
};
