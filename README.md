# Feishu OpenCode Bridge

本地常驻守护进程。

- 用飞书官方长连接接收消息
- 自动启动一个 `opencode serve`
- 首次聊天时扫描 `~/Projects` 下的子目录
- 在飞书里发项目列表卡片和按钮
- 点击按钮后，把当前聊天绑定到对应目录
- 后续消息直接进入该目录下的 `opencode session`

## 安装

```bash
cd /Users/jamesyu/Projects/feishu-opencode-bridge
npm install
cp .env.example .env
```

## `.env`

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_DOMAIN=Feishu
FEISHU_VERIFICATION_TOKEN=
FEISHU_ENCRYPT_KEY=
PROJECTS_ROOT=~/Projects
PROJECT_PAGE_SIZE=12
STATE_FILE_PATH=./data/state.json
GROUP_REQUIRE_MENTION=true
OPENCODE_SERVER_HOSTNAME=127.0.0.1
OPENCODE_SERVER_PORT=4096
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=
OPENCODE_SYSTEM_PROMPT=你正在通过飞书为当前项目提供支持，回复先给结果，再给必要细节。
```

如果你的 `opencode serve` 需要密码，就填 `OPENCODE_SERVER_PASSWORD`；桥接会自己启动它并自动走 Basic Auth。

## 启动

```bash
cd /Users/jamesyu/Projects/feishu-opencode-bridge
npm run dev
```

## 飞书开放平台配置

- 创建自建应用并开启 `Bot`
- 开启事件订阅
- 订阅 `im.message.receive_v1`
- 订阅 `card.action.trigger`
- 接入方式选择长连接
- 给应用开收消息、发消息权限

这版和 OpenClaw 一样，消息和卡片动作都走长连接，不需要单独卡片回调地址。

## 对话流程

1. 首次给机器人发消息
2. 机器人返回项目列表卡片
3. 点击项目按钮
4. 机器人绑定目录并自动处理你刚才那条消息
5. 后续继续聊即可

## 命令

```text
/switch    重新选项目
/status    查看当前绑定目录
/reset     清空当前 OpenCode 会话
/next      项目列表下一页
/prev      项目列表上一页
/search 关键词
```

## 说明

- 目录列表默认读取 `~/Projects` 的一级子目录
- 消息和卡片动作都走长连接事件
- 按钮能直接选项目；文本编号仍可作为兜底
- 选择结果和会话绑定会持久化到 `data/state.json`
