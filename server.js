const express = require('express');
const cors = require('cors');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Global variables
let sock = null;
let qrCodeData = null;
let isConnected = false;

// Create auth directory if it doesn't exist
const authDir = path.join(__dirname, 'auth');
if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
}

// Initialize WhatsApp connection
async function initializeWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['WhatsApp Web', 'Chrome', '1.0.0']
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('QR Code generated');
                qrCodeData = await QRCode.toDataURL(qr);
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
                isConnected = false;
                
                if (shouldReconnect) {
                    setTimeout(() => initializeWhatsApp(), 3000);
                }
            } else if (connection === 'open') {
                console.log('WhatsApp connected successfully');
                isConnected = true;
                qrCodeData = null; // Clear QR code when connected
            }
        });

        sock.ev.on('creds.update', saveCreds);
        
    } catch (error) {
        console.error('Error initializing WhatsApp:', error);
        setTimeout(() => initializeWhatsApp(), 5000);
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
        if (isConnected) {
            return res.json({ 
                success: false, 
                message: 'WhatsApp is already connected' 
            });
        }

        if (!sock) {
            await initializeWhatsApp();
        }

        // Wait for QR code generation
        let attempts = 0;
        while (!qrCodeData && attempts < 30) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
        }

        if (qrCodeData) {
            res.json({ 
                success: true, 
                qrCode: qrCodeData 
            });
        } else {
            res.status(500).json({ 
                success: false, 
                message: 'Failed to generate QR code' 
            });
        }
    } catch (error) {
        console.error('Error generating QR code:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error' 
        });
    }
});

app.get('/api/whatsapp/status', (req, res) => {
    res.json({ 
        isConnected: isConnected,
        hasQR: !!qrCodeData
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

app.post('/api/whatsapp/disconnect', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        isConnected = false;
        qrCodeData = null;
        sock = null;
        
        res.json({ 
            success: true, 
            message: 'WhatsApp disconnected successfully' 
        });
    } catch (error) {
        console.error('Error disconnecting WhatsApp:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error disconnecting WhatsApp' 
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