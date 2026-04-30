// ---------------------------------------------------------------------------
// 用户偏好同步：localStorage 与服务器双写
// localStorage 用作即时缓存；服务器是跨 origin/跨设备的 source of truth
// ---------------------------------------------------------------------------

window.prefs = {
  SYNCED_KEYS: [
    'voice_input_volume',
    'voice_output_volume',
    'voice_peer_volumes',
    'voice_audio_prefs',
  ],
  _pendingTimers: {}, // key → setTimeout id

  // 登录后调用：从服务器拉所有 synced 偏好覆盖到 localStorage
  async hydrate() {
    try {
      const data = await api.get('/api/users/me/preferences');
      const remote = (data && data.preferences) || {};
      for (const key of this.SYNCED_KEYS) {
        if (remote[key] !== undefined) {
          // 后端返回原始字符串；直接写 localStorage，与前端历史读法兼容
          localStorage.setItem(key, remote[key]);
        }
      }
    } catch (e) {
      console.warn('[prefs] hydrate failed', e);
    }
  },

  // 设置一个偏好：立即写 localStorage（即时反馈）+ debounced 推服务器
  set(key, value) {
    const stringValue = (typeof value === 'string') ? value : JSON.stringify(value);
    try { localStorage.setItem(key, stringValue); } catch {}

    // 仅 SYNCED_KEYS 推服务器
    if (!this.SYNCED_KEYS.includes(key)) return;

    // 600ms debounce per key（拖滑块时不会每帧推）
    if (this._pendingTimers[key]) clearTimeout(this._pendingTimers[key]);
    this._pendingTimers[key] = setTimeout(() => {
      delete this._pendingTimers[key];
      api.put(`/api/users/me/preferences/${encodeURIComponent(key)}`, { value: stringValue })
        .catch((e) => console.warn(`[prefs] sync ${key} failed`, e));
    }, 600);
  },

  // 读：直接从 localStorage（已被 hydrate 覆盖过）
  get(key) {
    return localStorage.getItem(key);
  },
};
