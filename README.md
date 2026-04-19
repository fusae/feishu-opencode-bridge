# Feishu OpenCode Bridge

把飞书 Bot 消息转发给 `opencode serve`，再把结果回发到飞书。

## 功能

- 接收飞书事件订阅消息
- 按 `chat_id -> project -> session` 维护会话
- 支持一个桥接服务挂多个 OpenCode Server
- 内置简单命令：`/projects`、`/bind`、`/status`、`/reset`

## 目录

- `src/index.ts`：HTTP 入口和消息路由
- `src/feishu.ts`：飞书 token 和消息发送
- `src/opencode.ts`：OpenCode SDK 调用
- `src/state.ts`：本地状态持久化
- `config/projects.example.json`：多项目配置样例

## 环境要求

- Node.js 22+
- 一个飞书自建应用 Bot
- 一个或多个 `opencode serve`

## 安装

```bash
npm install
cp .env.example .env
cp config/projects.example.json config/projects.json
```

## `.env`

```env
PORT=3000
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_BASE_URL=https://open.feishu.cn
FEISHU_VERIFICATION_TOKEN=
GROUP_REQUIRE_MENTION=true
PROJECTS_CONFIG_PATH=./config/projects.json
STATE_FILE_PATH=./data/state.json
```

## `config/projects.json`

```json
{
  "defaultProjectKey": "demo",
  "projects": [
    {
      "key": "demo",
      "name": "Demo Project",
      "baseUrl": "http://127.0.0.1:4096",
      "directory": "/absolute/path/to/project",
      "username": "opencode",
      "password": "",
      "systemPrompt": "你正在通过飞书为这个项目提供支持，回复先给结果，再给必要细节。"
    }
  ]
}
```

如果 `opencode serve` 开了 `OPENCODE_SERVER_PASSWORD`，这里填 `username/password` 即可，桥接会自动走 HTTP Basic Auth。

## 启动 OpenCode

```bash
cd /absolute/path/to/project
OPENCODE_SERVER_PASSWORD=secret opencode serve --hostname 127.0.0.1 --port 4096
```

## 启动桥接

```bash
npm run dev
```

生产构建：

```bash
npm run build
npm start
```

## 飞书配置

- 创建自建应用并开启 `Bot`
- 事件订阅地址指向 `POST /feishu/events`
- 订阅 `im.message.receive_v1`
- 给应用开收消息和发消息权限
- 这个最小版默认按明文事件处理，先不要开启事件加密

## 聊天命令

```text
/projects
/bind demo
/unbind
/status
/reset
```

## 路由规则

- 如果配置了 `defaultProjectKey`，未绑定会话会直接走默认项目
- 如果没配置默认项目，先用 `/bind <projectKey>` 绑定
- 同一个 `chat_id` 串行处理，避免同一 session 并发写入
