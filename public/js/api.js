// ---------------------------------------------------------------------------
// HTTP API wrapper
// ---------------------------------------------------------------------------
window.api = {
  token: null,

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    const res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  },

  get(path) {
    return this.request('GET', path);
  },
  post(path, body) {
    return this.request('POST', path, body);
  },
  put(path, body) {
    return this.request('PUT', path, body);
  },
  patch(path, body) {
    return this.request('PATCH', path, body);
  },
  del(path) {
    return this.request('DELETE', path);
  },
};

// ---------------------------------------------------------------------------
// HTML escape helper
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---------------------------------------------------------------------------
// WebSocket client
// ---------------------------------------------------------------------------
let ws = null;
let wsListeners = {}; // { eventType: [callback, ...] }
let wsToken = null;
let wsReconnectTimer = null;
let wsConnectHooks = []; // called each time WS opens (initial + reconnect)

/**
 * Connect (or re-connect) the WebSocket.
 * Returns a promise that resolves once the socket is open.
 * If already open the promise resolves immediately.
 */
async function connectWS(token) {
  if (ws && ws.readyState === WebSocket.OPEN && wsToken === token) return;

  wsToken = token;

  // Tear down previous socket if any
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ws = null;
  }

  return new Promise((resolve) => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${token}`);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const listeners = wsListeners[msg.type] || [];
        listeners.forEach((fn) => fn(msg));
      } catch (e) {
        console.warn('WS parse error', e);
      }
    };

    ws.onopen = () => {
      wsConnectHooks.forEach((fn) => fn());
      resolve();
    };

    ws.onclose = () => {
      // Auto-reconnect after 3 seconds
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(() => {
        if (wsToken) connectWS(wsToken);
      }, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  });
}

function addWSConnectHook(fn) {
  wsConnectHooks.push(fn);
  // Return an unsubscribe function
  return () => {
    wsConnectHooks = wsConnectHooks.filter((f) => f !== fn);
  };
}

function sendWS(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    console.warn('WS not connected – cannot send', msg);
  }
}

function onWS(type, callback) {
  if (!wsListeners[type]) wsListeners[type] = [];
  wsListeners[type].push(callback);
  // Return an unsubscribe function
  return () => offWS(type, callback);
}

function offWS(type, callback) {
  if (!wsListeners[type]) return;
  wsListeners[type] = wsListeners[type].filter((fn) => fn !== callback);
}

function disconnectWS() {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = null;
  wsToken = null;
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
    ws = null;
  }
  wsListeners = {};
}

// ---------------------------------------------------------------------------
// STUN server config for WebRTC
// 自部署 STUN 优先（与本站同源，需阿里云安全组放行 UDP/3478），
// 失败时回退到公共 STUN 防止 ICE 全军覆没。
// ---------------------------------------------------------------------------
const rtcConfig = {
  iceServers: [
    { urls: `stun:${window.location.hostname}:3478` },
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.qq.com:3478' },
  ],
};
