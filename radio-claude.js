#!/usr/bin/env node
'use strict';

const net      = require('net');
const readline = require('readline');
const Anthropic = require('@anthropic-ai/sdk');

const fs   = require('fs');
const path = require('path');

// ─── Base directory (next to .exe when packaged, __dirname otherwise) ─────────
const isPkg   = typeof process.pkg !== 'undefined';
const BASE_DIR = isPkg ? path.dirname(process.execPath) : __dirname;

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG_FILE  = path.join(BASE_DIR, 'config.json');
const MEMORY_FILE  = path.join(BASE_DIR, 'memory.txt');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return null; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

async function promptSetup() {
  const tmpRl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask   = q => new Promise(res => tmpRl.question(q, ans => res(ans.trim())));

  // Muted ask for the API key — suppress echoed characters
  const askMuted = q => new Promise(res => {
    process.stdout.write(q);
    let val = '';
    const onData = ch => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        res(val.trim());
      } else if (ch === '\u0003') {
        process.exit();
      } else if (ch === '\u007f') {
        if (val.length) { val = val.slice(0, -1); process.stdout.write('\b \b'); }
      } else {
        val += ch;
        process.stdout.write('*');
      }
    };
    tmpRl.pause();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
  });

  console.log(`\n${C.cyan}${C.bold}First-run setup${C.reset}`);
  console.log(`${C.grey}Your answers are saved to config.json next to this program.${C.reset}\n`);

  const callsign = (await ask(`  Your callsign  (e.g. 2D0PEY) : `)).toUpperCase();
  const grid     = (await ask(`  Grid square    (e.g. IO74RE)  : `)).toUpperCase();
  const apiKey   = await askMuted(`  Anthropic API key            : `);

  tmpRl.close();

  if (!callsign || !grid || !apiKey) {
    console.log(`\n${C.red}All fields are required. Please try again.${C.reset}\n`);
    return promptSetup();
  }

  const cfg = { callsign, grid, apiKey };
  saveConfig(cfg);
  console.log(`\n${C.green}Config saved to ${CONFIG_FILE}${C.reset}`);
  console.log(`${C.grey}Delete config.json to re-run setup.${C.reset}\n`);
  return cfg;
}

// ─── Persistent knowledge base ────────────────────────────────────────────────
function loadMemory() {
  try {
    return fs.readFileSync(MEMORY_FILE, 'utf8')
      .split('\n')
      .filter(l => l.trim() && !l.trim().startsWith('#'))
      .join('\n');
  } catch { return ''; }
}

function appendMemory(fact) {
  const line = fact.trim();
  if (!line) return false;
  fs.appendFileSync(MEMORY_FILE, '\n' + line);
  return true;
}

// Natural language memory triggers
const MEMORY_TRIGGER = /\b(remember this|make sure you remember|remember that)\b/i;

function extractMemoryFact(input) {
  const m = input.match(/\b(?:remember this|make sure you remember|remember that)[:\s-]*(.*)/i);
  return m ? m[1].trim() : null;
}

// ─── Model ────────────────────────────────────────────────────────────────────
const MODEL = 'claude-haiku-4-5';   // fast + cheap for continuous monitoring

// ─── Runtime state (populated after config loads) ─────────────────────────────
let MY_CALL;
let MY_GRID;
let client;
let SYSTEM;

// Watchlist — always alert loudly
const watchlist = new Set();

// ─── Cluster nodes ────────────────────────────────────────────────────────────
const CLUSTERS = [
  { host: '81.174.245.245',      port: 9000 },  // GB7HTL (UK) alt port
  { host: '81.174.245.245',      port: 7300 },  // GB7HTL (UK)
  { host: 'dxspider.iw9fra.com', port: 7300 },  // IW9FRA (Italy)
  { host: 'dxc.ka3nam.com',      port: 7300 },  // KA3NAM (USA)
  { host: 'ik4pkl.ddns.net',     port: 7300 },  // IK4PKL (Italy)
  { host: 'dxcluster.pl',        port: 7300 },  // SR4DXC (Poland)
  { host: 'dxc.sv5fri.eu',       port: 7300 },  // SV5FRI (Greece)
  { host: 'iz5ilu.ns0.it',       port: 7300 },  // IZ5ILU (Italy)
];
let clusterIdx = 0;

// ─── Band plan ────────────────────────────────────────────────────────────────
const MY_BANDS = new Set(['160m','80m','40m','30m','20m','17m','15m','12m','10m','6m']);

// ─── DX-worthy prefixes ───────────────────────────────────────────────────────
const DX_PATTERNS = [
  /^VK/, /^ZL/, /^JA?\d/, /^J[R-S]\d/,
  /^(K|W|N)\d/, /^[KWN][A-Z]\d/, /^A[A-L]/,
  /^(VE|VA|VO|VY)/,
  /^(PY|PP|PW|PX|PQ)/, /^LU/, /^CE/, /^CX/, /^YV/,
  /^ZS/, /^ZD/, /^VP/, /^VQ/, /^ZB/,
  /^4X/, /^4Z/, /^5B/,
  /^VU/, /^BY/, /^BA/, /^BG/, /^BH/,
  /^UA9/, /^UA0/, /^R[0-9]A/, /^RW9/, /^RA9/, /^RA0/,
  /^TF/, /^OY/, /^9Y/, /^HH/, /^CM/, /^CO/,
  /^(UN|UO)/, /^EP/, /^A4/, /^HZ/, /^7Z/,
  /^9A[0-9].*\/P/,   // Croatian islands
  /^SV5/, /^SV9/,   // Dodecanese / Crete
  /^IG9/, /^IT9/,   // African Italy
];

function isDX(call) {
  if (watchlist.has(call)) return 'WATCHLIST';
  for (const rx of DX_PATTERNS) if (rx.test(call)) return 'DX';
  return null;
}

function freqToBand(khz) {
  const mhz = khz / 1000;
  if (mhz >= 1.8   && mhz < 2.0)   return '160m';
  if (mhz >= 3.5   && mhz < 4.0)   return '80m';
  if (mhz >= 7.0   && mhz < 7.35)  return '40m';
  if (mhz >= 10.1  && mhz < 10.15) return '30m';
  if (mhz >= 14.0  && mhz < 14.35) return '20m';
  if (mhz >= 18.06 && mhz < 18.17) return '17m';
  if (mhz >= 21.0  && mhz < 21.45) return '15m';
  if (mhz >= 24.89 && mhz < 24.99) return '12m';
  if (mhz >= 28.0  && mhz < 29.7)  return '10m';
  if (mhz >= 50.0  && mhz < 54.0)  return '6m';
  if (mhz >= 144   && mhz < 148)   return '2m';
  return null;
}

// ─── Spot parser ──────────────────────────────────────────────────────────────
// DX de K4WSB:     7258.0  W1AW/4       VA                             2335Z 16 Mar
function parseSpot(line) {
  const m = line.match(/^DX de\s+(\S+):\s+([\d.]+)\s+(\S+)\s*(.*?)\s+(\d{4}Z)/i);
  if (!m) return null;
  const freq = parseFloat(m[2]);
  return {
    spotter  : m[1].replace(/:$/, ''),
    freqKhz  : freq,
    dx       : m[3].toUpperCase(),
    comment  : m[4].trim(),
    time     : m[5],
    band     : freqToBand(freq),
  };
}

// ─── Colours ──────────────────────────────────────────────────────────────────
const C = {
  reset   : '\x1b[0m',
  bold    : '\x1b[1m',
  red     : '\x1b[31m',
  green   : '\x1b[32m',
  yellow  : '\x1b[33m',
  cyan    : '\x1b[36m',
  magenta : '\x1b[35m',
  blue    : '\x1b[34m',
  grey    : '\x1b[90m',
};

// ─── Terminal helpers ─────────────────────────────────────────────────────────
let rl;

function bgPrint(text) {
  process.stdout.write('\r\x1b[K');
  process.stdout.write(text + '\n');
  if (rl) rl.prompt(true);
}

// ─── Solar / propagation data ─────────────────────────────────────────────────
let solarCache     = null;
let solarCacheTime = 0;
const SOLAR_TTL_MS = 15 * 60_000;

async function fetchSolarData() {
  if (solarCache && Date.now() - solarCacheTime < SOLAR_TTL_MS) return solarCache;
  try {
    const res = await fetch('https://www.hamqsl.com/solarxml.php',
                            { signal: AbortSignal.timeout(8000) });
    const xml = await res.text();
    const tag = name => { const m = xml.match(new RegExp(`<${name}[^>]*>([^<]*)<\/${name}>`)); return m ? m[1].trim() : '?'; };
    const bands = [...xml.matchAll(/<band name="([^"]+)" time="([^"]+)">([^<]+)<\/band>/g)]
      .map(m => `${m[1]} ${m[2]}: ${m[3]}`).join(' | ');
    solarCache = {
      sfi: tag('solarflux'), aindex: tag('aindex'), kindex: tag('kindex'),
      sunspots: tag('sunspots'), xray: tag('xray'), geofield: tag('geomagfield'),
      bands, updated: tag('updated'),
    };
    solarCacheTime = Date.now();
    return solarCache;
  } catch { return null; }
}

function formatSolar(s) {
  if (!s) return '(solar data unavailable)';
  return `SFI=${s.sfi} | A-index=${s.aindex} | K-index=${s.kindex} | Sunspots=${s.sunspots} | X-ray=${s.xray} | Geomag field=${s.geofield}\nBand conditions: ${s.bands}\nData: ${s.updated}`;
}

const PROP_KEYWORDS = /\b(prop|propagat|band|open|path|workable|skip|muf|sfi|solar|k.?index|aurora|condition|signal|noise|ionos)\b/i;

// ─── Rolling spot buffer (ALL spots, last 60 min) ────────────────────────────
const rawSpotBuffer = [];
const BUFFER_MAX_MS = 60 * 60_000;

function addToBuffer(spot) {
  rawSpotBuffer.push({ ...spot, ts: Date.now() });
  const cutoff = Date.now() - BUFFER_MAX_MS;
  while (rawSpotBuffer.length && rawSpotBuffer[0].ts < cutoff) rawSpotBuffer.shift();
}

function getRecentSpots(minutes) {
  const cutoff = Date.now() - minutes * 60_000;
  return rawSpotBuffer.filter(s => s.ts >= cutoff);
}

function formatSpotsForClaude(spots) {
  if (!spots.length) return '(no spots in buffer for that window)';
  return spots.map(s => {
    const band = s.band || `${(s.freqKhz / 1000).toFixed(3)}MHz`;
    return `${s.time}  ${s.dx.padEnd(12)}  ${band.padEnd(5)}  ${s.freqKhz}kHz  via ${s.spotter}${s.comment ? '  "' + s.comment + '"' : ''}`;
  }).join('\n');
}

function extractSpotQuery(input) {
  const l = input.toLowerCase();
  const spotsKeywords = /\b(spot|spots|spotted|activity|active|bands?|what'?s on|what is on|recent|show me|dx|cluster|heard|decoded|frequency|freq)\b/;
  if (!spotsKeywords.test(l)) return null;
  const minMatch = l.match(/(\d+)\s*min/);
  return minMatch ? parseInt(minMatch[1]) : 15;
}

async function buildUserPrompt(input) {
  let prompt = input;
  const minutes = extractSpotQuery(input);
  if (minutes !== null) {
    const spots = getRecentSpots(minutes);
    prompt += `\n\n[LIVE CLUSTER DATA — last ${minutes} min, ${spots.length} spot(s)]\n${formatSpotsForClaude(spots)}`;
  }
  if (PROP_KEYWORDS.test(input)) {
    const solar = await fetchSolarData();
    prompt += `\n\n[LIVE SOLAR DATA]\n${formatSolar(solar)}`;
  }
  return prompt;
}

// ─── Claude conversation ──────────────────────────────────────────────────────
const history  = [];
let   busy     = false;
const spotQueue = [];

async function askClaude(content, isSpot = false) {
  if (busy && isSpot) { spotQueue.push(content); return; }

  busy = true;
  history.push({ role: 'user', content });

  // Animate a thinking indicator while waiting for the full response
  let dots = 0;
  const spinner = setInterval(() => {
    dots = (dots % 3) + 1;
    process.stdout.write(`\r\x1b[K${C.yellow}[Radio Claude]${C.reset} thinking${'.'.repeat(dots)}`);
  }, 400);

  try {
    const msg = await client.messages.create({
      model      : MODEL,
      max_tokens : 400,
      system     : SYSTEM,
      messages   : history,
    });

    const reply = msg.content[0]?.text ?? '';
    history.push({ role: 'assistant', content: reply });

    clearInterval(spinner);
    process.stdout.write('\r\x1b[K');   // clear thinking line
    bgPrint(`${C.yellow}[Radio Claude]${C.reset} ${reply}`);

  } catch (err) {
    clearInterval(spinner);
    process.stdout.write('\r\x1b[K');
    bgPrint(`${C.red}[Error]${C.reset} ${err.message}`);
  } finally {
    busy = false;
    if (rl) rl.prompt(true);
    if (spotQueue.length > 0) {
      const next = spotQueue.shift();
      setTimeout(() => askClaude(next, true), 800);
    }
  }
}

// ─── Spot handler ─────────────────────────────────────────────────────────────
const seenSpots = new Map();

async function handleSpot(spot) {
  if (!spot) return;
  if (spot.band && !MY_BANDS.has(spot.band)) return;

  const kind = isDX(spot.dx);
  if (!kind) return;

  const key  = `${spot.dx}|${spot.band}`;
  const last = seenSpots.get(key) || 0;
  if (Date.now() - last < 600_000) return;
  seenSpots.set(key, Date.now());

  const bandStr  = spot.band || `${(spot.freqKhz / 1000).toFixed(3)} MHz`;
  const isWatch  = kind === 'WATCHLIST';
  const otaMatch = spot.comment.match(/\b(POTA|SOTA|IOTA|WWFF|BOTA|LOTA|COTA|MOTA|ROTA|GOTA|GMA)\b/i);
  const otaRef   = spot.comment.match(/\b([A-Z]{1,4}-\d{4,5})\b/);
  const isOTA    = !!otaMatch;
  const prefix   = isWatch
    ? `${C.red}${C.bold}[** WATCHLIST **]${C.reset}`
    : isOTA
      ? `${C.magenta}[${otaMatch[1].toUpperCase()}${otaRef ? ' ' + otaRef[1] : ''}]${C.reset}`
      : `${C.green}[DX SPOT]${C.reset}`;

  bgPrint(
    `${prefix} ${C.bold}${spot.dx}${C.reset} on ${C.cyan}${bandStr}${C.reset}` +
    ` · spotted by ${spot.spotter} @ ${spot.time}` +
    (spot.comment ? `\n           ${C.grey}${spot.comment}${C.reset}` : '')
  );

  const mode    = spot.comment.match(/\b(FT8|FT4|SSB|CW|RTTY|PSK)\b/i)?.[1] || '';
  const solar   = await fetchSolarData();
  const otaNote = isOTA ? ` This is a ${otaMatch[1].toUpperCase()} activation${otaRef ? ' (' + otaRef[1] + ')' : ''} — flag as time-limited.` : '';
  const prompt  =
    `NEW DX SPOT — ${spot.dx} on ${bandStr}${mode ? ' ' + mode : ''}, spotted by ${spot.spotter}. ` +
    `Comment: "${spot.comment || 'none'}". Time: ${spot.time}.${otaNote}\n` +
    `[LIVE SOLAR DATA]\n${formatSolar(solar)}\n` +
    `Is this workable from ${MY_GRID} right now? Reference the solar data. Brief (2-3 lines).`;

  askClaude(prompt, true);
}

// ─── DX Cluster connection ────────────────────────────────────────────────────
let socket   = null;
let rxBuf    = '';
let loggedIn = false;

function connectCluster() {
  const node = CLUSTERS[clusterIdx % CLUSTERS.length];
  bgPrint(`${C.blue}[Cluster]${C.reset} Connecting to ${node.host}:${node.port}...`);

  socket = new net.Socket();
  socket.setEncoding('utf8');
  socket.setTimeout(90_000);

  socket.connect(node.port, node.host, () => {
    bgPrint(`${C.blue}[Cluster]${C.reset} Connected to ${node.host}`);
    setTimeout(() => {
      if (!loggedIn && socket && !socket.destroyed) {
        socket.write(MY_CALL + '\r\n');
        loggedIn = true;
        bgPrint(`${C.blue}[Cluster]${C.reset} Sent callsign ${MY_CALL} — watching for DX...`);
      }
    }, 1500);
  });

  socket.on('data', data => {
    rxBuf += data;
    const lines = rxBuf.split(/\r?\n/);
    rxBuf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t || !loggedIn) continue;
      if (/^DX de /i.test(t)) {
        const spot = parseSpot(t);
        if (spot) addToBuffer(spot);
        handleSpot(spot);
      }
    }
  });

  socket.on('timeout', () => { socket.write('SH/DX 1\r\n'); });

  socket.on('close', () => {
    loggedIn = false;
    clusterIdx++;
    bgPrint(`${C.blue}[Cluster]${C.reset} Disconnected. Trying next node in 20s...`);
    setTimeout(connectCluster, 20_000);
  });

  socket.on('error', err => {
    bgPrint(`${C.red}[Cluster error]${C.reset} ${err.message}`);
    socket.destroy();
  });
}

// ─── Built-in commands ────────────────────────────────────────────────────────
function handleCommand(input) {
  const parts = input.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();

  if (cmd === 'watch' && parts[1]) {
    const call = parts[1].toUpperCase();
    watchlist.add(call);
    bgPrint(`${C.green}[Watch]${C.reset} Added ${call} to watchlist.`);
    return true;
  }
  if (cmd === 'unwatch' && parts[1]) {
    const call = parts[1].toUpperCase();
    watchlist.delete(call);
    bgPrint(`${C.green}[Watch]${C.reset} Removed ${call} from watchlist.`);
    return true;
  }
  if (cmd === 'watchlist') {
    bgPrint(`${C.green}[Watchlist]${C.reset} ${[...watchlist].join(', ') || '(empty)'}`);
    return true;
  }
  if (cmd === 'status') {
    const clusterState = !socket || socket.destroyed ? 'disconnected'
                       : loggedIn ? 'connected + logged in'
                       : 'connected (awaiting login)';
    bgPrint(
      `${C.cyan}[Status]${C.reset}\n` +
      `  Callsign: ${MY_CALL}  Grid: ${MY_GRID}\n` +
      `  Cluster : ${clusterState} (${CLUSTERS[clusterIdx % CLUSTERS.length].host})\n` +
      `  Buffer  : ${rawSpotBuffer.length} spots stored\n` +
      `  DX seen : ${seenSpots.size} unique DX this session\n` +
      `  Chat    : ${Math.floor(history.length / 2)} turns`
    );
    return true;
  }
  if (cmd === 'debug') {
    bgPrint(`${C.grey}[Debug] loggedIn=${loggedIn} | socket=${socket ? (socket.destroyed ? 'destroyed' : 'alive') : 'null'} | bufLen=${rawSpotBuffer.length} | rxBuf="${rxBuf.slice(0,80)}"`);
    return true;
  }
  if (cmd === 'sh/dx' || cmd === 'sh') {
    const n = parseInt(parts[1]) || 10;
    if (socket && !socket.destroyed) {
      socket.write(`SH/DX ${n}\r\n`);
      bgPrint(`${C.grey}[Cluster]${C.reset} Requested last ${n} spots...`);
    } else {
      bgPrint(`${C.red}[Cluster]${C.reset} Not connected.`);
    }
    return true;
  }
  if (cmd === 'spot') {
    const spotParts = parts.slice(1).filter(p => !/^(on|at|freq|frequency)$/i.test(p));
    if (spotParts.length < 2) {
      bgPrint(`${C.yellow}[Spot]${C.reset} Usage: spot <callsign> <freq-kHz> [comment]\n  e.g.  spot VY0ERC 14074 FT8 heard weak ${MY_GRID}`);
      return true;
    }
    const dxCall  = spotParts[0].toUpperCase();
    const freq    = parseFloat(spotParts[1]);
    const comment = spotParts.slice(2).join(' ') || `de ${MY_CALL}`;
    if (isNaN(freq)) {
      bgPrint(`${C.red}[Spot]${C.reset} Frequency must be in kHz, e.g. 14074`);
      return true;
    }
    if (!socket || socket.destroyed || !loggedIn) {
      bgPrint(`${C.red}[Spot]${C.reset} Not connected to cluster.`);
      return true;
    }
    socket.write(`DX ${freq.toFixed(1)} ${dxCall} ${comment}\r\n`);
    bgPrint(`${C.green}[Spot sent]${C.reset} ${C.bold}${dxCall}${C.reset} on ${freq} kHz — "${comment}"`);
    return true;
  }
  if (cmd === 'learn') {
    const fact = parts.slice(1).join(' ').trim();
    if (!fact) { bgPrint(`${C.yellow}[Memory]${C.reset} Usage: learn <fact>  — or just say "remember this: <fact>"`); return true; }
    if (appendMemory(fact)) {
      bgPrint(`${C.green}[Memory]${C.reset} Saved: "${fact}"\n         (written to memory.txt — active next restart)`);
    }
    return true;
  }
  if (cmd === 'solar') {
    fetchSolarData().then(s => bgPrint(`${C.cyan}[Solar]${C.reset}\n  ${formatSolar(s).replace(/\n/g, '\n  ')}`));
    return true;
  }
  if (cmd === 'clear') {
    history.length = 0;
    bgPrint(`${C.grey}[Radio Claude]${C.reset} Conversation history cleared.`);
    return true;
  }
  if (cmd === 'help') {
    bgPrint(
      `${C.cyan}Commands:${C.reset}\n` +
      `  watch <CALL>   — add callsign to watchlist\n` +
      `  unwatch <CALL> — remove from watchlist\n` +
      `  watchlist      — show current watchlist\n` +
      `  sh/dx [n]      — show n recent spots from cluster\n` +
      `  status         — connection + session info\n` +
      `  spot <call> <kHz> [comment] — post a spot to the cluster\n` +
      `  learn <fact>   — save a fact to memory.txt (or just say "remember this: ...")\n` +
      `  clear          — clear Radio Claude conversation history\n` +
      `  help           — show this\n` +
      `  Anything else  — chat with Radio Claude`
    );
    return true;
  }
  return false;
}

// ─── Entry point ──────────────────────────────────────────────────────────────
async function main() {
  console.clear();
  console.log(
    `${C.green}${C.bold}` +
    `╔══════════════════════════════════════════════╗\n` +
    `║          RADIO CLAUDE  v2.5                  ║\n` +
    `║      DX Monitor + AI Assistant               ║\n` +
    `╚══════════════════════════════════════════════╝` +
    `${C.reset}\n`
  );

  // ── Load or create config ──
  let cfg = loadConfig();
  if (!cfg || !cfg.callsign || !cfg.apiKey) {
    cfg = await promptSetup();
    console.clear();
    console.log(
      `${C.green}${C.bold}` +
      `╔══════════════════════════════════════════════╗\n` +
      `║          RADIO CLAUDE  v2.5                  ║\n` +
      `║      DX Monitor + AI Assistant               ║\n` +
      `╚══════════════════════════════════════════════╝` +
      `${C.reset}\n`
    );
  }

  MY_CALL = cfg.callsign;
  MY_GRID = cfg.grid || 'unknown';
  client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || cfg.apiKey });

  // Default watchlist entry for 2D0PEY — won't appear for other callsigns
  if (MY_CALL === '2D0PEY') watchlist.add('VY0ERC');

  SYSTEM = `You are Radio Claude, the AI assistant sitting at the radio desk of ${MY_CALL}.

OPERATOR MEMORY (loaded from memory.txt — treat as ground truth):
${loadMemory()}

Callsign : ${MY_CALL}
Grid     : ${MY_GRID}

Watchlist (shout loudly for these): ${[...watchlist].join(', ') || '(none)'}

You are connected live to a DX cluster (telnet). All spots received this session are
buffered and injected into your context automatically when the operator asks about them —
look for the [LIVE CLUSTER DATA] block in the message. Use it to answer accurately.
If no cluster data is present, say so rather than guessing.

CALLSIGN IDENTIFICATION RULES — be precise, do not guess:
- K/W/N + digit (K4X, W1AW, N5XX etc.)  → USA. Genuine DX from most of Europe.
- KA/KB/KC/KD/KE/KF/KG/KH/KI/KJ/KK/KM/KN/KO/KP/KR/KS/KT/KU/KV/KW/KX/KY/KZ + digit → USA.
- AA-AL prefix → USA
- KG4 (exactly, with no suffix or 2-letter suffix) → Guantanamo Bay (rare). KG4XX (3+ letter suffix) → USA.
- KH6 → Hawaii. KH2 → Guam. KH0 → Mariana Is. KL7/AL → Alaska. KP4 → Puerto Rico. KP2 → USVI.
- VE/VA/VO/VY → Canada (not rare). VY0 → Nunavut/Arctic (very rare).
- G/M/2E/M0/G0 etc → England. GM/MM → Scotland. GW/MW → Wales. GI/MI → N.Ireland.
- F + digit or letter → France. DL/DA-DK/DO → Germany. I + digit → Italy.
- When in doubt about a callsign's country, say so rather than guessing wrongly.

OTA ACTIVATIONS — when a spot comment contains POTA/SOTA/IOTA/WWFF/BOTA etc.:
- Mention it's an activation and what the programme is (POTA=Parks, SOTA=Summits, IOTA=Islands, WWFF=Flora & Fauna, GOTA=Gateways, BOTA=Bunkers, LOTA=Lighthouses, COTA=Castles etc.)
- Include the reference number if present (e.g. US-1065)
- These are often time-limited so flag as worth chasing promptly

CLUSTER COMMENT ABBREVIATIONS:
- "FT2" in a spot comment = FT4 (some cluster software abbreviates it)
- "FT8", "SSB", "CW", "RTTY", "PSK" are as written
- Frequency suffixes like "df 1234" = audio offset in Hz on the waterfall

Your personality: knowledgeable, enthusiastic about amateur radio, concise at the desk.

When reporting DX spots:
- Lead with callsign and country/entity
- Say which band and whether it's likely workable from ${MY_GRID} right now
- For WATCHLIST callsigns say "** WATCHLIST ALERT **" first
- Estimate rough bearing/distance from the operator's grid where useful
- Keep it to 2-4 lines

When the operator chats with you:
- Be conversational and helpful
- Reference the current session (spots seen, bands active, etc.) where relevant
- Use proper ham radio terminology
- Keep answers concise unless detail is asked for

ACRONYMS — always explain any abbreviations or acronyms in spot comments that the operator might not know:
- In spot commentary, if the comment contains abbreviations (WAS, ATNO, QRP, QRO, QSB, QRN, QRM, NCDXF, IOTA, POTA etc.) briefly explain what they mean in brackets
- Examples: "WAS (Worked All States)", "QRP (low power, under 5W)", "ATNO (All Time New One — first ever contact with that entity)", "QSB (signal fading)", "QRN (static/noise)", "QRM (interference)"
- Don't explain obvious ones like FT8, SSB, CW unless asked`;

  console.log(`${C.grey}Callsign: ${MY_CALL}  Grid: ${MY_GRID}  Model: ${MODEL}  |  Type 'help' for commands  |  Ctrl+C to exit${C.reset}\n`);

  fetchSolarData().then(s => s && bgPrint(`${C.cyan}[Solar]${C.reset} SFI=${s.sfi} A=${s.aindex} K=${s.kindex} — ${s.bands}`));
  connectCluster();

  rl = readline.createInterface({
    input    : process.stdin,
    output   : process.stdout,
    prompt   : `${C.cyan}${MY_CALL}>${C.reset} `,
    terminal : true,
  });

  rl.prompt();

  rl.on('line', async line => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // Natural language memory triggers — save fact AND let Claude acknowledge
    if (MEMORY_TRIGGER.test(input)) {
      const fact = extractMemoryFact(input);
      if (fact) {
        appendMemory(fact);
        bgPrint(`${C.green}[Memory]${C.reset} Saved: "${fact}"`);
      }
    }

    if (!handleCommand(input)) {
      askClaude(await buildUserPrompt(input));
    } else {
      rl.prompt();
    }
  });

  rl.on('close', () => {
    console.log(`\n${C.green}73 de ${MY_CALL}! Radio Claude signing off.${C.reset}\n`);
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log(`\n${C.green}73 de ${MY_CALL}! Radio Claude signing off.${C.reset}\n`);
    if (socket) socket.destroy();
    process.exit(0);
  });
}

main();
