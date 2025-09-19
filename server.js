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

// Create a simple logger that doesn't log anything to reduce noise
const pino = () => ({
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  trace: () => {},
  child: () => pino(),
  level: 'silent'
});

// --- Basic server setup ---
const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

// --- Supabase client ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Session persistence config ---
// Runtime state - now supports multiple firm sessions
const firmSessions = new Map(); // Map<firmId, { sock, isConnected, lastQrString, reconnectAttempts, sessionSaveTimeout, lastSessionSave }>
let currentFirmId = null;

// --- Helper functions for firm session management ---
function getFirmSession(firmId) {
  if (!firmSessions.has(firmId)) {
    firmSessions.set(firmId, {
      sock: null,
      isConnected: false,
      lastQrString: null,
      reconnectAttempts: 0,
      sessionSaveTimeout: null,
      lastSessionSave: 0
    });
  }
  return firmSessions.get(firmId);
}

// --- Supabase helpers for session persistence ---
/**
 * Load session data from Supabase wa_sessions table for specific firm
 * @param {string} firmId - The firm ID
 * @returns {Object|null} Session data object or null if not found
 */
async function loadSessionFromSupabase(firmId) {
  try {
    console.log(`[Auth] Loading session from Supabase for firm: ${firmId}...`);
    const { data, error } = await supabase
      .from('wa_sessions')
      .select('session_data, firm_id')
      .eq('id', firmId)
      .eq('firm_id', firmId) // CRITICAL: Ensure firm ownership
      .maybeSingle();

    if (error) {
      console.error(`[Supabase] loadSession error for firm ${firmId}:`, error.message);
      return null;
    }

    // CRITICAL FIX: Check for both data existence AND valid session_data AND correct firm
    if (data && data.session_data && typeof data.session_data === 'object' && data.firm_id === firmId) {
      console.log(`[Auth] Valid session data found in Supabase for firm ${firmId}:`, Object.keys(data.session_data));
      return data.session_data;
    } else {
      console.log(`[Auth] No valid session found in Supabase for firm ${firmId} - data:`, data);
      return null;
    }
  } catch (err) {
    console.error(`[Auth] Failed to load session from Supabase for firm ${firmId}:`, err);
    return null;
  }
}

/**
 * Save session data to Supabase wa_sessions table for specific firm
 * @param {string} firmId - The firm ID
 * @param {Object} sessionData - The session data to save
 */
async function saveSessionToSupabase(firmId, sessionData) {
  try {
    // Handle clearing session - update status instead of deleting
    if (!sessionData) {
      console.log(`[Auth] Clearing session from Supabase for firm: ${firmId}`);
      await supabase.from('wa_sessions').update({ 
        session_data: null, 
        status: 'disconnected',
        updated_at: new Date().toISOString() 
      }).eq('id', firmId).eq('firm_id', firmId);
      return;
    }

    // CRITICAL FIX: Validate session data before saving
    if (typeof sessionData !== 'object') {
      console.error(`[Auth] Invalid session data for firm ${firmId} - cannot save to Supabase:`, sessionData);
      return;
    }

    console.log(`[Auth] Saving session to Supabase for firm ${firmId} with keys:`, Object.keys(sessionData));
    
    // Determine status based on session data
    let status = 'disconnected';
    if (sessionData.connected || sessionData.status === 'connected') {
      status = 'connected';
    } else if (sessionData.qr_available || sessionData.status === 'qr_generated') {
      status = 'qr_generated';
    } else if (sessionData.status) {
      status = sessionData.status;
    }

    const { error } = await supabase
      .from('wa_sessions')
      .upsert({ 
        id: firmId, 
        firm_id: firmId, // CRITICAL: Set firm_id for firm ownership
        status: status,
        session_data: sessionData,
        updated_at: new Date().toISOString() 
      }, { onConflict: 'id' });

    if (error) {
      console.error(`[Supabase] saveSession error for firm ${firmId}:`, error.message, error.details);
    } else {
      console.log(`[Auth] Session successfully saved to Supabase for firm ${firmId} with status: ${status}`);
    }
  } catch (err) {
    console.error(`[Auth] Failed to save session to Supabase for firm ${firmId}:`, err);
  }
}

// --- WhatsApp init for specific firm ---
async function initializeWhatsApp(firmId) {
  if (!firmId) {
    console.error('[WA] No firm ID provided for WhatsApp initialization');
    return;
  }

  const firmSession = getFirmSession(firmId);
  currentFirmId = firmId;

  try {
    console.log(`[WA] Initializing WhatsApp for firm: ${firmId} with Supabase session persistence...`);
    
    // Create a firm-specific session directory
    const sessionDir = `./wa_session_${firmId}`;
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    
    // Initialize auth state with useMultiFileAuthState
    let { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    // Load existing session from Supabase and restore it properly
    const savedSession = await loadSessionFromSupabase(firmId);
    if (savedSession && savedSession.creds) {
      console.log(`[Auth] Restoring session from Supabase for firm ${firmId}...`);
      try {
        // Write all session files from Supabase
        if (savedSession.creds) {
          fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(savedSession.creds, null, 2));
          console.log('[Auth] ✅ Restored creds.json');
        }
        if (savedSession.keys) {
          fs.writeFileSync(path.join(sessionDir, 'app-state-sync-key-0.json'), JSON.stringify(savedSession.keys, null, 2));
          console.log('[Auth] ✅ Restored app-state-sync-key-0.json');
        }
        
         // Reload auth state after restoring files
        ({ state, saveCreds } = await useMultiFileAuthState(sessionDir));
        
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
        
        // Reinitialize auth state to load the restored session
        const restored = await useMultiFileAuthState(sessionDir);
        Object.assign(state, restored.state);
        saveCreds = restored.saveCreds;
        
      } catch (e) {
        console.error('[Auth] ❌ Failed to restore session files:', e);
        // Clear corrupted session from Supabase
        await saveSessionToSupabase(firmId, null);
        console.log(`[Auth] Cleared corrupted session from Supabase for firm ${firmId}`);
      }
    } else {
      console.log(`[Auth] No valid session to restore for firm ${firmId} - starting fresh`);
    }

    // Add delay to prevent rapid connection attempts that cause 405 errors
    await new Promise(resolve => setTimeout(resolve, 2000));

    firmSession.sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ['WhatsApp Web', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      qrTimeout: 60000, // 60 seconds for QR timeout
      connectTimeoutMs: 45000, // 45 seconds for connection timeout
      retryRequestDelayMs: 3000, // 3 seconds between retries
      maxMsgRetryCount: 2, // Maximum 2 retries to prevent excessive retries
      defaultQueryTimeoutMs: 30000, // 30 seconds for queries
      keepAliveIntervalMs: 30000, // 30 seconds for keep alive
      fireInitQueries: true,
      markOnlineOnConnect: false,
      logger: pino({ level: 'silent' }) // Reduce logging noise
    });

    firmSession.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        firmSession.lastQrString = qr;
        console.log(`[QR] ✅ QR code generated for firm ${firmId}`);
        
        // Save QR availability status to Supabase immediately
        try {
          await saveSessionToSupabase(firmId, {
            qr_available: true,
            timestamp: new Date().toISOString(),
            status: 'qr_generated'
          });
          console.log(`[QR] QR status saved to Supabase for firm ${firmId}`);
        } catch (e) {
          console.error(`[QR] Failed to save QR status to Supabase for firm ${firmId}:`, e);
        }
        
        try {
          const terminalQR = await QRCode.toString(qr, { type: 'terminal', small: true });
          console.log(`\n📱 Scan this QR code with WhatsApp for firm ${firmId}:`);
          console.log(terminalQR);
          console.log(`QR Code available at: GET /api/whatsapp/qr?firmId=${firmId}\n`);
        } catch (e) {
          console.error('Failed to render QR in terminal:', e);
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`[WA] Connection closed for firm ${firmId}. Code:`, statusCode, 'Should reconnect:', shouldReconnect);
        firmSession.isConnected = false;
        firmSession.lastQrString = null;
        
        // Handle specific error codes with limited retries
        if (statusCode === 440) {
          console.log(`[WA] ⚠️ Session conflict detected for firm ${firmId} (Error 440)`);
          firmSession.reconnectAttempts++;
          
          if (firmSession.reconnectAttempts > 3) {
            console.log(`[WA] 🛑 Max conflict retries reached for firm ${firmId}. Clearing session.`);
            await saveSessionToSupabase(firmId, null);
            return;
          }
          
          const backoffDelay = Math.min(15000 * firmSession.reconnectAttempts, 45000); // Max 45s
          console.log(`[WA] Waiting ${backoffDelay/1000}s before retry for firm ${firmId}...`);
          setTimeout(() => initializeWhatsApp(firmId), backoffDelay);
          return;
        }
        
        if (shouldReconnect) {
          firmSession.reconnectAttempts++;
          
          // Limit total reconnection attempts to 5
          if (firmSession.reconnectAttempts > 5) {
            console.log(`[WA] 🛑 Max reconnection attempts (5) reached for firm ${firmId}. Stopping.`);
            firmSession.reconnectAttempts = 0;
            await saveSessionToSupabase(firmId, null);
            return;
          }
          
          const backoffDelay = Math.min(5000 * firmSession.reconnectAttempts, 25000); // Max 25s
          console.log(`[WA] Reconnecting firm ${firmId} in ${backoffDelay/1000}s... (attempt ${firmSession.reconnectAttempts}/5)`);
          setTimeout(() => initializeWhatsApp(firmId), backoffDelay);
        } else {
          console.log(`[WA] Firm ${firmId} logged out. Session cleared.`);
          firmSession.reconnectAttempts = 0;
          await saveSessionToSupabase(firmId, null);
          // Clean up session directory
          try {
            if (fs.existsSync(sessionDir)) {
              fs.rmSync(sessionDir, { recursive: true, force: true });
            }
          } catch (e) {
            console.error(`[Auth] Failed to cleanup session directory for firm ${firmId}:`, e);
          }
        }
      } else if (connection === 'open') {
        console.log(`[WA] ✅ Connected to WhatsApp successfully for firm ${firmId}!`);
        firmSession.isConnected = true;
        firmSession.lastQrString = null;
        firmSession.reconnectAttempts = 0;
        
        // Immediately create/update session entry in Supabase so other admins can see connection status
        try {
          await saveSessionToSupabase(firmId, {
            connected: true,
            timestamp: new Date().toISOString(),
            status: 'connected'
          });
          console.log(`[WA] ✅ Session status saved to Supabase for firm ${firmId}`);
        } catch (e) {
          console.error(`[WA] Failed to save connection status to Supabase for firm ${firmId}:`, e);
        }
      }
    });

    // Debounced session saving
    firmSession.sock.ev.on('creds.update', async () => {
      try {
        console.log(`[Auth] Credentials updated for firm ${firmId}, saving to local files first...`);
        await saveCreds();
        
        if (firmSession.sessionSaveTimeout) {
          clearTimeout(firmSession.sessionSaveTimeout);
        }
        
        firmSession.sessionSaveTimeout = setTimeout(async () => {
          try {
            const now = Date.now();
            
            if (now - firmSession.lastSessionSave < 10000) {
              console.log(`[Auth] 🔄 Skipping session save for firm ${firmId} - too frequent`);
              return;
            }
            
            console.log(`[Auth] 💾 Starting debounced session save to Supabase for firm ${firmId}...`);
            const sessionData = { creds: null, keys: {} };
            
            const credsPath = path.join(sessionDir, 'creds.json');
            if (fs.existsSync(credsPath)) {
              const credsContent = fs.readFileSync(credsPath, 'utf8');
              sessionData.creds = JSON.parse(credsContent);
            }
            
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
                  console.error(`[Auth] Failed to read key file ${file} for firm ${firmId}:`, e);
                }
              }
            });
            
            console.log(`[Auth] 📦 Read ${keyCount} key files and credentials for firm ${firmId} Supabase sync`);
            
            if (sessionData.creds || Object.keys(sessionData.keys).length > 0) {
              await saveSessionToSupabase(firmId, sessionData);
              firmSession.lastSessionSave = now;
            } else {
              console.warn(`[Auth] No valid session data to save to Supabase for firm ${firmId}`);
            }
            
          } catch (e) {
            console.error(`[Auth] Failed to read session files for firm ${firmId} Supabase sync:`, e);
          }
        }, 5000);
        
      } catch (e) {
        console.error(`[Auth] creds.update handler error for firm ${firmId}:`, e);
      }
    });

  } catch (error) {
    console.error(`[WA] Initialize error for firm ${firmId}:`, error);
    
    const firmSession = getFirmSession(firmId);
    firmSession.reconnectAttempts++;
    
    // Limit initialization retries to 3
    if (firmSession.reconnectAttempts > 3) {
      console.log(`[WA] 🛑 Max initialization attempts (3) reached for firm ${firmId}. Stopping.`);
      firmSession.reconnectAttempts = 0;
      return;
    }
    
    const retryDelay = 5000 * firmSession.reconnectAttempts; // 5s, 10s, 15s
    console.log(`[WA] Retrying initialization in ${retryDelay/1000}s for firm ${firmId}... (attempt ${firmSession.reconnectAttempts}/3)`);
    setTimeout(() => initializeWhatsApp(firmId), retryDelay);
  }
}

// --- Express routes (firm-specific) ---
app.get('/', (req, res) => {
  const connectedFirms = Array.from(firmSessions.entries())
    .filter(([firmId, session]) => session.isConnected)
    .map(([firmId]) => firmId);
  
  res.json({ 
    message: 'WhatsApp Backend API running (Firm-specific)', 
    connectedFirms,
    totalSessions: firmSessions.size 
  });
});

app.get('/api/whatsapp/status', (req, res) => {
  const { firmId } = req.query;
  if (!firmId) {
    return res.status(400).json({ success: false, message: 'firmId is required' });
  }

  const firmSession = firmSessions.get(firmId);
  if (!firmSession) {
    return res.json({ isConnected: false, hasQR: false });
  }

  res.json({ 
    isConnected: firmSession.isConnected, 
    hasQR: !!firmSession.lastQrString,
    firmId 
  });
});

// Return latest QR as a data URL for the frontend to render
app.get('/api/whatsapp/qr', async (req, res) => {
  try {
    const { firmId } = req.query;
    if (!firmId) {
      return res.status(400).json({ success: false, message: 'firmId is required' });
    }

    const firmSession = firmSessions.get(firmId);
    if (!firmSession || !firmSession.lastQrString) {
      return res.status(404).json({ success: false, message: 'QR not available yet for this firm' });
    }

    const dataUrl = await QRCode.toDataURL(firmSession.lastQrString, { margin: 1, scale: 8 });
    return res.json({ success: true, qrCode: dataUrl, firmId });
  } catch (e) {
    console.error('qr endpoint error:', e);
    return res.status(500).json({ success: false, message: 'Failed to render QR' });
  }
});

app.post('/api/whatsapp/generate-qr', async (req, res) => {
  try {
    const { firmId } = req.body;
    if (!firmId) {
      return res.status(400).json({ success: false, message: 'firmId is required' });
    }

    console.log(`[QR] Generate requested for firm ${firmId}`);

    const existing = firmSessions.get(firmId);

    if (existing?.isConnected) {
      return res.json({
        success: true,
        message: `Already connected for firm ${firmId}`,
        hasQR: false,
        isConnected: true,
        firmId
      });
    }

    if (existing?.sock) {
      try { await existing.sock.logout(); } catch (_) {}
      firmSessions.delete(firmId);
    }

    initializeWhatsApp(firmId).catch((e) => {
      console.error(`[QR] initializeWhatsApp failed for firm ${firmId}:`, e);
    });

    const session = firmSessions.get(firmId);
    const hasQR = !!session?.lastQrString;
    return res.json({
      success: true,
      message: `Initialization started for firm ${firmId}`,
      hasQR,
      isConnected: false,
      firmId
    });
  } catch (e) {
    console.error('generate-qr error:', e);
    res.status(500).json({ success: false, message: 'Failed to start WhatsApp' });
  }
});

app.post('/api/whatsapp/send-message', async (req, res) => {
  try {
    const { firmId, number, message } = req.body;
    if (!firmId) {
      return res.status(400).json({ success: false, message: 'firmId is required' });
    }
    if (!number || !message) {
      return res.status(400).json({ success: false, message: 'number and message required' });
    }

    const firmSession = firmSessions.get(firmId);
    if (!firmSession || !firmSession.sock || !firmSession.isConnected) {
      return res.status(400).json({ success: false, message: 'WhatsApp not connected for this firm' });
    }

    const jid = number.replace(/[+\s-]/g, '') + '@s.whatsapp.net';
    await firmSession.sock.sendMessage(jid, { text: message });
    res.json({ success: true, firmId });
  } catch (e) {
    console.error('send-message error:', e);
    res.status(500).json({ success: false, message: 'Failed to send message' });
  }
});

app.post('/api/whatsapp/send-test-message', async (req, res) => {
  try {
    const { firmId } = req.body;
    if (!firmId) {
      return res.status(400).json({ success: false, message: 'firmId is required' });
    }

    const firmSession = firmSessions.get(firmId);
    if (!firmSession || !firmSession.sock || !firmSession.isConnected) {
      return res.status(400).json({ success: false, message: 'WhatsApp not connected for this firm' });
    }

    const testNumber = '+919106403233';
    const testMessage = `🎉 Test message from firm ${firmId}'s WhatsApp integration! Connection is working perfectly.`;
    
    const jid = testNumber.replace(/[+\s-]/g, '') + '@s.whatsapp.net';
    await firmSession.sock.sendMessage(jid, { text: testMessage });
    res.json({ success: true, message: 'Test message sent successfully!', firmId });
  } catch (e) {
    console.error('send-test-message error:', e);
    res.status(500).json({ success: false, message: 'Failed to send test message' });
  }
});

// Add multer for file uploads
const multer = require('multer');
const upload = multer();

app.post('/whatsapp/send-document', upload.single('document'), async (req, res) => {
  try {
    const { to, message, filename } = req.body;
    const document = req.file;

    if (!to || !message || !document) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters: to, message, and document file' 
      });
    }

    // Extract firmId from session or determine it based on the current session
    // For now, we'll use the current firm ID or the first connected firm
    let targetFirmId = currentFirmId;
    if (!targetFirmId) {
      // Find the first connected firm
      for (const [firmId, session] of firmSessions.entries()) {
        if (session.isConnected) {
          targetFirmId = firmId;
          break;
        }
      }
    }

    if (!targetFirmId) {
      return res.status(400).json({ 
        success: false, 
        error: 'No active WhatsApp session found' 
      });
    }

    const firmSession = firmSessions.get(targetFirmId);
    if (!firmSession || !firmSession.sock || !firmSession.isConnected) {
      return res.status(400).json({ 
        success: false, 
        error: 'WhatsApp not connected for this firm' 
      });
    }

    // Format phone number for WhatsApp
    const jid = to.replace(/[+\s-]/g, '') + '@s.whatsapp.net';
    
    // Send document with message
    await firmSession.sock.sendMessage(jid, {
      document: document.buffer,
      fileName: filename || document.originalname,
      caption: message,
      mimetype: document.mimetype
    });

    console.log(`Document sent successfully to ${to} from firm ${targetFirmId}`);
    res.json({ 
      success: true, 
      message: 'Document sent successfully',
      firmId: targetFirmId 
    });

  } catch (error) {
    console.error('send-document error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to send document: ' + error.message 
    });
  }
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    const { firmId } = req.body;
    if (!firmId) {
      return res.status(400).json({ success: false, message: 'firmId is required' });
    }

    console.log(`[WA] Disconnecting WhatsApp for firm ${firmId}...`);
    
    const firmSession = firmSessions.get(firmId);
    if (firmSession && firmSession.sock) {
      await firmSession.sock.logout();
    }
    
    // Clear session from memory and Supabase
    if (firmSessions.has(firmId)) {
      firmSessions.delete(firmId);
    }

    try {
      await saveSessionToSupabase(firmId, null);
      console.log(`[Auth] Session cleared from Supabase for firm ${firmId}`);
    } catch (e) {
      console.error(`[Auth] Failed to clear session from Supabase for firm ${firmId}:`, e);
    }

    res.json({ success: true, message: `WhatsApp disconnected and session cleared for firm ${firmId}`, firmId });
  } catch (e) {
    console.error('disconnect error:', e);
    res.status(500).json({ success: false, message: 'Failed to disconnect WhatsApp' });
  }
});

// --- Auto-restore sessions for all firms on startup ---
async function restoreAllFirmSessions() {
  try {
    console.log('[Startup] Checking for existing WhatsApp sessions to restore...');
    
    // Get all firms with stored WhatsApp sessions
    const { data: sessions, error } = await supabase
      .from('wa_sessions')
      .select('firm_id, session_data')
      .not('session_data', 'is', null);

    if (error) {
      console.error('[Startup] Error fetching stored sessions:', error);
      return;
    }

    if (!sessions || sessions.length === 0) {
      console.log('[Startup] No stored WhatsApp sessions found');
      return;
    }

    console.log(`[Startup] Found ${sessions.length} stored sessions. Attempting to restore...`);
    
    // Initialize WhatsApp for each firm with stored session
    for (const session of sessions) {
      try {
        console.log(`[Startup] Restoring WhatsApp session for firm: ${session.firm_id}`);
        // Add a small delay between initializations to avoid overwhelming the service
        await new Promise(resolve => setTimeout(resolve, 1000));
        await initializeWhatsApp(session.firm_id);
      } catch (error) {
        console.error(`[Startup] Failed to restore session for firm ${session.firm_id}:`, error);
      }
    }
    
    console.log('[Startup] ✅ Session restoration process completed');
  } catch (error) {
    console.error('[Startup] Error during session restoration:', error);
  }
}

// --- Server start ---
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log('WhatsApp Backend ready for firm-specific connections');
  
  // Auto-restore all firm sessions on startup
  await restoreAllFirmSessions();
});

// --- Graceful shutdown ---
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  try {
    // Disconnect all firm sessions
    for (const [firmId, session] of firmSessions.entries()) {
      if (session.sock) {
        console.log(`Disconnecting firm ${firmId}...`);
        await session.sock.logout();
      }
    }
  } catch (_) {}
  process.exit(0);
});
