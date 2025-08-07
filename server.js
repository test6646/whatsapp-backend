const express = require('express');
const cors = require('cors');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL || 'https://tovnbcputrcfznsnccef.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvdm5iY3B1dHJjZnpuc25jY2VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE0MjQ5MTIsImV4cCI6MjA2NzAwMDkxMn0.7X9cFnxI389pviWP2U2BAAoPOw-nrfoQk8jSdn3bBpc';
const supabase = createClient(supabaseUrl, supabaseKey);

// Middleware
app.use(cors());
app.use(express.json());

// Global variables
let sock = null;
let qrCodeData = null;
let isConnected = false;
const SESSION_ID = 'default_session';

// Create auth directory if it doesn't exist
const authDir = path.join(__dirname, 'auth');
if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
}

// Helper function to clean up session files
async function cleanupSessionFiles() {
    try {
        const files = fs.readdirSync(authDir);
        for (const file of files) {
            const filePath = path.join(authDir, file);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`Deleted session file: ${file}`);
            }
        }
    } catch (error) {
        console.error('Error cleaning up session files:', error);
    }
}

// Helper function to force reset connection
async function forceResetConnection() {
    try {
        console.log('Force resetting WhatsApp connection...');
        
        // Close existing socket if it exists
        if (sock) {
            try {
                await sock.logout();
            } catch (error) {
                console.log('Error during logout (expected if already disconnected):', error.message);
            }
        }
        
        // Reset all state variables
        sock = null;
        isConnected = false;
        qrCodeData = null;
        
        // Clean up session files
        await cleanupSessionFiles();
        
        // Update Supabase
        await updateConnectionInSupabase({
            session_id: SESSION_ID,
            is_connected: false,
            qr_code: null,
            phone_number: null
        });
        
        console.log('Connection reset completed');
        return true;
    } catch (error) {
        console.error('Error during force reset:', error);
        return false;
    }
}

// Initialize WhatsApp connection
async function initializeWhatsApp(forceReset = false) {
    try {
        // If force reset is requested, clean up first
        if (forceReset) {
            await forceResetConnection();
        }
        
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['WhatsApp Web', 'Chrome', '1.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('QR Code generated');
                qrCodeData = await QRCode.toDataURL(qr);
                
                // Save QR code to Supabase
                await updateConnectionInSupabase({
                    session_id: SESSION_ID,
                    is_connected: false,
                    qr_code: qrCodeData
                });
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                const disconnectReason = lastDisconnect?.error?.output?.statusCode;
                
                console.log('Connection closed. Reason:', disconnectReason, 'Should reconnect:', shouldReconnect);
                isConnected = false;
                qrCodeData = null;
                
                // Update connection status in Supabase
                await updateConnectionInSupabase({
                    session_id: SESSION_ID,
                    is_connected: false,
                    qr_code: null
                });
                
                // Handle different disconnect reasons
                if (disconnectReason === DisconnectReason.loggedOut) {
                    console.log('Logged out - cleaning session files');
                    await cleanupSessionFiles();
                } else if (disconnectReason === DisconnectReason.restartRequired) {
                    console.log('Restart required - cleaning session and restarting');
                    await cleanupSessionFiles();
                    setTimeout(() => initializeWhatsApp(true), 2000);
                } else if (shouldReconnect) {
                    // For other disconnect reasons, try to reconnect after a delay
                    setTimeout(() => initializeWhatsApp(), 3000);
                }
            } else if (connection === 'open') {
                console.log('WhatsApp connected successfully');
                isConnected = true;
                qrCodeData = null; // Clear QR code when connected
                
                // Update connection status in Supabase
                await updateConnectionInSupabase({
                    session_id: SESSION_ID,
                    is_connected: true,
                    qr_code: null,
                    phone_number: sock?.user?.id || null
                });
            } else if (connection === 'connecting') {
                console.log('WhatsApp connecting...');
            }
        });

        sock.ev.on('creds.update', saveCreds);
        
        // Add connection monitoring
        sock.ev.on('connection.state', (state) => {
            console.log('Connection state changed:', state);
        });
        
    } catch (error) {
        console.error('Error initializing WhatsApp:', error);
        
        // If initialization fails, try force reset after a delay
        setTimeout(() => {
            console.log('Retrying with force reset...');
            initializeWhatsApp(true);
        }, 5000);
    }
}

// Helper function to update connection status in Supabase
async function updateConnectionInSupabase(data) {
    try {
        const { error } = await supabase
            .from('whatsapp_connections')
            .upsert(data, { 
                onConflict: 'session_id',
                ignoreDuplicates: false 
            });
        
        if (error) {
            console.error('Error updating Supabase:', error);
        }
    } catch (err) {
        console.error('Error connecting to Supabase:', err);
    }
}

// Helper function to get connection from Supabase
async function getConnectionFromSupabase(sessionId) {
    try {
        const { data, error } = await supabase
            .from('whatsapp_connections')
            .select('*')
            .eq('session_id', sessionId)
            .single();
        
        if (error && error.code !== 'PGRST116') {
            console.error('Error fetching from Supabase:', error);
            return null;
        }
        
        return data;
    } catch (err) {
        console.error('Error connecting to Supabase:', err);
        return null;
    }
}

// Routes
app.get('/', (req, res) => {
    res.json({ 
        message: 'WhatsApp Backend API is running',
        status: 'online',
        connected: isConnected
    });
});

app.post('/api/whatsapp/generate-qr', async (req, res) => {
    try {
        const { forceReset } = req.body;
        
        if (isConnected && !forceReset) {
            return res.json({ 
                success: false, 
                message: 'WhatsApp is already connected. Use forceReset to disconnect first.' 
            });
        }

        // If force reset is requested or socket doesn't exist, initialize with reset
        if (forceReset || !sock) {
            console.log('Initializing WhatsApp with force reset...');
            await initializeWhatsApp(true);
        }

        // Wait for QR code generation with improved timeout handling
        let attempts = 0;
        const maxAttempts = 45; // Increased timeout to 45 seconds
        
        while (!qrCodeData && attempts < maxAttempts && !isConnected) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
            
            // Log progress every 10 seconds
            if (attempts % 10 === 0) {
                console.log(`Waiting for QR code... ${attempts}/${maxAttempts} seconds`);
            }
        }

        if (isConnected) {
            return res.json({ 
                success: false, 
                message: 'WhatsApp connected during QR generation' 
            });
        }

        if (qrCodeData) {
            res.json({ 
                success: true, 
                qrCode: qrCodeData,
                message: 'QR code generated successfully'
            });
        } else {
            // If QR generation failed, try force reset and return error
            console.log('QR generation failed, attempting force reset...');
            await forceResetConnection();
            
            res.status(500).json({ 
                success: false, 
                message: 'Failed to generate QR code after timeout. Connection has been reset, please try again.' 
            });
        }
    } catch (error) {
        console.error('Error generating QR code:', error);
        
        // On error, try to reset connection
        await forceResetConnection();
        
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error. Connection has been reset, please try again.' 
        });
    }
});

app.get('/api/whatsapp/status', (req, res) => {
    res.json({ 
        isConnected: isConnected,
        hasQR: !!qrCodeData,
        hasSocket: !!sock,
        timestamp: new Date().toISOString()
    });
});

app.post('/api/whatsapp/send-message', async (req, res) => {
    try {
        const { number, message } = req.body;

        if (!isConnected || !sock) {
            return res.status(400).json({ 
                success: false, 
                message: 'WhatsApp is not connected' 
            });
        }

        if (!number || !message) {
            return res.status(400).json({ 
                success: false, 
                message: 'Phone number and message are required' 
            });
        }

        // Format phone number (remove + and spaces)
        const formattedNumber = number.replace(/[+\s-]/g, '') + '@s.whatsapp.net';

        await sock.sendMessage(formattedNumber, { text: message });

        res.json({ 
            success: true, 
            message: 'Message sent successfully' 
        });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to send message' 
        });
    }
});

app.post('/api/whatsapp/send-test-message', async (req, res) => {
    try {
        if (!isConnected || !sock) {
            return res.status(400).json({ 
                success: false, 
                message: 'WhatsApp is not connected' 
            });
        }

        // Send test message to the predefined number
        const testNumber = '+919106403233';
        const testMessage = 'Hello! This is a test message from your WhatsApp Web integration. Connection is working perfectly! 🚀';
        
        const formattedNumber = testNumber.replace(/[+\s-]/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(formattedNumber, { text: testMessage });

        res.json({ 
            success: true, 
            message: 'Test message sent successfully to ' + testNumber
        });
    } catch (error) {
        console.error('Error sending test message:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to send test message' 
        });
    }
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
    try {
        const resetResult = await forceResetConnection();
        
        if (resetResult) {
            res.json({ 
                success: true, 
                message: 'WhatsApp disconnected and session cleaned successfully' 
            });
        } else {
            res.status(500).json({ 
                success: false, 
                message: 'Error during disconnect process' 
            });
        }
    } catch (error) {
        console.error('Error disconnecting WhatsApp:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error disconnecting WhatsApp' 
        });
    }
});

// Add force reset endpoint
app.post('/api/whatsapp/force-reset', async (req, res) => {
    try {
        console.log('Force reset requested');
        const resetResult = await forceResetConnection();
        
        if (resetResult) {
            res.json({ 
                success: true, 
                message: 'WhatsApp connection force reset completed' 
            });
        } else {
            res.status(500).json({ 
                success: false, 
                message: 'Error during force reset' 
            });
        }
    } catch (error) {
        console.error('Error during force reset:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error during force reset' 
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Initializing WhatsApp connection...');
    initializeWhatsApp();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    if (sock) {
        await sock.logout();
    }
    process.exit(0);
});
