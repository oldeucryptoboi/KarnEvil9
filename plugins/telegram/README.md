# Setting Up Telegram for KarnEvil9

Talk to your KarnEvil9 instance from Telegram. Send it tasks, watch it work, approve permissions — all from your phone.

## Quick Start

### Step 1: Create Your Bot

Open Telegram and search for **@BotFather**. Start a chat and send:

```
/newbot
```

BotFather will ask you for a display name (e.g. "My EDDIE Bot") and a username (must end in `bot`, e.g. `my_eddie_bot`). When it's done, you'll get a token like this:

```
123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
```

Copy it — you'll need it in a moment.

### Step 2: Get Your User ID

Search for **@userinfobot** in Telegram and send it any message. It replies with your numeric user ID:

```
Id: 987654321
```

You'll use this to tell KarnEvil9 who's allowed to talk to the bot.

### Step 3: Add to Your Environment

Add these to your KarnEvil9 `.env` file (or however you manage environment variables):

```sh
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
TELEGRAM_ALLOWED_USERS=987654321
```

Multiple users? Comma-separate their IDs:

```sh
TELEGRAM_ALLOWED_USERS=987654321,111222333,444555666
```

### Step 4: Restart KarnEvil9

```sh
pnpm build
pm2 restart all
```

### Step 5: Test It

Open a DM with your bot in Telegram and send any message. You should get a confirmation prompt:

> Run this task?
>
> "your message here"
>
> Reply YES to confirm or NO to cancel.

You can also check from the command line:

```sh
curl http://localhost:3100/api/plugins/telegram/status
# → { "connected": true, "activeSessions": 0, ... }
```

That's it — you're connected.

---

## Choosing Who Can Use the Bot

There are two ways to control access. Pick whichever fits your situation.

### Option A: Allowlist (you know your users upfront)

Set `TELEGRAM_ALLOWED_USERS` with the user IDs. Only those users can interact with the bot. Everyone else is silently ignored.

```sh
TELEGRAM_ALLOWED_USERS=987654321,111222333
```

This is the default when `TELEGRAM_ALLOWED_USERS` is set.

### Option B: Pairing (let users request access)

Leave `TELEGRAM_ALLOWED_USERS` empty (or don't set it at all). When someone DMs the bot, they'll get a pairing code:

> You're not yet authorized.
>
> Your pairing code: A3K7WN
>
> Share this code with the admin to get approved. It expires in 1 hour.

As the admin, you approve or deny from the command line:

```sh
# See who's waiting
curl http://localhost:3100/api/plugins/telegram/pairing

# Approve someone
curl -X POST http://localhost:3100/api/plugins/telegram/pairing/A3K7WN/approve

# Deny someone
curl -X POST http://localhost:3100/api/plugins/telegram/pairing/A3K7WN/deny
```

The user gets a Telegram message telling them the result. If approved, they can immediately start sending tasks.

**Note:** Pairing approvals last until KarnEvil9 restarts. To make them permanent, add the user's ID to `TELEGRAM_ALLOWED_USERS`.

You can also force pairing mode while keeping some pre-approved users:

```sh
TELEGRAM_ALLOWED_USERS=987654321
TELEGRAM_DM_POLICY=pairing
```

---

## Using the Bot

### Sending a Task

1. DM any text to the bot — it becomes the task instruction
2. The bot asks you to confirm (reply **YES** or **NO**)
3. On YES, KarnEvil9 starts an agentic session

### Watching Progress

While a session runs, you'll see a single message that updates in place as steps complete:

```
📋 Plan accepted — 3 steps
⚙️ Running search...
✅ search
⚙️ Running respond...
```

When the session finishes (or fails), you get a separate final message.

### Approving Permissions

If a step needs elevated permissions, the bot asks you:

```
🔒 Permission requested
Tool: file-write
Step: write-config
Scopes: fs:write

Reply with:
  1 = Allow once
  2 = Allow session
  3 = Deny
```

Just reply with the number.

### Commands

These work in the chat and also appear in Telegram's command menu (the `/` button):

| Command | What it does |
|---|---|
| `/status` | Show active sessions |
| `/cancel` | Cancel the current session |
| `/help` | List available commands |

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot API token from BotFather |
| `TELEGRAM_ALLOWED_USERS` | No | (empty) | Comma-separated numeric Telegram user IDs |
| `TELEGRAM_DM_POLICY` | No | (auto) | `"allowlist"` if `TELEGRAM_ALLOWED_USERS` is set, `"pairing"` if empty |

---

## API Endpoints

All under `http://<host>:3100/api/plugins/telegram/`.

| Endpoint | Description |
|---|---|
| `GET status` | Connection status, active session count, DM policy |
| `GET conversations` | List active chat sessions |
| `GET pairing` | List pending pairing requests |
| `POST pairing/:code/approve` | Approve a user's pairing code |
| `POST pairing/:code/deny` | Deny a user's pairing code |

---

## Troubleshooting

**Bot doesn't respond to messages**

- Verify the token: `curl http://localhost:3100/api/plugins/telegram/status` should show `"connected": true`
- If you set `TELEGRAM_ALLOWED_USERS`, make sure your user ID is in the list (check with @userinfobot)
- Make sure you're DMing the bot, not messaging it in a group

**I approved a user via pairing but they still can't send tasks**

- The code may have expired (1 hour TTL). Ask them to DM the bot again for a fresh code.
- Check `curl .../api/plugins/telegram/pairing` — if their code isn't listed, it already expired.

**Bot commands don't appear in Telegram's menu**

- They're registered on startup. Restart KarnEvil9 and reopen the chat. Telegram's UI may take a moment to update.
- You can always type `/help` directly — it works regardless of the menu.

**"No TELEGRAM_BOT_TOKEN set" in logs**

- The plugin is installed but can't find the token. Double-check your `.env` file or environment configuration.
- If using pm2, make sure the env vars are in your ecosystem config, not just your shell.
