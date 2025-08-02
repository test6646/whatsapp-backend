# WhatsApp Backend Service

A Node.js + Express backend service for WhatsApp Web integration using `whatsapp-web.js`.

## Features

- ✅ WhatsApp Web.js integration
- ✅ Real-time QR code generation
- ✅ Socket.IO for real-time updates
- ✅ Session management
- ✅ Message sending capabilities
- ✅ Production-ready for Railway deployment

## Quick Deploy to Railway

1. **Create a new Railway project**
2. **Upload this folder** to Railway
3. **Set environment variables:**
   - `FRONTEND_URL`: Your React app's URL
   - `PORT`: 3001 (Railway will set this automatically)

## Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Create environment file:**
   ```bash
   cp .env.example .env
   ```

3. **Update `.env` with your settings:**
   ```env
   PORT=3001
   FRONTEND_URL=http://localhost:5173
   ```

4. **Start the server:**
   ```bash
   npm run dev
   ```

## API Endpoints

### Health Check
- `GET /health` - Server health status

### WhatsApp Operations
- `POST /api/whatsapp/initialize` - Initialize new WhatsApp session
- `GET /api/whatsapp/status/:sessionId` - Get session status
- `POST /api/whatsapp/send-test` - Send test message
- `POST /api/whatsapp/disconnect` - Disconnect session

### Socket.IO Events
- `join-session` - Join a WhatsApp session
- `qr-code` - Receive QR code for scanning
- `status-update` - Session status updates
- `error` - Error notifications

## Production Deployment

### Railway Deployment
1. Connect your GitHub repo to Railway
2. Set environment variables in Railway dashboard
3. Deploy automatically on push

### Environment Variables for Production
```env
FRONTEND_URL=https://your-react-app.com
PORT=3001
```

## Frontend Integration

Update your React app's WhatsApp component:

```javascript
const BACKEND_URL = 'https://your-railway-app.railway.app';
```

## Architecture

```
┌─────────────────┐    WebSocket     ┌─────────────────┐    WhatsApp Web.js    ┌─────────────────┐
│   React App     │ ←──────────────→ │  Node.js Server │ ←─────────────────→  │   WhatsApp      │
│                 │                  │                 │                      │                 │
│ - QR Display    │    HTTP/Socket   │ - Session Mgmt  │   Local Auth         │ - Phone Linking │
│ - Status Updates│    Real-time     │ - QR Generation │   Puppeteer          │ - Message Send  │
│ - User Actions  │                  │ - Message API   │                      │ - Events        │
└─────────────────┘                  └─────────────────┘                      └─────────────────┘
```

## Security Notes

- Sessions are stored locally on the server
- No sensitive data is transmitted to frontend
- CORS properly configured
- Rate limiting recommended for production

## Troubleshooting

### Common Issues
1. **QR Code not generating**: Check Puppeteer dependencies
2. **Connection timeouts**: Verify CORS settings
3. **Session cleanup**: Implement periodic cleanup for inactive sessions

### Logs
All operations are logged with emojis for easy debugging:
- 🚀 Initialization
- 📱 QR Code events  
- 🟢 Success states
- ❌ Error states
- 🔄 Status updates