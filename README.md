# Feishu OpenCode Bridge

Connect a Feishu bot to [OpenCode](https://opencode.ai/) with:

- Feishu persistent connection mode
- interactive project picker from your configured projects root
- per-chat directory binding
- per-chat OpenCode session reuse

This project is useful when you want to talk to different local codebases from Feishu without manually switching directories in a terminal.

## How It Works

1. A user sends a message to the Feishu bot.
2. If the chat is not bound yet, the bridge scans `PROJECTS_ROOT` and sends a project picker card.
3. After a project is selected, the chat is bound to that directory.
4. The bridge starts or reuses one OpenCode session for that chat and directory.
5. Later messages in the same chat continue in the same session.

## Features

- Feishu message events via persistent connection
- Feishu card action events via persistent connection
- project selection buttons with pagination
- fallback text commands for switching and searching
- one OpenCode server process managed by the bridge
- one OpenCode session per Feishu chat

## Requirements

- Node.js 22+
- `opencode` installed and available in `PATH`
- a Feishu self-built app with bot capability enabled

## Installation

```bash
git clone https://github.com/fusae/feishu-opencode-bridge.git
cd feishu-opencode-bridge
npm install
cp .env.example .env
```

## Configuration

Edit `.env`:

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_DOMAIN=Feishu
FEISHU_VERIFICATION_TOKEN=
FEISHU_ENCRYPT_KEY=
PROJECTS_ROOT=/path/to/projects
PROJECT_PAGE_SIZE=12
STATE_FILE_PATH=./data/state.json
GROUP_REQUIRE_MENTION=true
OPENCODE_SERVER_HOSTNAME=127.0.0.1
OPENCODE_SERVER_PORT=4096
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=
OPENCODE_SYSTEM_PROMPT=You are helping with the currently bound project. Give the answer first, then the necessary detail.
```

Notes:

- `PROJECTS_ROOT` is scanned for first-level subdirectories.
- `GROUP_REQUIRE_MENTION=true` means the bot only reacts when mentioned in group chats.
- `OPENCODE_SERVER_PASSWORD` is optional. If set, the bridge uses HTTP Basic Auth when talking to `opencode serve`.

## Run

Development:

```bash
npm run dev
```

Production:

```bash
npm run build
npm start
```

## Feishu App Setup

In the Feishu developer console:

1. Create a self-built app.
2. Enable `Bot`.
3. Enable events and callbacks.
4. Choose persistent connection mode.
5. Subscribe to:
   - `im.message.receive_v1`
   - `card.action.trigger`
6. Grant message receive/send permissions required by your app.

No separate public webhook endpoint is required for this bridge.

## Chat Commands

```text
/switch    Open the project picker again
/status    Show the currently bound directory
/reset     Reset the current OpenCode session for this chat
/session   List sessions for the current project
/session current
/session new
/session use <id|index>
/session delete <id|index>
/next      Next page in the project picker
/prev      Previous page in the project picker
/search x  Filter projects by keyword
```

Command notes:

- `/switch`: clear the current chat binding and reopen the project picker
- `/status`: show the current project directory and active session id
- `/reset`: drop the active session binding for the chat and let the next message start a fresh session
- `/session`: list recent sessions in the current project
- `/session current`: show the currently active session id
- `/session new`: create and switch to a new session in the current project
- `/session use <id|index>`: switch to an existing session by full id, id prefix, or list index
- `/session delete <id|index>`: delete a session by full id, id prefix, or list index
- `/next` and `/prev`: paginate the project picker
- `/search x`: filter the project picker by keyword

Example session flow:

```text
/session
/session new
/session use 2
/session delete ses_xxx
```

## State

Runtime state is stored in:

```text
data/state.json
```

It keeps:

- chat -> directory binding
- chat -> session binding
- pending selector state
- processed message/card tokens for deduplication

## Current Behavior

- one Feishu chat maps to one project directory
- one Feishu chat maps to one OpenCode session inside that directory
- messages in the same chat are processed serially to preserve session order
- project picker uses buttons, with text-command fallback still available

## Troubleshooting

If the bot does not reply:

- confirm the Feishu app is using persistent connection mode
- confirm both `im.message.receive_v1` and `card.action.trigger` are subscribed
- confirm `opencode` is installed and callable from the shell
- confirm `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are correct
- inspect bridge logs from `npm run dev`

If replies are slow:

- the bridge waits for OpenCode to finish before replying
- messages from the same chat are queued in order
- large repositories or tool-heavy prompts may take noticeably longer
