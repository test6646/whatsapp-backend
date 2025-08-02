
const makeWASocket = require('@whiskeysockets/baileys').default;
const { 
  DisconnectReason, 
  useMultiFileAuthState,
  delay 
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

// Create logger with reduced noise
const logger = pino({ level: 'warn' });

class WhatsAppService {
  constructor(io) {
    this.io = io;
    this.sessions = new Map(); // sessionId -> { socket, status, sockets, authDir }
    this.clientSockets = new Map(); // socket.id -> sessionId
    this.isHealthy = true;
  }

  async initializeSession(providedSessionId = null) {
    const sessionId = providedSessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    console.log(`🚀 Initializing WhatsApp session: ${sessionId}`);

    // CRITICAL FIX: Use the provided session ID from Supabase
    if (providedSessionId) {
      console.log(`✅ Using provided session ID: ${providedSessionId}`);
      
      // Check if session exists in database and is already connected
      try {
        const SUPABASE_URL = 'https://tovnbcputrcfznsnccef.supabase.co';
        const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        
        if (SUPABASE_SERVICE_KEY) {
          const response = await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_sessions?session_id=eq.${sessionId}&select=*`, {
            headers: {
              'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
              'apikey': SUPABASE_SERVICE_KEY
            }
          });
          
          if (response.ok) {
            const sessions = await response.json();
            if (sessions.length > 0) {
              const dbSession = sessions[0];
              console.log(`📋 Found existing session in DB with status: ${dbSession.status}`);
              
              // If session is connected in DB, try to restore it
              if (dbSession.status === 'connected') {
                console.log(`🔄 Attempting to restore connected session: ${sessionId}`);
                
                // Create auth directory for this session
                const authDir = path.join(__dirname, '..', 'auth', sessionId);
                
                // Check if auth files exist
                if (fs.existsSync(authDir)) {
                  console.log(`✅ Auth files found, restoring session: ${sessionId}`);
                  
                  // Store session with connected status
                  this.sessions.set(sessionId, {
                    socket: null,
                    status: 'connected',
                    sockets: new Set(),
                    createdAt: new Date(dbSession.created_at),
                    authDir: authDir,
                    qrRetries: 0,
                    maxQrRetries: 5,
                    lastQrTime: null,
                    connectionAttempts: 0,
                    maxConnectionAttempts: 5,
                    currentQrCode: null,
                    restored: true
                  });
                  
                  // Start connection to verify it's still valid
                  this.connectWhatsApp(sessionId);
                  return sessionId;
                }
              }
            }
          }
        }
      } catch (error) {
        console.log(`⚠️ Could not check existing session: ${error.message}`);
      }
    }

    // Create auth directory for this session
    const authDir = path.join(__dirname, '..', 'auth', sessionId);
    
    // CRITICAL FIX: Clean up any existing session with same ID first
    if (this.sessions.has(sessionId)) {
      console.log(`🧹 Cleaning up existing session: ${sessionId}`);
      await this.cleanupSession(sessionId);
    }
    
    // Store session with connecting status
    this.sessions.set(sessionId, {
      socket: null,
      status: 'connecting',
      sockets: new Set(),
      createdAt: new Date(),
      authDir: authDir,
      qrRetries: 0,
      maxQrRetries: 5,
      lastQrTime: null,
      connectionAttempts: 0,
      maxConnectionAttempts: 5, // Increased
      currentQrCode: null // Store current QR code
    });

    // Start connection process in background
    this.connectWhatsApp(sessionId);

    return sessionId; // CRITICAL: Return the SAME session ID that was provided
  }

  async connectWhatsApp(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.connectionAttempts++;
    console.log(`🔄 Connection attempt ${session.connectionAttempts} for session: ${sessionId}`);

    try {
      // Ensure auth directory exists
      if (!fs.existsSync(session.authDir)) {
        fs.mkdirSync(session.authDir, { recursive: true });
      }

      console.log(`🔄 Creating WhatsApp socket for session: ${sessionId}`);
      
      // Load auth state
      const { state, saveCreds } = await useMultiFileAuthState(session.authDir);

      // Create WhatsApp socket with better configuration
      const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: logger,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        defaultQueryTimeoutMs: 60000, // Increased timeout
        connectTimeoutMs: 60000, // Increased timeout
        qrTimeout: 60000, // Increased QR timeout
        emitOwnEvents: false,
        browser: ['WhatsApp Web', 'Chrome', '91.0.4472.124'], // Better browser info
        keepAliveIntervalMs: 30000, // Keep connection alive
        retryRequestDelayMs: 1000,
        maxMsgRetryCount: 3
      });

      // Store socket in session
      session.socket = sock;

      // Setup event handlers
      this.setupSocketEvents(sock, sessionId, saveCreds);

      // Set connection timeout with retry logic
      setTimeout(() => {
        const currentSession = this.sessions.get(sessionId);
        if (currentSession && (currentSession.status === 'connecting' || currentSession.status === 'qr_ready')) {
          console.log(`⏰ Session ${sessionId} connection timeout (attempt ${session.connectionAttempts})`);
          
          if (session.connectionAttempts < session.maxConnectionAttempts) {
            console.log(`🔄 Retrying connection for session ${sessionId}`);
            this.cleanupSessionSocket(sessionId);
            // Retry after a delay
            setTimeout(() => {
              if (this.sessions.has(sessionId)) {
                this.connectWhatsApp(sessionId);
              }
            }, 5000);
          } else {
            console.log(`❌ Max connection attempts reached for session ${sessionId}`);
            this.updateSessionStatus(sessionId, 'error', { message: 'Connection timeout after multiple attempts' });
            this.emitToSession(sessionId, 'error', 'Connection timeout - please try again');
            this.cleanupSession(sessionId);
          }
        }
      }, 120000); // 2 minutes timeout

    } catch (error) {
      console.error(`❌ Error creating WhatsApp socket for session ${sessionId}:`, error);
      
      if (session.connectionAttempts < session.maxConnectionAttempts) {
        console.log(`🔄 Retrying connection due to error for session ${sessionId}`);
        setTimeout(() => {
          if (this.sessions.has(sessionId)) {
            this.connectWhatsApp(sessionId);
          }
        }, 5000);
      } else {
        this.updateSessionStatus(sessionId, 'error', { message: error.message });
        this.emitToSession(sessionId, 'error', error.message);
        this.cleanupSession(sessionId);
      }
    }
  }

  setupSocketEvents(sock, sessionId, saveCreds) {
    // Connection update handler
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const session = this.sessions.get(sessionId);
      
      if (!session) return;

      if (qr) {
        console.log(`📱 QR Code generated for session: ${sessionId} (retry ${session.qrRetries + 1})`);
        
        // Check QR retry limit and time-based throttling
        const now = Date.now();
        if (session.lastQrTime && (now - session.lastQrTime) < 10000) {
          console.log(`⏸️ QR generation throttled for session ${sessionId}`);
          return;
        }
        
        session.qrRetries++;
        session.lastQrTime = now;
        
        if (session.qrRetries > session.maxQrRetries) {
          console.log(`❌ Max QR retries reached for session: ${sessionId}`);
          this.updateSessionStatus(sessionId, 'error', { message: 'Max QR code retries reached' });
          this.emitToSession(sessionId, 'error', 'Too many QR code attempts. Please restart the session.');
          this.cleanupSession(sessionId);
          return;
        }

        try {
          const qrDataURL = await qrcode.toDataURL(qr, {
            width: 300,
            margin: 2,
            color: { dark: '#000000', light: '#FFFFFF' }
          });
          
          // CRITICAL FIX: Store QR code in session for retrieval
          session.currentQrCode = qrDataURL;
          
          await this.updateSessionStatus(sessionId, 'qr_ready', { qr_code: qrDataURL });
          this.emitToSession(sessionId, 'qr-code', qrDataURL);
          console.log(`✅ QR Code sent to clients for session: ${sessionId}`);
        } catch (error) {
          console.error(`❌ Error generating QR code for session ${sessionId}:`, error);
          this.emitToSession(sessionId, 'error', 'Failed to generate QR code');
        }
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        const reason = lastDisconnect?.error?.output?.statusCode;
        
        console.log(`🔴 Connection closed for session ${sessionId}. Reason:`, reason, 'Should reconnect:', shouldReconnect);
        
        if (reason === DisconnectReason.loggedOut) {
          console.log(`🚪 Session ${sessionId} logged out`);
          await this.updateSessionStatus(sessionId, 'disconnected');
          this.emitToSession(sessionId, 'status-update', {
            status: 'disconnected',
            message: 'Logged out from WhatsApp'
          });
          this.cleanupSession(sessionId);
        } else if (reason === DisconnectReason.badSession || reason === DisconnectReason.restartRequired) {
          console.log(`🔄 Session ${sessionId} needs restart`);
          this.cleanupSessionSocket(sessionId);
          if (session.connectionAttempts < session.maxConnectionAttempts) {
            setTimeout(() => this.connectWhatsApp(sessionId), 3000);
          } else {
            this.updateSessionStatus(sessionId, 'error', { message: 'Session restart failed' });
            this.cleanupSession(sessionId);
          }
        } else if (shouldReconnect && session.status !== 'error' && session.connectionAttempts < session.maxConnectionAttempts) {
          console.log(`🔄 Reconnecting session ${sessionId}...`);
          this.updateSessionStatus(sessionId, 'connecting');
          setTimeout(() => this.connectWhatsApp(sessionId), 5000);
        } else {
          console.log(`❌ Session ${sessionId} connection failed permanently`);
          this.updateSessionStatus(sessionId, 'error', { message: 'Connection failed' });
          this.emitToSession(sessionId, 'error', 'Connection failed - please restart the session');
          this.cleanupSession(sessionId);
        }
      } else if (connection === 'open') {
        console.log(`🟢 WhatsApp connected for session: ${sessionId}`);
        session.connectionAttempts = 0; // Reset on successful connection
        session.qrRetries = 0; // Reset QR retries
        await this.updateSessionStatus(sessionId, 'connected');
        this.emitToSession(sessionId, 'status-update', {
          status: 'connected',
          message: 'WhatsApp connected successfully!'
        });
      } else if (connection === 'connecting') {
        console.log(`🔄 WhatsApp connecting for session: ${sessionId}`);
        this.updateSessionStatus(sessionId, 'connecting');
      }
    });

    // Credentials update handler
    sock.ev.on('creds.update', saveCreds);

    // Message handler (optional, for debugging)
    sock.ev.on('messages.upsert', (m) => {
      if (m.messages?.[0]?.message) {
        console.log(`📨 Message received in session ${sessionId}`);
      }
    });

    // Error handler
    sock.ev.on('CB:call', (node) => {
      console.log(`📞 Call event in session ${sessionId}:`, node);
    });
  }

  async cleanupSessionSocket(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.socket) {
      try {
        session.socket.end();
      } catch (error) {
        console.log(`⚠️ Error ending socket for ${sessionId}:`, error.message);
      }
      session.socket = null;
    }
  }

  async cleanupSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      console.log(`🧹 Cleaning up session: ${sessionId}`);
      
      try {
        // Close the socket if it exists
        if (session.socket) {
          try {
            await session.socket.logout();
          } catch (error) {
            // Ignore logout errors
          }
          
          try {
            session.socket.end();
          } catch (error) {
            // Ignore end errors
          }
        }

        // Close all connected sockets
        session.sockets.forEach(socket => {
          if (socket.connected) {
            socket.disconnect();
          }
        });

        // Clean up auth directory with retry logic
        if (session.authDir && fs.existsSync(session.authDir)) {
          try {
            // Wait a bit for file handles to close
            await new Promise(resolve => setTimeout(resolve, 2000));
            fs.rmSync(session.authDir, { recursive: true, force: true });
            console.log(`🗑️ Cleaned up auth directory for session: ${sessionId}`);
          } catch (error) {
            console.log(`⚠️ Warning: Could not clean auth directory for session ${sessionId}:`, error.message);
            // Try to clean individual files
            try {
              const files = fs.readdirSync(session.authDir);
              for (const file of files) {
                try {
                  fs.unlinkSync(path.join(session.authDir, file));
                } catch (fileError) {
                  // Ignore individual file errors
                }
              }
              fs.rmdirSync(session.authDir);
            } catch (dirError) {
              // Final attempt failed, log and continue
              console.log(`⚠️ Final cleanup attempt failed for ${sessionId}`);
            }
          }
        }

        this.sessions.delete(sessionId);
        console.log(`✅ Session ${sessionId} cleaned up successfully`);
      } catch (error) {
        console.error(`❌ Error cleaning up session ${sessionId}:`, error.message);
        // Force delete even if cleanup fails
        this.sessions.delete(sessionId);
      }
    }
  }

  async updateSessionStatus(sessionId, status, extra = {}) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
      session.lastUpdate = new Date();
      Object.assign(session, extra);
      console.log(`🔄 Session ${sessionId} status updated to: ${status}`);
      
      // Update status in Supabase database for persistence
      try {
        const SUPABASE_URL = 'https://tovnbcputrcfznsnccef.supabase.co';
        const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        
        if (SUPABASE_SERVICE_KEY) {
          const updateData = {
            status: status,
            last_ping: new Date().toISOString()
          };
          
          if (status === 'connected') {
            updateData.connected_at = new Date().toISOString();
          }
          
          if (extra.qr_code) {
            updateData.qr_code = extra.qr_code;
          }
          
          const response = await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_sessions?session_id=eq.${sessionId}`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
              'apikey': SUPABASE_SERVICE_KEY,
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify(updateData)
          });
          
          if (response.ok) {
            console.log(`✅ Session ${sessionId} status persisted to database: ${status}`);
          } else {
            console.error(`❌ Failed to persist session status:`, response.status, response.statusText);
          }
        }
      } catch (error) {
        console.error(`❌ Error persisting session status:`, error.message);
      }
    }
  }

  emitToSession(sessionId, event, data) {
    const session = this.sessions.get(sessionId);
    if (session && session.sockets.size > 0) {
      session.sockets.forEach(socket => {
        if (socket.connected) {
          socket.emit(event, data);
        }
      });
      console.log(`📡 Emitted '${event}' to ${session.sockets.size} clients in session ${sessionId}`);
    } else {
      console.log(`📡 No connected clients for session ${sessionId} to emit '${event}'`);
    }
  }

  addSocketToSession(sessionId, socket) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.sockets.add(socket);
      this.clientSockets.set(socket.id, sessionId);
      console.log(`➕ Added socket ${socket.id} to session ${sessionId}`);
      
      // Send current status to the new socket
      socket.emit('status-update', {
        status: session.status,
        message: `Current status: ${session.status}`
      });
    } else {
      console.log(`❌ Session ${sessionId} not found when adding socket ${socket.id}`);
    }
  }

  removeSocket(socket) {
    const sessionId = this.clientSockets.get(socket.id);
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.sockets.delete(socket);
        console.log(`➖ Removed socket ${socket.id} from session ${sessionId}`);
      }
      this.clientSockets.delete(socket.id);
    }
  }

  async getSessionStatus(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { status: 'not_found', message: 'Session not found' };
    }
    
    // CRITICAL FIX: Return proper status with QR code if available
    const response = {
      status: session.status,
      created_at: session.createdAt,
      last_update: session.lastUpdate,
      connected_sockets: session.sockets.size,
      qr_retries: session.qrRetries || 0,
      connection_attempts: session.connectionAttempts || 0,
      message: `Session is ${session.status}`,
      ready: session.status === 'connected',
      qr_available: session.status === 'qr_ready' && session.currentQrCode,
      qr_code: session.currentQrCode || null
    };
    
    console.log(`📊 Status request for ${sessionId}:`, { 
      status: response.status, 
      has_qr: !!response.qr_code,
      sockets: response.connected_sockets 
    });
    
    return response;
  }

  async sendMessage(sessionId, phone, message) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    if (session.status !== 'connected') {
      throw new Error(`Session is not connected. Current status: ${session.status}`);
    }

    const sock = session.socket;
    if (!sock) {
      throw new Error('WhatsApp socket not available');
    }

    try {
      // Format phone number for Indian numbers
      let formattedPhone = phone.replace(/\D/g, '');
      
      // Handle Indian phone numbers
      if (formattedPhone.startsWith('91') && formattedPhone.length === 12) {
        // Already has country code
      } else if (formattedPhone.length === 10) {
        // Add Indian country code
        formattedPhone = '91' + formattedPhone;
      } else if (formattedPhone.startsWith('0') && formattedPhone.length === 11) {
        // Remove leading 0 and add country code
        formattedPhone = '91' + formattedPhone.substring(1);
      }
      
      const jid = formattedPhone + '@s.whatsapp.net';
      
      console.log(`📤 Sending message to ${jid} via session ${sessionId}`);
      
      const result = await sock.sendMessage(jid, { text: message });
      
      console.log(`✅ Message sent successfully via session ${sessionId}`);
      return result;
    } catch (error) {
      console.error(`❌ Error sending message via session ${sessionId}:`, error);
      throw error;
    }
  }

  async disconnectSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    
    try {
      console.log(`🔌 Disconnecting session: ${sessionId}`);
      
      // Notify all connected sockets
      this.emitToSession(sessionId, 'status-update', {
        status: 'disconnecting',
        message: 'Disconnecting WhatsApp session...'
      });
      
      // Logout and cleanup
      if (session.socket) {
        await session.socket.logout();
      }
      
      await this.cleanupSession(sessionId);
      
      console.log(`✅ Session ${sessionId} disconnected and cleaned up`);
    } catch (error) {
      console.error(`❌ Error disconnecting session ${sessionId}:`, error);
      throw error;
    }
  }

  // Cleanup inactive sessions
  async cleanupSessions() {
    const now = new Date();
    const maxAge = 30 * 60 * 1000; // 30 minutes
    for (const [sessionId, session] of this.sessions.entries()) {
      const age = now - session.createdAt;
      if (age > maxAge && session.status !== 'connected') {
        console.log(`🧹 Cleaning up inactive session: ${sessionId} (${Math.round(age/60000)} minutes old)`);
        try {
          await this.cleanupSession(sessionId);
        } catch (error) {
          console.error(`❌ Error cleaning up session ${sessionId}:`, error);
        }
      }
    }
  }
}

module.exports = WhatsAppService;
