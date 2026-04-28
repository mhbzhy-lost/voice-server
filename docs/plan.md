# 在线语音工具 — 实现方案

## 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 后端 | Node.js + Express | 成熟、WebSocket 好搭配、部署简单 |
| 数据库 | SQLite (better-sqlite3) | 零配置单文件 |
| 实时传输 | WebSocket (ws) + 服务端中转 | **零外部依赖**，不依赖任何 STUN/TURN/Google 服务 |
| 前端 | 原生 HTML/CSS/JS (SPA) | 工具型，无需框架 |
| 音频 | getUserMedia + AudioContext + PCM | 浏览器原生 API，服务器纯PCM转发 |
| 部署 | node 直启 | 私服部署 |

## 音频架构（服务端中转）

```
麦克风 → getUserMedia → AudioContext → ScriptProcessorNode → PCM Float32
→ WebSocket → 服务器转发 → WebSocket → AudioBuffer → destination
```

- **不依赖任何外部服务**：无 STUN、无 TURN、无 Google
- 服务端只做 PCM 数据扇出转发，不做编解码
- 全部音频流经服务器，适用于任意网络环境

## 数据模型

```
users: id | username | password(bcrypt) | role('admin'|'user') | created_at
rooms: id | name | owner_id→users | created_at
```

## API 设计

```
POST /api/auth/register   {username, password} → {user, session}
POST /api/auth/login      {username, password} → {user, session}
POST /api/auth/logout     → {ok}
GET  /api/auth/me         → {user} | 401
GET  /api/rooms           → [{id, name, owner, participant_count}]
POST /api/rooms           {name} → {room}
DELETE /api/rooms/:id     → {ok} (仅房主/admin)
PUT  /api/rooms/:id/owner {userId} → {ok} (仅admin)
GET  /api/users           → [{id, username, role}] (仅admin)
```

## WebSocket 协议（JSON 文本消息）

```
Client → Server:
  {type:"join", roomId:N}
  {type:"leave"}
  {type:"mute", muted:bool}
  {type:"audio", data:"<base64 PCM Float32>"}

Server → Client:
  {type:"room-state", users:[{id,username,muted}]}
  {type:"user-joined", user:{id,username}}
  {type:"user-left", userId:N}
  {type:"user-muted", userId:N, muted:bool}
  {type:"audio", userId:N, username:"", data:"<base64 PCM Float32>"}
  {type:"room-deleted", roomId:N}
  {type:"error", message:""}
```

## 目录结构

```
voice-server/
├── server.js             # 主入口：Express + WS + HTTP
├── db.js                 # SQLite 初始化
├── auth.js               # Session 认证中间件
├── routes/
│   ├── auth.js
│   ├── users.js
│   └── rooms.js
├── ws/
│   └── handler.js        # WS 连接处理 + 音频转发
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── app.js        # 页面路由/状态
│       ├── api.js        # HTTP API 封装
│       ├── pages/
│       │   ├── login.js
│       │   ├── lobby.js
│       │   └── room.js
│       └── audio.js      # 音频采集 + 播放
└── docs/plan.md
```

## 实现顺序

### 第一轮：前后端骨架 + 用户系统 + 房间管理
- Express 服务器、SQLite、注册/登录、房间 CRUD
- 前端登录/注册/大厅页面

### 第二轮：WebSocket 音频中继 + 语音房间
- WS 信令 + PCM 转发
- 音频采集/播放 + 设备选择

### 第三轮：完善
- 在线人数、权限、静音控制
