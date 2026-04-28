// ---------------------------------------------------------------------------
// Lobby page – room list + create room + superadmin user management
// ---------------------------------------------------------------------------
const ROLE_LABELS = {
  user: '用户',
  admin: '管理员',
  superadmin: '超级管理员',
};

function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

window.lobbyPage = {
  _refreshInterval: null,

  async render() {
    let roomsHtml = '<div class="loading">正在加载房间...</div>';

    try {
      const rooms = await api.get('/api/rooms');
      roomsHtml = this._renderRoomList(rooms);
    } catch (e) {
      roomsHtml =
        '<div class="error-msg">加载房间失败：' +
        escapeHtml(e.message) +
        '</div>';
    }

    const isSuperAdmin = app.state.user.role === 'superadmin';
    const displayName = app.state.user.nickname || app.state.user.username;

    return `
      <div class="lobby-container">
        <header class="lobby-header">
          <div class="lobby-header-left">
            <h1>语音房间</h1>
          </div>
          <div class="user-info">
            <span>当前登录：<strong>${escapeHtml(displayName)}</strong> (${escapeHtml(roleLabel(app.state.user.role))})</span>
            <button id="btn-profile" class="btn-secondary btn-sm" style="margin:0 4px">个人设置</button>
            ${isSuperAdmin ? '<button id="btn-manage-users" class="btn-secondary btn-sm" style="margin:0 4px">用户管理</button>' : ''}
            ${isSuperAdmin ? '<button id="btn-manage-invites" class="btn-secondary btn-sm" style="margin:0 4px">邀请管理</button>' : ''}
            <button id="btn-logout" class="btn-secondary btn-sm">退出登录</button>
          </div>
        </header>

        <div class="lobby-actions">
          <button id="btn-create-room" class="btn-primary">+ 创建房间</button>
        </div>

        <div id="room-list" class="room-list">
          ${roomsHtml}
        </div>
      </div>

      <!-- Create-room modal -->
      <div id="create-room-modal" class="modal-overlay hidden">
        <div class="modal-card">
          <h2>创建房间</h2>
          <div class="form-group">
            <input
              type="text"
              id="room-name-input"
              class="input-full"
              placeholder="房间名称..."
              maxlength="50"
              autofocus
            />
          </div>
          <div class="modal-actions">
            <button id="btn-create-confirm" class="btn-primary">创建</button>
            <button id="btn-create-cancel" class="btn-secondary">取消</button>
          </div>
        </div>
      </div>

      <!-- User management modal (superadmin only) -->
      <div id="user-manage-modal" class="modal-overlay hidden">
        <div class="modal-card modal-card-wide">
          <h2>用户管理</h2>
          <div id="user-list-container" class="user-list-container">
            <div class="loading">正在加载用户...</div>
          </div>
          <div class="modal-actions">
            <button id="btn-user-manage-close" class="btn-secondary">关闭</button>
          </div>
        </div>
      </div>
    `;
  },

  _renderRoomList(rooms) {
    if (!rooms || rooms.length === 0) {
      return '<div class="empty-state">暂无房间，快来创建一个吧！</div>';
    }

    const isAdmin = app.state.user.role === 'admin' || app.state.user.role === 'superadmin';

    return rooms
      .map(
        (room) => `
      <div class="room-card" data-room-id="${room.id}">
        <div class="room-info">
          <h3>${escapeHtml(room.name)}</h3>
          <span class="room-owner">创建者：${escapeHtml(room.owner_username)}</span>
        </div>
        <div class="room-meta">
          <span class="participant-count">${room.participant_count} 人在线</span>
        </div>
        <div class="room-actions">
          <button class="btn-join" data-room-id="${room.id}">加入</button>
          ${
            room.owner_id === app.state.user.id || isAdmin
              ? `<button class="btn-delete" data-room-id="${room.id}">删除</button>`
              : ''
          }
        </div>
      </div>
    `
      )
      .join('');
  },

  init() {
    const isSuperAdmin = app.state.user.role === 'superadmin';

    // Logout
    document.getElementById('btn-logout').addEventListener('click', () => {
      app.logout();
    });

    // Profile
    document.getElementById('btn-profile').addEventListener('click', () => {
      window.location.hash = '#/profile';
    });

    // Manage Users (superadmin only)
    if (isSuperAdmin) {
      document.getElementById('btn-manage-users').addEventListener('click', () => {
        this._openUserManage();
      });
      document.getElementById('btn-manage-invites').addEventListener('click', () => {
        window.location.hash = '#/invites';
      });
    }

    // Create room modal
    const createBtn = document.getElementById('btn-create-room');
    const modal = document.getElementById('create-room-modal');
    const nameInput = document.getElementById('room-name-input');
    const confirmBtn = document.getElementById('btn-create-confirm');
    const cancelBtn = document.getElementById('btn-create-cancel');

    const openModal = () => {
      modal.classList.remove('hidden');
      nameInput.value = '';
      nameInput.focus();
    };
    const closeModal = () => modal.classList.add('hidden');

    createBtn.addEventListener('click', openModal);
    cancelBtn.addEventListener('click', closeModal);

    confirmBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      confirmBtn.disabled = true;
      try {
        await api.post('/api/rooms', { name });
        closeModal();
        await this._refreshRooms();
      } catch (e) {
        alert('创建房间失败：' + e.message);
      } finally {
        confirmBtn.disabled = false;
      }
    });

    // Enter key submits create
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click();
      if (e.key === 'Escape') closeModal();
    });

    // Close modal on overlay click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    // User management modal close
    if (isSuperAdmin) {
      const userModal = document.getElementById('user-manage-modal');
      document.getElementById('btn-user-manage-close').addEventListener('click', () => {
        userModal.classList.add('hidden');
      });
      userModal.addEventListener('click', (e) => {
        if (e.target === userModal) userModal.classList.add('hidden');
      });
    }

    // Bind room list actions (join / delete)
    this._bindRoomActions();

    // Periodic refresh every 5 seconds
    this._refreshInterval = setInterval(() => this._refreshRooms(), 5000);
  },

  async _openUserManage() {
    const modal = document.getElementById('user-manage-modal');
    const container = document.getElementById('user-list-container');
    modal.classList.remove('hidden');
    container.innerHTML = '<div class="loading">正在加载用户...</div>';

    try {
      const users = await api.get('/api/users');
      container.innerHTML = `
        <table class="user-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>用户名</th>
              <th>角色</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${users.map(u => this._renderUserRow(u)).join('')}
          </tbody>
        </table>
      `;

      // Bind role toggle buttons
      container.querySelectorAll('.btn-toggle-role').forEach(btn => {
        btn.addEventListener('click', async () => {
          const userId = Number(btn.dataset.userId);
          const currentRole = btn.dataset.currentRole;
          const newRole = currentRole === 'admin' ? 'user' : 'admin';
          try {
            await api.put(`/api/users/${userId}/role`, { role: newRole });
            await this._openUserManage(); // refresh
          } catch (e) {
            alert('修改角色失败：' + e.message);
          }
        });
      });
    } catch (e) {
      container.innerHTML = '<div class="error-msg">加载用户失败：' + escapeHtml(e.message) + '</div>';
    }
  },

  _renderUserRow(user) {
    const isSelf = user.id === app.state.user.id;
    const canToggle = user.role !== 'superadmin' && !isSelf;
    const actionLabel = user.role === 'admin' ? '降级为用户' : '提升为管理员';
    return `
      <tr class="${user.role === 'superadmin' ? 'tr-superadmin' : ''}">
        <td>${user.id}</td>
        <td>${escapeHtml(user.username)}${isSelf ? '（你）' : ''}</td>
        <td><span class="role-badge role-${user.role}">${escapeHtml(roleLabel(user.role))}</span></td>
        <td>${canToggle ? `<button class="btn-toggle-role btn-sm ${user.role === 'admin' ? 'btn-secondary' : 'btn-primary'}" data-user-id="${user.id}" data-current-role="${user.role}">${actionLabel}</button>` : '<span class="text-muted">—</span>'}</td>
      </tr>
    `;
  },

  _bindRoomActions() {
    const list = document.getElementById('room-list');
    if (!list) return;

    list.querySelectorAll('.btn-join').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.location.hash = `#/room/${btn.dataset.roomId}`;
      });
    });

    list.querySelectorAll('.btn-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('删除此房间？所有参与者将被移出。'))
          return;
        try {
          await api.del(`/api/rooms/${btn.dataset.roomId}`);
          await this._refreshRooms();
        } catch (e) {
          alert('删除房间失败：' + e.message);
        }
      });
    });
  },

  async _refreshRooms() {
    try {
      const rooms = await api.get('/api/rooms');
      const container = document.getElementById('room-list');
      if (!container) return;
      container.innerHTML = this._renderRoomList(rooms);
      this._bindRoomActions();
    } catch (e) {
      console.error('Room refresh failed', e);
    }
  },

  destroy() {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
    }
  },
};

// ---------------------------------------------------------------------------
// Profile page (#/profile) – nickname editing
// ---------------------------------------------------------------------------
window.profilePage = {
  render() {
    const u = app.state.user;
    return `
      <div class="lobby-container">
        <header class="lobby-header">
          <div class="lobby-header-left">
            <h1>个人设置</h1>
          </div>
          <div class="user-info">
            <button id="btn-back-lobby" class="btn-secondary btn-sm">返回大厅</button>
          </div>
        </header>

        <div class="auth-card" style="max-width:480px;margin:0 auto;">
          <div id="profile-error" class="error-msg hidden"></div>
          <div id="profile-success" class="success-msg hidden"></div>
          <div class="form-group">
            <label>用户名</label>
            <input type="text" value="${escapeHtml(u.username)}" disabled />
          </div>
          <div class="form-group">
            <label>角色</label>
            <input type="text" value="${escapeHtml(roleLabel(u.role))}" disabled />
          </div>
          <div class="form-group">
            <label for="profile-nickname">昵称</label>
            <input type="text" id="profile-nickname" maxlength="50" value="${escapeHtml(u.nickname || '')}" placeholder="请输入昵称" />
          </div>
          <div class="modal-actions" style="justify-content:flex-start;">
            <button id="btn-save-nickname" class="btn-primary">保存</button>
          </div>
        </div>
      </div>
    `;
  },

  init() {
    document.getElementById('btn-back-lobby').addEventListener('click', () => {
      window.location.hash = '#/lobby';
    });

    const errorEl = document.getElementById('profile-error');
    const successEl = document.getElementById('profile-success');
    const input = document.getElementById('profile-nickname');
    const btn = document.getElementById('btn-save-nickname');

    btn.addEventListener('click', async () => {
      const nickname = input.value.trim();
      errorEl.classList.add('hidden');
      successEl.classList.add('hidden');
      btn.disabled = true;
      try {
        const data = await api.patch('/api/users/me', { nickname });
        const updated = (data && data.user) ? data.user : data;
        if (updated && typeof updated === 'object') {
          // merge nickname (and other fields) into app.state.user
          if ('nickname' in updated) {
            app.state.user.nickname = updated.nickname;
          } else {
            app.state.user.nickname = nickname;
          }
        } else {
          app.state.user.nickname = nickname;
        }
        successEl.textContent = '昵称已保存';
        successEl.classList.remove('hidden');
      } catch (e) {
        errorEl.textContent = e.message || '保存失败';
        errorEl.classList.remove('hidden');
      } finally {
        btn.disabled = false;
      }
    });
  },

  destroy() {},
};
