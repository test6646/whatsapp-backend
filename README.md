# WhatsApp Backend API

A Node.js backend using WhiskeySocket/Baileys for WhatsApp Web integration.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

For development:
```bash
npm run dev
```

## Environment Variables

Copy `.env.example` to `.env` and configure:
- `PORT`: Server port (default: 3001)

## API Endpoints

### POST /api/whatsapp/generate-qr
Generate a QR code for WhatsApp connection.

### GET /api/whatsapp/status
Check WhatsApp connection status.

### POST /api/whatsapp/send-message
Send a WhatsApp message.
Body: `{ "number": "+1234567890", "message": "Hello World" }`

### POST /api/whatsapp/disconnect
Disconnect from WhatsApp.

## Deployment to Render

1. Push this backend folder to a Git repository
2. Connect your repository to Render
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Set environment variables if needed

## Notes

- The auth session will be saved in the `auth` folder
- QR codes are generated automatically when not connected
- Phone numbers should include country code (e.g., +1234567890)