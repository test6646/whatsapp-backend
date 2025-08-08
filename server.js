require('dotenv').config();
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');

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
let reconnectAttempts = 0;
let sessionSaveTimeout = null;
let lastSessionSave = 0;

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

    // CRITICAL FIX: Check for both data existence AND valid session_data
    if (data && data.session_data && typeof data.session_data === 'object') {
      console.log('[Auth] Valid session data found in Supabase:', Object.keys(data.session_data));
      return data.session_data;
    } else {
      console.log('[Auth] No valid session found in Supabase - data:', data);
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
    // CRITICAL FIX: Validate session data before saving
    if (!sessionData || typeof sessionData !== 'object') {
      console.error('[Auth] Invalid session data - cannot save to Supabase:', sessionData);
      return;
    }

    console.log('[Auth] Saving session to Supabase with keys:', Object.keys(sessionData));
    const { error } = await supabase
      .from('wa_sessions')
      .upsert({ 
        id: SESSION_ID, 
        session_data: sessionData,
        updated_at: new Date().toISOString() 
      }, { onConflict: 'id' });

    if (error) {
      console.error('[Supabase] saveSession error:', error.message, error.details);
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
    
    // Create a temporary session directory
    const sessionDir = './wa_session';
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    
    // Initialize auth state with useMultiFileAuthState
    let { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    // CRITICAL FIX: Load existing session from Supabase and restore it properly
    const savedSession = await loadSessionFromSupabase();
    if (savedSession && savedSession.creds) {
      console.log('[Auth] Restoring session from Supabase...');
      try {
        // Write credentials file
        if (savedSession.creds) {
          fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(savedSession.creds, null, 2));
          console.log('[Auth] ✅ Restored creds.json');
        }
        
        // Write all key files
        if (savedSession.keys && typeof savedSession.keys === 'object') {
          Object.entries(savedSession.keys).forEach(([key, value]) => {
            if (value && typeof value === 'object') {
              fs.writeFileSync(path.join(sessionDir, `${key}.json`), JSON.stringify(value, null, 2));
              console.log('[Auth] ✅ Restored', key + '.json');
            }
          });
        }
        
        console.log('[Auth] ✅ Session files restored successfully');
        
        // FIXED: Reinitialize auth state to load the restored session
        const restored = await useMultiFileAuthState(sessionDir);
        // Replace the state and saveCreds function with restored ones
        Object.assign(state, restored.state);
        saveCreds = restored.saveCreds;
        
      } catch (e) {
        console.error('[Auth] ❌ Failed to restore session files:', e);
        // Clear corrupted session from Supabase
        await supabase.from('wa_sessions').delete().eq('id', SESSION_ID);
        console.log('[Auth] Cleared corrupted session from Supabase');
      }
    } else {
      console.log('[Auth] No valid session to restore - starting fresh');
    }

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
        
        // Handle specific error codes
        if (statusCode === 440) {
          console.log('[WA] ⚠️ Session conflict detected (Error 440) - Another device may be using this account');
          reconnectAttempts++;
          
          if (reconnectAttempts > 3) {
            console.log('[WA] 🛑 Too many conflict errors. Clearing session and stopping reconnection.');
            await supabase.from('wa_sessions').delete().eq('id', SESSION_ID);
            return;
          }
          
          // Wait longer for conflicts
          const backoffDelay = Math.min(30000 * reconnectAttempts, 120000); // 30s, 60s, 90s, max 2min
          console.log(`[WA] Waiting ${backoffDelay/1000}s before retry due to conflict...`);
          setTimeout(initializeWhatsApp, backoffDelay);
          return;
        }
        
        if (shouldReconnect) {
          reconnectAttempts++;
          const backoffDelay = Math.min(3000 * reconnectAttempts, 30000); // Exponential backoff, max 30s
          console.log(`[WA] Reconnecting in ${backoffDelay/1000}s... (attempt ${reconnectAttempts})`);
          setTimeout(initializeWhatsApp, backoffDelay);
        } else {
          console.log('[WA] Logged out. Session cleared.');
          reconnectAttempts = 0;
          // Clear session from Supabase when logged out
          await supabase.from('wa_sessions').delete().eq('id', SESSION_ID);
          // Clean up session directory
          try {
            if (fs.existsSync(sessionDir)) {
              fs.rmSync(sessionDir, { recursive: true, force: true });
            }
          } catch (e) {
            console.error('[Auth] Failed to cleanup session directory:', e);
          }
        }
      } else if (connection === 'open') {
        console.log('[WA] ✅ Connected to WhatsApp successfully!');
        isConnected = true;
        lastQrString = null;
        reconnectAttempts = 0; // Reset on successful connection
      }
    });

    // CRITICAL FIX: Debounced session saving to prevent excessive writes
    sock.ev.on('creds.update', async () => {
      try {
        console.log('[Auth] Credentials updated, saving to local files first...');
        await saveCreds();
        
        // Clear any existing timeout
        if (sessionSaveTimeout) {
          clearTimeout(sessionSaveTimeout);
        }
        
        // Debounce session saves - only save after 5 seconds of no updates
        sessionSaveTimeout = setTimeout(async () => {
          try {
            const now = Date.now();
            
            // Don't save more than once every 10 seconds
            if (now - lastSessionSave < 10000) {
              console.log('[Auth] 🔄 Skipping session save - too frequent (last save was', Math.round((now - lastSessionSave)/1000), 's ago)');
              return;
            }
            
            console.log('[Auth] 💾 Starting debounced session save to Supabase...');
            const sessionData = { creds: null, keys: {} };
            
            // Read credentials
            const credsPath = path.join(sessionDir, 'creds.json');
            if (fs.existsSync(credsPath)) {
              const credsContent = fs.readFileSync(credsPath, 'utf8');
              sessionData.creds = JSON.parse(credsContent);
            }
            
            // Read all key files (only read, don't log every file)
            const files = fs.readdirSync(sessionDir);
            let keyCount = 0;
            files.forEach(file => {
              if (file.endsWith('.json') && file !== 'creds.json') {
                try {
                  const keyName = file.replace('.json', '');
                  const keyContent = fs.readFileSync(path.join(sessionDir, file), 'utf8');
                  sessionData.keys[keyName] = JSON.parse(keyContent);
                  keyCount++;
                } catch (e) {
                  console.error('[Auth] Failed to read key file', file, ':', e);
                }
              }
            });
            
            console.log(`[Auth] 📦 Read ${keyCount} key files and credentials for Supabase sync`);
            
            // Only save if we have valid session data
            if (sessionData.creds || Object.keys(sessionData.keys).length > 0) {
              await saveSessionToSupabase(sessionData);
              lastSessionSave = now;
            } else {
              console.warn('[Auth] No valid session data to save to Supabase');
            }
            
          } catch (e) {
            console.error('[Auth] Failed to read session files for Supabase sync:', e);
          }
        }, 5000); // Wait 5 seconds before saving
        
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

app.post('/api/whatsapp/send-test-message', async (req, res) => {
  try {
    if (!sock || !isConnected) return res.status(400).json({ success: false, message: 'WhatsApp not connected' });

    const testNumber = '+919106403233';
    const testMessage = '🎉 Test message from your WhatsApp integration! Connection is working perfectly.';
    
    const jid = testNumber.replace(/[+\s-]/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text: testMessage });
    res.json({ success: true, message: 'Test message sent successfully!' });
  } catch (e) {
    console.error('send-test-message error:', e);
    res.status(500).json({ success: false, message: 'Failed to send test message' });
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
