require('dotenv').config();
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const {
  default: makeWASocket,
  DisconnectReason,
  useSingleFileAuthState,
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
const SESSION_ID = 'my-bot';

// Runtime state
let sock = null;
let isConnected = false;
let lastQrString = null;

// --- Supabase helpers for session persistence ---
/**
 * Load session data from Supabase wa_sessions table
 * @returns {Object|null} Session data object or null if not found
 */
async function loadSessionFromSupabase() {
  try {
    console.log('[Auth] Loading session from Supabase...');
    const { data, error } = await supabase
      .from('wa_sessions')
      .select('session_data')
      .eq('id', SESSION_ID)
      .maybeSingle();

    if (error) {
      console.error('[Supabase] loadSession error:', error.message);
      return null;
    }

    if (data?.session_data) {
      console.log('[Auth] Session data found in Supabase');
      return data.session_data;
    } else {
      console.log('[Auth] No existing session found in Supabase (first-time scan expected)');
      return null;
    }
  } catch (err) {
    console.error('[Auth] Failed to load session from Supabase:', err);
    return null;
  }
}

/**
 * Save session data to Supabase wa_sessions table
 * @param {Object} sessionData - The session data to save
 */
async function saveSessionToSupabase(sessionData) {
  try {
    console.log('[Auth] Saving session to Supabase...');
    const { error } = await supabase
      .from('wa_sessions')
      .upsert({ 
        id: SESSION_ID, 
        session_data: sessionData,
        updated_at: new Date().toISOString() 
      }, { onConflict: 'id' });

    if (error) {
      console.error('[Supabase] saveSession error:', error.message);
    } else {
      console.log('[Auth] Session successfully saved to Supabase');
    }
  } catch (err) {
    console.error('[Auth] Failed to save session to Supabase:', err);
  }
}

// --- WhatsApp init ---
async function initializeWhatsApp() {
  try {
    console.log('[WA] Initializing WhatsApp with Supabase session persistence...');
    
    // Load existing session from Supabase
    const savedSession = await loadSessionFromSupabase();
    
    // Initialize auth state with useSingleFileAuthState
    const { state, saveCreds } = useSingleFileAuthState(savedSession);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false, // we'll handle QR display ourselves
      browser: ['WhatsApp Web', 'Chrome', '1.0.0'],
      syncFullHistory: false,
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        lastQrString = qr;
        try {
          // Print QR to console for debugging
          const terminalQR = await QRCode.toString(qr, { type: 'terminal', small: true });
          console.log('\n📱 Scan this QR code with WhatsApp:');
          console.log(terminalQR);
          console.log('QR Code available at: GET /api/whatsapp/qr\n');
        } catch (e) {
          console.error('Failed to render QR in terminal:', e);
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('[WA] Connection closed. Code:', statusCode, 'Should reconnect:', shouldReconnect);
        isConnected = false;
        lastQrString = null;
        
        if (shouldReconnect) {
          console.log('[WA] Reconnecting in 3 seconds...');
          setTimeout(initializeWhatsApp, 3000);
        } else {
          console.log('[WA] Logged out. Session cleared.');
          // Clear session from Supabase when logged out
          await saveSessionToSupabase(null);
        }
      } else if (connection === 'open') {
        console.log('[WA] ✅ Connected to WhatsApp successfully!');
        isConnected = true;
        lastQrString = null;
      }
    });

    // Save credentials to Supabase whenever they update
    sock.ev.on('creds.update', async () => {
      try {
        console.log('[Auth] Credentials updated, saving to Supabase...');
        await saveCreds();
        // Get the current state and save to Supabase
        await saveSessionToSupabase(state.creds);
      } catch (e) {
        console.error('[Auth] creds.update handler error:', e);
      }
    });

  } catch (error) {
    console.error('[WA] Initialize error:', error);
    console.log('[WA] Retrying in 5 seconds...');
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
    console.log('[WA] Disconnecting WhatsApp...');
    
    if (sock) {
      await sock.logout();
    }
    
    sock = null;
    isConnected = false;
    lastQrString = null;

    // Clear session from Supabase
    try {
      await saveSessionToSupabase(null);
      console.log('[Auth] Session cleared from Supabase');
    } catch (e) {
      console.error('[Auth] Failed to clear session from Supabase:', e);
    }

    res.json({ success: true, message: 'WhatsApp disconnected and session cleared' });
  } catch (e) {
    console.error('[WA] Disconnect error:', e);
    res.status(500).json({ success: false, message: 'Failed to disconnect WhatsApp' });
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
