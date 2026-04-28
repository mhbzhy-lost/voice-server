// ---------------------------------------------------------------------------
// Room page – WebRTC voice room with device management & mute
// ---------------------------------------------------------------------------
window.roomPage = {
  // ---- state -----------------------------------------------------------
  roomId: null,
  roomData: null, // from GET /api/rooms/:id
  selfUserId: null,
  peers: new Map(), // remoteUserId → RTCPeerConnection
  localStream: null,
  remoteAudioElements: new Map(), // remoteUserId → HTMLAudioElement
  audioContext: null, // for level meter
  audioLevelRaf: null,
  _wsUnsubs: [], // onWS unsubscribe fns
  _muted: false,
  _participants: new Map(), // userId → {id, username, nickname, muted}

  // ---- render ----------------------------------------------------------
  async render(roomId) {
    this.roomData = null;
    try {
      const data = await api.get(`/api/rooms/${roomId}`);
      this.roomData = data.room;
    } catch (e) {
      // Room may not exist – we show a generic header and handle errors
      // during init
    }

    const roomName = this.roomData
      ? escapeHtml(this.roomData.name)
      : '未知房间';

    return `
      <div class="room-container">
        <header class="room-header">
          <button id="btn-back" class="btn-secondary btn-sm">&larr; 返回</button>
          <h2>${roomName}</h2>
          <button id="btn-delete-room" class="btn-danger btn-sm hidden">删除房间</button>
        </header>
        <div id="room-error" class="room-error hidden"></div>
        <div id="media-error-banner" class="media-error-banner hidden"></div>
        <div class="room-content">
          <div class="participants-panel">
            <h3>参与者</h3>
            <ul id="participant-list" class="participant-list">
              <li class="loading">连接中...</li>
            </ul>
          </div>
          <div class="controls-panel">
            <div class="audio-controls">
              <button id="btn-mute" class="btn-mute">&#x1F50A; 静音</button>
              <button id="btn-leave" class="btn-danger">离开房间</button>
            </div>
            <div class="device-controls">
              <div class="form-group">
                <label for="select-input">麦克风</label>
                <select id="select-input">
                  <option value="">加载中...</option>
                </select>
              </div>
              <div class="form-group">
                <label for="select-output">扬声器</label>
                <select id="select-output">
                  <option value="">加载中...</option>
                </select>
              </div>
            </div>
            <div class="audio-level">
              <label>音量</label>
              <div class="level-bar-container">
                <div id="level-bar" class="level-bar"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  // ---- init ------------------------------------------------------------
  async init(roomId) {
    this.roomId = roomId;
    this._participants = new Map();

    // Register WebSocket signalling handlers
    this._wsUnsubs.push(onWS('room-state', (m) => this._onRoomState(m)));
    this._wsUnsubs.push(onWS('user-joined', (m) => this._onUserJoined(m)));
    this._wsUnsubs.push(onWS('user-left', (m) => this._onUserLeft(m)));
    this._wsUnsubs.push(onWS('offer', (m) => this._onOffer(m)));
    this._wsUnsubs.push(onWS('answer', (m) => this._onAnswer(m)));
    this._wsUnsubs.push(onWS('ice-candidate', (m) => this._onIceCandidate(m)));
    this._wsUnsubs.push(onWS('user-muted', (m) => this._onUserMuted(m)));
    this._wsUnsubs.push(onWS('room-deleted', (m) => this._onRoomDeleted(m)));
    this._wsUnsubs.push(onWS('kicked', (m) => this._onKicked(m)));
    this._wsUnsubs.push(onWS('error', (m) => this._onError(m)));

    // --- UI event listeners ---

    // Back
    document.getElementById('btn-back').addEventListener('click', () => {
      this.leave();
      window.location.hash = '#/lobby';
    });

    // Leave
    document.getElementById('btn-leave').addEventListener('click', () => {
      this.leave();
      window.location.hash = '#/lobby';
    });

    // Mute
    document
      .getElementById('btn-mute')
      .addEventListener('click', () => this._toggleMute());

    // Delete room (only visible if owner / admin)
    document
      .getElementById('btn-delete-room')
      .addEventListener('click', async () => {
        if (!confirm('删除此房间？所有参与者将被移出。'))
          return;
        try {
          await api.del(`/api/rooms/${this.roomId}`);
          this.leave();
          window.location.hash = '#/lobby';
        } catch (e) {
          this._showError('删除房间失败：' + e.message);
        }
      });

    // Device selection
    document
      .getElementById('select-input')
      .addEventListener('change', (e) => this._switchInputDevice(e.target.value));
    document
      .getElementById('select-output')
      .addEventListener('change', (e) => this._switchOutputDevice(e.target.value));

    // Show delete button if user is owner or admin
    const isAdmin = app.state.user.role === 'admin' || app.state.user.role === 'superadmin';
    if (
      this.roomData &&
      (this.roomData.owner_id === app.state.user.id || isAdmin)
    ) {
      document.getElementById('btn-delete-room').classList.remove('hidden');
    }

    // --- Acquire media & join ---
    try {
      await this._initMedia();
      await this._enumerateDevices();
    } catch (e) {
      this._showMediaError(e);
    }

    // Register WS reconnect hook to rejoin room after disconnects
    this._reconnectHook = addWSConnectHook(() => {
      if (this.roomId) {
        sendWS({ type: 'join-room', roomId: this.roomId });
      }
    });

    await this._joinRoom();
  },

  // ---- destroy (called by router on navigation away) -------------------
  destroy() {
    this.leave();
  },

  // ---- leave (full cleanup) --------------------------------------------
  leave() {
    // Unsubscribe WS handlers
    this._wsUnsubs.forEach((fn) => fn());
    this._wsUnsubs = [];

    // Remove WS reconnect hook
    if (this._reconnectHook) {
      this._reconnectHook();
      this._reconnectHook = null;
    }

    // Tell the server we left
    sendWS({ type: 'leave-room' });

    // Close all peer connections
    this._closeAllPeers();

    // Stop local media
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }

    // Close audio context
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    // Cancel level meter animation frame
    if (this.audioLevelRaf) {
      cancelAnimationFrame(this.audioLevelRaf);
      this.audioLevelRaf = null;
    }

    // Remove remote audio elements from DOM
    this.remoteAudioElements.forEach((el) => {
      el.pause();
      el.srcObject = null;
      el.remove();
    });
    this.remoteAudioElements.clear();

    // Hide context menu if any
    this._hideContextMenu();

    this.roomId = null;
    this.roomData = null;
    this.selfUserId = null;
    this._muted = false;
    this._participants = new Map();
  },

  // ======================================================================
  //  MEDIA
  // ======================================================================

  async _initMedia(deviceId) {
    // Stop previous stream
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
    }

    const constraints = {
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      video: false,
    };

    this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    this._startAudioLevelMonitor();
  },

  _startAudioLevelMonitor() {
    if (this.audioContext) this.audioContext.close();
    if (this.audioLevelRaf) cancelAnimationFrame(this.audioLevelRaf);

    try {
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(this.localStream);
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const update = () => {
        analyser.getByteFrequencyData(dataArray);
        const avg =
          dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        const level = Math.min(1, avg / 128);
        const bar = document.getElementById('level-bar');
        if (bar) {
          bar.style.width = `${level * 100}%`;
        }
        this.audioLevelRaf = requestAnimationFrame(update);
      };
      update();
    } catch (e) {
      console.warn('Audio level monitor failed', e);
    }
  },

  async _enumerateDevices() {
    // Chrome needs an active getUserMedia call before enumerateDevices
    // returns labels.  initMedia() already ran, so this should work.
    let allDevices = [];
    try {
      allDevices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      return;
    }

    const inputs = allDevices.filter((d) => d.kind === 'audioinput');
    const outputs = allDevices.filter((d) => d.kind === 'audiooutput');

    const savedInputId = localStorage.getItem('voice_input_device');
    const savedOutputId = localStorage.getItem('voice_output_device');

    const inputSel = document.getElementById('select-input');
    const outputSel = document.getElementById('select-output');

    inputSel.disabled = false;
    inputSel.innerHTML = inputs
      .map(
        (d) =>
          `<option value="${d.deviceId}"${
            d.deviceId === savedInputId ? ' selected' : ''
          }>${escapeHtml(d.label || d.deviceId)}</option>`
      )
      .join('');

    outputSel.disabled = false;
    outputSel.innerHTML = outputs
      .map(
        (d) =>
          `<option value="${d.deviceId}"${
            d.deviceId === savedOutputId ? ' selected' : ''
          }>${escapeHtml(d.label || d.deviceId)}</option>`
      )
      .join('');

    // If we have a saved preferred input device, switch to it now
    if (savedInputId && inputs.some((d) => d.deviceId === savedInputId)) {
      // Already selected in dropdown; getUserMedia was called with the
      // saved device in initMedia if deviceId was passed.  If not, we
      // need to restart with the saved device.
      if (!this.localStream || !this.localStream.active) {
        await this._initMedia(savedInputId);
      }
    }

    // Apply saved output device to existing remote audio elements
    if (savedOutputId) {
      this.remoteAudioElements.forEach((el) => {
        if (el.setSinkId) {
          el.setSinkId(savedOutputId).catch(() => {});
        }
      });
    }
  },

  async _switchInputDevice(deviceId) {
    localStorage.setItem('voice_input_device', deviceId);
    try {
      await this._initMedia(deviceId);
    } catch (e) {
      this._showError('切换麦克风失败：' + e.message);
      return;
    }

    // Replace audio track in every established peer connection
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (!audioTrack) return;

    this.peers.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (sender) {
        sender.replaceTrack(audioTrack).catch(() => {});
      }
    });
  },

  async _switchOutputDevice(deviceId) {
    localStorage.setItem('voice_output_device', deviceId);
    this.remoteAudioElements.forEach((el) => {
      if (el.setSinkId) {
        el.setSinkId(deviceId).catch(() => {});
      }
    });
  },

  // ======================================================================
  //  ROOM JOINING
  // ======================================================================

  async _joinRoom() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      try {
        await connectWS(app.state.token);
      } catch (e) {
        this._showError('连接信令服务器失败');
        return;
      }
    }
    sendWS({ type: 'join-room', roomId: this.roomId });
  },

  // ======================================================================
  //  PEER CONNECTION
  // ======================================================================

  /**
   * Deterministic rule: the user with the *smaller* id always creates the
   * offer.  This avoids duplicate offer/answer races.
   */
  _shouldBeInitiator(remoteUserId) {
    return app.state.user.id < remoteUserId;
  },

  /**
   * Ensure a peer connection exists for |remoteUserId|.
   */
  _ensurePeerConnection(remoteUserId) {
    if (this.peers.has(remoteUserId)) {
      return this.peers.get(remoteUserId);
    }

    const pc = new RTCPeerConnection(rtcConfig);

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream);
      });
    }

    pc.ontrack = (event) => {
      let audioEl = this.remoteAudioElements.get(remoteUserId);
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.className = 'remote-audio';
        audioEl.dataset.remoteUserId = remoteUserId;
        audioEl.autoplay = true;
        audioEl.hidden = true;
        document.body.appendChild(audioEl);
        this.remoteAudioElements.set(remoteUserId, audioEl);

        const savedOutput = localStorage.getItem('voice_output_device');
        if (savedOutput && audioEl.setSinkId) {
          audioEl.setSinkId(savedOutput).catch(() => {});
        }
      }
      audioEl.srcObject = event.streams[0];
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendWS({
          type: 'ice-candidate',
          candidate: event.candidate,
          targetUserId: remoteUserId,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === 'disconnected' ||
        pc.connectionState === 'failed'
      ) {
        this._closePeerConnection(remoteUserId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (
        pc.iceConnectionState === 'disconnected' ||
        pc.iceConnectionState === 'failed'
      ) {
        this._closePeerConnection(remoteUserId);
      }
    };

    this.peers.set(remoteUserId, pc);
    return pc;
  },

  _establishPeerConnection(remoteUserId) {
    if (this.peers.has(remoteUserId)) return;

    this._ensurePeerConnection(remoteUserId);

    if (this._shouldBeInitiator(remoteUserId)) {
      this._sendOffer(remoteUserId);
    }
  },

  async _sendOffer(remoteUserId) {
    const pc = this.peers.get(remoteUserId);
    if (!pc) return;

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendWS({ type: 'offer', sdp: pc.localDescription, targetUserId: remoteUserId });
    } catch (e) {
      console.error('createOffer error for user', remoteUserId, e);
    }
  },

  _closePeerConnection(remoteUserId) {
    const pc = this.peers.get(remoteUserId);
    if (pc) {
      pc.close();
      this.peers.delete(remoteUserId);
    }

    const audioEl = this.remoteAudioElements.get(remoteUserId);
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
      audioEl.remove();
      this.remoteAudioElements.delete(remoteUserId);
    }

    this._removeParticipant(remoteUserId);
  },

  _closeAllPeers() {
    const ids = Array.from(this.peers.keys());
    ids.forEach((id) => this._closePeerConnection(id));
  },

  // ======================================================================
  //  WS EVENT HANDLERS
  // ======================================================================

  _onRoomState(msg) {
    const { users } = msg;

    // Identify self by matching username
    const self = users.find((u) => u.username === app.state.user.username);
    this.selfUserId = self ? self.id : null;

    // Cache participants
    this._participants = new Map();
    users.forEach((u) => this._participants.set(u.id, u));

    // Update participant list
    this._updateParticipantList(users);

    // Create peer connections for every existing user except ourselves
    users.forEach((u) => {
      if (u.id !== this.selfUserId) {
        this._establishPeerConnection(u.id);
      }
    });
  },

  _onUserJoined(msg) {
    const { user } = msg;
    this._participants.set(user.id, user);
    this._addParticipant(user, false);
    this._establishPeerConnection(user.id);
  },

  _onUserLeft(msg) {
    this._participants.delete(msg.userId);
    this._closePeerConnection(msg.userId);
  },

  async _onOffer(msg) {
    const { sdp, fromUserId, fromUsername, fromNickname } = msg;

    // Ensure user is in the participant list (may arrive before room-state
    // in edge cases)
    if (!this._participants.has(fromUserId)) {
      this._participants.set(fromUserId, {
        id: fromUserId,
        username: fromUsername,
        nickname: fromNickname,
        muted: false,
      });
    }
    this._addParticipant(this._participants.get(fromUserId), false);

    if (!this.peers.has(fromUserId)) {
      this._ensurePeerConnection(fromUserId);
    }

    const pc = this.peers.get(fromUserId);
    if (!pc) return;

    try {
      if (
        pc.signalingState !== 'stable' &&
        pc.signalingState !== 'have-local-offer'
      ) {
        return;
      }

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendWS({ type: 'answer', sdp: pc.localDescription, targetUserId: fromUserId });
    } catch (e) {
      console.error('handleOffer error', e);
    }
  },

  async _onAnswer(msg) {
    const { sdp, fromUserId } = msg;
    const pc = this.peers.get(fromUserId);
    if (!pc) return;

    try {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      }
    } catch (e) {
      console.error('handleAnswer error', e);
    }
  },

  async _onIceCandidate(msg) {
    const { candidate, fromUserId } = msg;
    const pc = this.peers.get(fromUserId);
    if (!pc || !candidate) return;

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      if (e.name !== 'InvalidStateError') {
        console.warn('addIceCandidate error', e);
      }
    }
  },

  _onUserMuted(msg) {
    const { userId, muted } = msg;
    if (this._participants.has(userId)) {
      this._participants.get(userId).muted = muted;
    }
    const el = document.querySelector(
      `.participant-item[data-user-id="${userId}"]`
    );
    if (el) {
      const icon = el.querySelector('.mute-icon');
      if (icon) icon.textContent = muted ? '\u{1F507}' : '\u{1F3A4}';
    }
  },

  _onRoomDeleted() {
    alert('该房间已被房主删除。');
    this.leave();
    window.location.hash = '#/lobby';
  },

  _onKicked(msg) {
    alert('你已被超级管理员移出房间');
    this.leave();
    window.location.hash = '#/lobby';
  },

  _onError(msg) {
    this._showError(msg.message || '未知错误');
  },

  // ======================================================================
  //  UI HELPERS
  // ======================================================================

  _displayName(u) {
    if (!u) return '';
    return u.nickname || u.username || '';
  },

  _participantHtml(u) {
    const isSelf = u.id === this.selfUserId;
    const name = this._displayName(u);
    return `<li class="participant-item${isSelf ? ' self' : ''}" data-user-id="${u.id}">
        <span class="participant-name">${escapeHtml(name)}${isSelf ? '（你）' : ''}</span>
        <span class="mute-icon">${u.muted ? '\u{1F507}' : '\u{1F3A4}'}</span>
      </li>`;
  },

  _updateParticipantList(users) {
    const list = document.getElementById('participant-list');
    if (!list) return;

    list.innerHTML = users.map((u) => this._participantHtml(u)).join('');
    this._bindParticipantContextMenu();
  },

  _addParticipant(userOrId, mutedOrUsername, mutedMaybe) {
    // Backward-compat: if called with (userId, username, muted)
    let user;
    if (typeof userOrId === 'object' && userOrId !== null) {
      user = userOrId;
    } else {
      user = {
        id: userOrId,
        username: mutedOrUsername,
        nickname: null,
        muted: !!mutedMaybe,
      };
    }
    if (!this._participants.has(user.id)) {
      this._participants.set(user.id, user);
    }

    const list = document.getElementById('participant-list');
    if (!list) return;
    if (document.querySelector(`.participant-item[data-user-id="${user.id}"]`))
      return;

    const wrapper = document.createElement('div');
    wrapper.innerHTML = this._participantHtml(user).trim();
    const li = wrapper.firstChild;
    list.appendChild(li);
    this._bindParticipantContextMenu();
  },

  _removeParticipant(userId) {
    const el = document.querySelector(
      `.participant-item[data-user-id="${userId}"]`
    );
    if (el) el.remove();
  },

  _toggleMute() {
    if (!this.localStream) return;
    const track = this.localStream.getAudioTracks()[0];
    if (!track) return;

    track.enabled = !track.enabled;
    this._muted = !track.enabled;

    const btn = document.getElementById('btn-mute');
    btn.textContent = this._muted ? '\u{1F507} 取消静音' : '\u{1F50A} 静音';
    btn.classList.toggle('muted', this._muted);

    sendWS({ type: 'mute-changed', muted: this._muted });

    if (this.selfUserId) {
      const el = document.querySelector(
        `.participant-item[data-user-id="${this.selfUserId}"]`
      );
      if (el) {
        const icon = el.querySelector('.mute-icon');
        if (icon)
          icon.textContent = this._muted ? '\u{1F507}' : '\u{1F3A4}';
      }
    }
  },

  _showError(msg) {
    const el = document.getElementById('room-error');
    if (el) {
      el.textContent = msg;
      el.classList.remove('hidden');
      clearTimeout(this._errorTimer);
      this._errorTimer = setTimeout(() => el.classList.add('hidden'), 6000);
    }
  },

  // ======================================================================
  //  MEDIA ERROR BANNER
  // ======================================================================

  _showMediaError(err) {
    const banner = document.getElementById('media-error-banner');
    if (!banner) return;

    let title = '麦克风初始化失败';
    let detail = (err && err.message) || '未知错误';

    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      title = '麦克风权限被拒绝';
      detail = '你拒绝了麦克风访问。请点击地址栏左侧 🔒 图标 → 站点权限 → 允许麦克风，然后点击重试。';
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      title = '未检测到麦克风设备';
      detail = '请连接一个麦克风后点击重试。';
    } else if (name === 'NotReadableError' || name === 'TrackStartError') {
      title = '麦克风被占用';
      detail = '麦克风可能正被其他应用使用，请关闭后点击重试。';
    } else if (name === 'OverconstrainedError') {
      title = '设备不满足约束';
      detail = '无法以指定参数访问麦克风，请重试或更换设备。';
    }

    banner.innerHTML = `
      <div class="media-error-title">${escapeHtml(title)}</div>
      <div class="media-error-detail">${escapeHtml(detail)}</div>
      <div class="media-error-actions">
        <button class="btn-primary btn-sm" id="btn-media-retry">重试</button>
        <button class="btn-secondary btn-sm" id="btn-media-dismiss">关闭</button>
      </div>
    `;
    banner.classList.remove('hidden');

    document.getElementById('btn-media-retry').addEventListener('click', async () => {
      try {
        await this._initMedia();
        await this._enumerateDevices();
        banner.classList.add('hidden');
        banner.innerHTML = '';

        // Replace tracks in existing peer connections
        const audioTrack = this.localStream && this.localStream.getAudioTracks()[0];
        if (audioTrack) {
          this.peers.forEach((pc) => {
            const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
            if (sender) {
              sender.replaceTrack(audioTrack).catch(() => {});
            } else {
              pc.addTrack(audioTrack, this.localStream);
            }
          });
        }
      } catch (e) {
        this._showMediaError(e);
      }
    });

    document.getElementById('btn-media-dismiss').addEventListener('click', () => {
      banner.classList.add('hidden');
      banner.innerHTML = '';
    });

    // Mark device dropdowns as unavailable
    const inputSel = document.getElementById('select-input');
    if (inputSel) {
      inputSel.innerHTML = '<option value="">麦克风不可用</option>';
      inputSel.disabled = true;
    }
  },

  // ======================================================================
  //  CONTEXT MENU (superadmin: kick user)
  // ======================================================================

  _bindParticipantContextMenu() {
    const list = document.getElementById('participant-list');
    if (!list) return;

    list.querySelectorAll('.participant-item').forEach((el) => {
      if (el.dataset.cmBound === '1') return;
      el.dataset.cmBound = '1';
      el.addEventListener('contextmenu', (e) => {
        const uid = Number(el.dataset.userId);
        if (!uid || uid === this.selfUserId) return;
        if (app.state.user.role !== 'superadmin') return;
        e.preventDefault();
        const u = this._participants.get(uid);
        const name = this._displayName(u) || ('#' + uid);
        this._showContextMenu(e.clientX, e.clientY, [
          {
            label: '踢出房间',
            danger: true,
            onClick: () => this._kickUser(uid, name),
          },
        ]);
      });
    });
  },

  _showContextMenu(x, y, items) {
    this._hideContextMenu();

    const ul = document.createElement('ul');
    ul.className = 'context-menu';

    items.forEach((it) => {
      const li = document.createElement('li');
      li.textContent = it.label;
      if (it.danger) li.classList.add('danger');
      li.addEventListener('click', () => {
        this._hideContextMenu();
        try {
          it.onClick();
        } catch (e) {
          console.error('context menu action error', e);
        }
      });
      ul.appendChild(li);
    });

    // Position off-screen first to measure
    ul.style.left = '-9999px';
    ul.style.top = '-9999px';
    document.body.appendChild(ul);

    const rect = ul.getBoundingClientRect();
    let left = x;
    let top = y;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (left + rect.width > vw) left = Math.max(0, x - rect.width);
    if (top + rect.height > vh) top = Math.max(0, y - rect.height);
    ul.style.left = left + 'px';
    ul.style.top = top + 'px';

    this._contextMenuEl = ul;

    const onDocClick = (ev) => {
      if (this._contextMenuEl && !this._contextMenuEl.contains(ev.target)) {
        this._hideContextMenu();
      }
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') this._hideContextMenu();
    };
    const onScroll = () => this._hideContextMenu();

    this._contextMenuCleanup = () => {
      document.removeEventListener('mousedown', onDocClick, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
  },

  _hideContextMenu() {
    if (this._contextMenuEl) {
      this._contextMenuEl.remove();
      this._contextMenuEl = null;
    }
    if (this._contextMenuCleanup) {
      this._contextMenuCleanup();
      this._contextMenuCleanup = null;
    }
  },

  async _kickUser(userId, nickname) {
    if (!confirm('确定要将 "' + nickname + '" 踢出房间？')) return;
    try {
      await api.post('/api/rooms/' + this.roomId + '/kick', { userId });
      // Server broadcasts user-left; no local action needed.
    } catch (e) {
      this._showError('踢出失败：' + (e.message || '未知错误'));
    }
  },
};
