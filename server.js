
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// Add Supabase service key to environment if not set
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvdm5iY3B1dHJjZnpuc25jY2VmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MTQyNDkxMiwiZXhwIjoyMDY3MDAwOTEyfQ.gf_T7e1oGEJnVhV2D7dHxHMmGGWD4fOyqgXr1y9dGJg';
}

const WhatsAppService = require('./services/WhatsAppService');

const app = express();
const server = http.createServer(app);

// CORS configuration
const corsOptions = {
  origin: [
    "https://preview--test-joy-zone.lovable.app",
    "http://localhost:8080",
    "http://localhost:3000",
    "*" // Allow all origins for development
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
};

app.use(cors(corsOptions));

// Add explicit CORS headers middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

app.use(express.json());

// Socket.IO with CORS
const io = socketIo(server, {
  cors: corsOptions,
  transports: ['websocket', 'polling']
});

// Initialize WhatsApp service
const whatsappService = new WhatsAppService(io);

// Set up session cleanup interval
setInterval(() => {
  whatsappService.cleanupSessions();
}, 5 * 60 * 1000); // Every 5 minutes

// Health check endpoint - lightweight and fast
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'WhatsApp Backend Ready'
  });
});

// Initialize WhatsApp session
app.post('/api/whatsapp/initialize', async (req, res) => {
  try {
    console.log('🚀 Initializing WhatsApp session...');
    const { session_id, firm_id } = req.body;
    
    // CRITICAL FIX: Use the exact session_id from Supabase
    if (!session_id) {
      return res.status(400).json({
        success: false,
        error: 'session_id is required'
      });
    }
    
    console.log(`📥 Received session request: ${session_id} for firm: ${firm_id}`);
    
    const sessionId = await whatsappService.initializeSession(session_id);
    
    // CRITICAL: Ensure we return the SAME session_id that was passed in
    res.json({
      success: true,
      session_id: session_id, // Return the original session_id, not the generated one
      message: 'Session initialized successfully'
    });
  } catch (error) {
    console.error('❌ Error initializing WhatsApp session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get session status
app.get('/api/whatsapp/status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const status = await whatsappService.getSessionStatus(sessionId);
    res.json(status);
  } catch (error) {
    console.error('❌ Error getting session status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Send test message
app.post('/api/whatsapp/send-test', async (req, res) => {
  try {
    const { session_id, phone, message } = req.body;
    if (!session_id || !phone || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: session_id, phone, message'
      });
    }
    console.log(`📤 Sending test message to ${phone}...`);
    const result = await whatsappService.sendMessage(session_id, phone, message);

    res.json({
      success: true,
      message: 'Test message sent successfully',
      result
    });
  } catch (error) {
    console.error('❌ Error sending test message:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Disconnect session
app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    const { session_id } = req.body;
    await whatsappService.disconnectSession(session_id);
    res.json({
      success: true,
      message: 'Session disconnected successfully'
    });
  } catch (error) {
    console.error('❌ Error disconnecting session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  socket.on('join-session', (sessionId) => {
    console.log(`👤 Client ${socket.id} joined session: ${sessionId}`);
    socket.join(sessionId);
    whatsappService.addSocketToSession(sessionId, socket);
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
    whatsappService.removeSocket(socket);
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('🚨 Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 WhatsApp Backend Server running on port ${PORT}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
  console.log(`📱 Frontend URL: ${process.env.FRONTEND_URL || 'Not configured'}`);
});
