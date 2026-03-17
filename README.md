# Radio Claude v2.6

A live DX cluster monitor with AI commentary, built for the amateur radio shack. Connects to a DX cluster via telnet, filters incoming spots for DX-worthy callsigns, and provides real-time AI analysis of each spot — including band conditions, workability from your grid, OTA activations, and propagation context pulled live from [hamqsl.com](https://www.hamqsl.com).

Powered by [Claude Haiku](https://www.anthropic.com) via the Anthropic API.

---

## Features

- Connects to DX cluster nodes (auto-rotates through a list if one drops)
- Filters spots by band, DX prefix patterns, and a personal watchlist
- AI commentary on each spot — workability, bearing/distance, solar conditions
- Live solar/propagation data injected into every spot and propagation query
- Rolling 60-minute spot buffer — ask "what's on 20m?" and get real answers
- Natural language memory — say "remember this: ..." and it saves permanently
- First-run setup wizard — enter your callsign, grid, and API key once
- Standalone Windows `.exe` — no Node.js install needed to run

---

## Running from source

**Requirements:** Node.js 20+, an Anthropic API key

```
npm install
node radio-claude.js
```

On first run you'll be prompted for your callsign, grid square, and API key. These are saved to `config.json` in the same folder. Delete `config.json` to re-run setup.

You can also set your API key as an environment variable instead — it takes priority over `config.json`:

```
set ANTHROPIC_API_KEY=sk-ant-...
node radio-claude.js
```

---

## Building the standalone .exe

Requires [Node.js](https://nodejs.org) installed on the build machine.

```
npm install
npm run build
```

Output: `dist/radio-claude.exe`

Copy `memory.txt` alongside the `.exe` if you want to pre-load station knowledge. Otherwise it starts with an empty memory and you can build it up with the `learn` command or natural language triggers.

---

## Commands

| Command | Description |
|---|---|
| `watch <CALL>` | Add a callsign to the watchlist (loud alert) |
| `unwatch <CALL>` | Remove from watchlist |
| `watchlist` | Show current watchlist |
| `sh/dx [n]` | Request last n spots from the cluster |
| `status` | Connection and session info |
| `spot <call> <kHz> [comment]` | Post a spot to the cluster |
| `learn <fact>` | Save a permanent fact to memory.txt |
| `solar` | Show current solar/propagation data |
| `clear` | Clear AI conversation history |
| `help` | Show command list |

Anything else is sent to Radio Claude as a chat message.

---

## Natural language memory

Say any of the following and the fact gets saved to `memory.txt` permanently (active on next restart) and acknowledged by Radio Claude:

- `remember this: 15m antenna is out of action`
- `make sure you remember I'm running 50W today`
- `remember that VY0ERC goes QRT on 1 April`

---

## memory.txt

A plain text file loaded into Radio Claude's context at startup. One fact per line. Lines starting with `#` are comments and ignored. Edit it directly or add to it with the `learn` command / memory triggers.

---

## Sharing the .exe

The `.exe` is self-contained — no Node.js needed. To share with another operator:

1. Copy `dist/radio-claude.exe` to them
2. Optionally include a blank `memory.txt` (or let them start fresh — it's created automatically)
3. They run it and enter their own callsign, grid, and Anthropic API key on first launch

Each user's `config.json` and `memory.txt` live next to their `.exe` and are theirs alone.

---

## API key

Get an Anthropic API key at [console.anthropic.com](https://console.anthropic.com). Radio Claude uses `claude-haiku-4-5` — fast and inexpensive for continuous monitoring.

---

## Licence

Personal use. Not affiliated with Anthropic, ARRL, or any cluster network.
