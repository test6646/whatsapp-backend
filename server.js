require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys');

// --- Basic server setup ---
const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

// --- Supabase client ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- Session persistence config ---
const TABLE = 'whatsapp_sessions';
const SESSION_ID = 'my-bot';
const AUTH_DIR = path.join('/tmp', `${SESSION_ID}-auth`); // for multi-file auth

// Runtime state
let sock = null;
let isConnected = false;
let lastQrString = null; // keep latest QR (if needed by endpoints/UI)

// Ensure /tmp and auth dir exist (Render provides /tmp)
try {
  fs.mkdirSync('/tmp', { recursive: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });
} catch (_) {}

// --- Supabase helpers for session persistence ---
async function ensureSessionRow() {
  // Creates the row if it doesn't exist yet
  const { error } = await supabase
    .from(TABLE)
    .upsert({ id: SESSION_ID, session_data: null, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) console.error('[Supabase] ensureSessionRow error:', error.message);
}

async function loadSessionFromSupabaseToDir() {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('session_data')
      .eq('id', SESSION_ID)
      .maybeSingle();

    if (error) {
      console.error('[Supabase] loadSession error:', error.message);
      return;
    }

    const files = data?.session_data?.files;
    if (files && typeof files === 'object') {
      // Recreate auth directory structure
      fs.mkdirSync(AUTH_DIR, { recursive: true });
      for (const relPath of Object.keys(files)) {
        const absPath = path.join(AUTH_DIR, relPath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, files[relPath], 'utf-8');
      }
      console.log('[Auth] Loaded session from Supabase into auth dir');
    } else {
      console.log('[Auth] No existing session found in Supabase (first-time scan expected)');
    }
  } catch (err) {
    console.error('[Auth] Failed to load session from Supabase:', err);
  }
}

function readDirFilesAsMap(dir, base = dir) {
  const map = {};
  if (!fs.existsSync(dir)) return map;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      Object.assign(map, readDirFilesAsMap(abs, base));
    } else {
      try {
        const content = fs.readFileSync(abs, 'utf-8');
        map[rel] = content;
      } catch (e) {
        console.warn('[Auth] Failed reading file for sync:', rel, e?.message);
      }
    }
  }
  return map;
}

async function syncSessionDirToSupabase() {
  try {
    const filesMap = readDirFilesAsMap(AUTH_DIR);
    const payload = { files: filesMap };

    const { error } = await supabase
      .from(TABLE)
      .upsert({ id: SESSION_ID, session_data: payload, updated_at: new Date().toISOString() }, { onConflict: 'id' });

    if (error) console.error('[Supabase] syncSession error:', error.message);
    else console.log('[Auth] Session synced to Supabase');
  } catch (err) {
    console.error('[Auth] Failed syncing session to Supabase:', err);
  }
}

// --- WhatsApp init ---
async function initializeWhatsApp() {
  try {
    await ensureSessionRow();
    await loadSessionFromSupabaseToDir();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false, // we'll render ourselves and send to UI
      browser: ['WhatsApp Web', 'Chrome', '1.0.0'],
      syncFullHistory: false,
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        lastQrString = qr;
        try {
          const terminalQR = await QRCode.toString(qr, { type: 'terminal', small: true });
          console.log('\nScan this QR with WhatsApp:');
          console.log(terminalQR);
        } catch (e) {
          console.error('Failed to render QR in terminal:', e);
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('[WA] Connection closed. Code:', statusCode, 'Reconnect:', shouldReconnect);
        isConnected = false;
        if (shouldReconnect) setTimeout(initializeWhatsApp, 3000);
      } else if (connection === 'open') {
        console.log('[WA] Connected');
        isConnected = true;
        lastQrString = null;
      }
    });

    // Persist creds + sync to Supabase every time they change
    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        await syncSessionDirToSupabase();
      } catch (e) {
        console.error('[Auth] creds.update handler error:', e);
      }
    });
  } catch (error) {
    console.error('[WA] initialize error:', error);
    setTimeout(initializeWhatsApp, 5000);
  }
}

// --- Express routes (kept minimal and compatible) ---
app.get('/', (req, res) => {
  res.json({ message: 'WhatsApp Backend API running', connected: isConnected });
});

app.get('/api/whatsapp/status', (req, res) => {
  res.json({ isConnected, hasQR: !!lastQrString });
});

// Return latest QR as a data URL for the frontend to render
app.get('/api/whatsapp/qr', async (req, res) => {
  try {
    if (!lastQrString) return res.status(404).json({ success: false, message: 'QR not available yet' });
    const dataUrl = await QRCode.toDataURL(lastQrString, { margin: 1, scale: 8 });
    return res.json({ success: true, qrCode: dataUrl });
  } catch (e) {
    console.error('qr endpoint error:', e);
    return res.status(500).json({ success: false, message: 'Failed to render QR' });
  }
});

app.post('/api/whatsapp/generate-qr', async (req, res) => {
  try {
    if (!sock) await initializeWhatsApp();

    // We don't force regeneration; Baileys emits a new QR periodically.
    // Here we just return a hint; actual QR is printed in the server console.
    res.json({ success: true, message: 'QR printed in server console', hasQR: !!lastQrString });
  } catch (e) {
    console.error('generate-qr error:', e);
    res.status(500).json({ success: false, message: 'Failed to start WhatsApp' });
  }
});

app.post('/api/whatsapp/send-message', async (req, res) => {
  try {
    const { number, message } = req.body;
    if (!sock || !isConnected) return res.status(400).json({ success: false, message: 'WhatsApp not connected' });
    if (!number || !message) return res.status(400).json({ success: false, message: 'number and message required' });

    const jid = number.replace(/[+\s-]/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (e) {
    console.error('send-message error:', e);
    res.status(500).json({ success: false, message: 'Failed to send message' });
  }
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    if (sock) await sock.logout();
    sock = null;
    isConnected = false;
    lastQrString = null;

    // Clear local auth dir but keep Supabase row (so first scan can recreate)
    try {
      if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(AUTH_DIR, { recursive: true });
      await supabase
        .from(TABLE)
        .upsert({ id: SESSION_ID, session_data: null, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    } catch (e) {
      console.error('[Auth] cleanup after disconnect error:', e);
    }

    res.json({ success: true, message: 'Disconnected' });
  } catch (e) {
    console.error('disconnect error:', e);
    res.status(500).json({ success: false, message: 'Failed to disconnect' });
  }
});

// --- Server start ---
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Initializing WhatsApp...');
  initializeWhatsApp();
});

// --- Graceful shutdown ---
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  try {
    if (sock) await sock.logout();
  } catch (_) {}
  process.exit(0);
});
