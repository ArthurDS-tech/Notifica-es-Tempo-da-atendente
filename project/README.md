# WhatsApp UTalk Bot 📱

A complete Node.js automation system for sending WhatsApp messages using the Umbler UTalk API v1. This system provides both terminal-based and web-based interfaces for sending messages with persistent authentication (no QR code scanning on every use).

## ✨ Features

- **Persistent Authentication**: Uses Bearer token authentication with session persistence
- **Multiple Interfaces**: Terminal script and web application
- **Channel Management**: Create and manage Starter and Business API channels
- **Message Types**: Support for simple messages and template messages
- **Rate Limit Awareness**: Built-in handling for API rate limits
- **Error Handling**: Comprehensive error handling and user-friendly messages
- **Responsive Web UI**: Clean, modern web interface for message sending

## 🚀 Quick Start

### 1. Installation

```bash
# Clone or create project directory
mkdir whatsapp-utalk-bot
cd whatsapp-utalk-bot

# Initialize npm project
npm init -y

# Install dependencies
npm install axios express body-parser dotenv readline

# Copy the provided files to your project directory
# (All files from this artifact)
```

### 2. Configuration

```bash
# Run the setup wizard
npm run setup
```

The setup wizard will:
- Ask for your UTalk API Bearer token
- Fetch your organization information
- List existing channels or create a new one
- Save configuration to `.env` file

### 3. First-Time Channel Setup

If you created a new Starter channel, you need to connect it to WhatsApp:

1. Visit: `https://app-utalk.umbler.com/channels/{your_channel_id}/`
2. Scan the QR code with your WhatsApp
3. Wait for connection confirmation

**Important**: This QR scan is only required ONCE. After connection, the session persists automatically.

### 4. Test Message Sending

```bash
# Send a test message via terminal
npm run test
```

### 5. Start Web Interface

```bash
# Start the web application
npm start
```

Visit `http://localhost:3000` to use the web interface.

## 📋 API Token Setup

1. Go to your [Umbler Account Panel](https://app-utalk.umbler.com/)
2. Navigate to API settings or developer section
3. Generate or copy your Bearer token
4. Use this token during setup or add to `.env` file

## 🔧 Configuration Files

### `.env` File Example

```env
# Umbler UTalk API Configuration
UTALK_API_TOKEN=your_bearer_token_here
UTALK_BASE_URL=https://app-utalk.umbler.com/api
ORGANIZATION_ID=your_organization_id
CHANNEL_ID=your_channel_id

# Web App Configuration
PORT=3000
NODE_ENV=development

# Optional: Default test number
DEFAULT_TEST_NUMBER=554899895903
```

## 📜 Available Scripts

- `npm run setup` - Run initial configuration wizard
- `npm run test` - Send test message via terminal
- `npm start` - Start web application server

## 🌐 Web Interface

The web interface provides:

- **System Status**: Real-time API and channel status
- **Message Sending**: Form-based message sending with validation
- **Template Support**: Send template messages for compliance
- **Response Tracking**: View send results and error messages
- **Usage Guidelines**: Built-in ethical usage reminders

### Web API Endpoints

- `GET /` - Web interface
- `GET /api/info` - Account and configuration information
- `GET /api/channels` - List all channels
- `POST /api/send-message` - Send WhatsApp message
- `POST /api/create-channel` - Create new channel
- `GET /api/channel-status/:id` - Get channel status

## 📱 Channel Types

### Starter Channels
- Free tier option
- Requires QR code scan for initial setup
- Good for personal/testing use
- Created via: `POST /v1/channels/starter/`

### Business API Channels
- Requires WhatsApp Business API approval
- No QR code needed (uses phone number verification)
- Suitable for business use
- Created via: `POST /v1/channels/waba/`

## 💬 Message Types

### Simple Messages
```javascript
{
  "channel_id": "your_channel_id",
  "organization_id": "your_org_id",
  "phone_number": "554899895903",
  "message": "Hello from UTalk API!"
}
```

### Template Messages
```javascript
{
  "channel_id": "your_channel_id",
  "organization_id": "your_org_id", 
  "phone_number": "554899895903",
  "template_name": "hello_world",
  "parameters": ["John", "Doe"]
}
```

## ⚠️ Rate Limits

- Standard rate limit: 100 requests per 5 seconds
- Template messages may have different limits
- The system includes automatic rate limit detection
- Wait between requests if rate limited

## 🔍 Troubleshooting

### Common Issues

**"Unauthorized" Error**
- Check if API token is correct and active
- Verify token has necessary permissions
- Run `npm run setup` to reconfigure

**"Channel not found" Error**
- Verify channel ID exists
- Check if channel was deleted
- Create new channel via setup or web interface

**"Rate Limit Exceeded"**
- Wait a few seconds before retrying
- Reduce request frequency
- Monitor console for rate limit warnings

**Channel Disconnected**
- Reconnect via UTalk dashboard
- Check WhatsApp connection status
- May need to re-scan QR code

### Debug Mode

Set `NODE_ENV=development` in `.env` for detailed API logs.

## 📚 UTalk API v1 Reference

### Base URL
```
https://app-utalk.umbler.com/api
## 🔔 Webhook e Alerta de Inatividade (15 min)

- Endpoint para configurar no UTalk (POST): `/api/webhook/utalk`
- Comportamento:
  - Mensagem de entrada (cliente) agenda alerta após 15 minutos sem resposta
  - Mensagem de saída (atendente) cancela o alerta agendado
  - Se expirar, envia mensagem ao gestor (`MANAGER_PHONE`) com o formato organizado

### Variáveis de ambiente

Adicione ao seu `.env`:

```
MANAGER_PHONE=5511999999999
MANAGER_ATTENDANT_ID=aGevxChnIrrCytFy
IDLE_MS=600000
WEBHOOK_DEBUG=true
## 🚇 Testes locais com ngrok e simulador

1. Inicie o servidor local:
```
npm start
```

2. Inicie o ngrok (HTTP na porta do app, ex.: 3000):
```
ngrok http 3000
```
Copie a URL pública gerada (ex.: https://example.ngrok.io).

3. Configure o webhook do UTalk para apontar para:
```
https://example.ngrok.io/api/webhook/utalk
```

4. Simule cenários com o tester:
```
set BASE_URL=https://example.ngrok.io
npm run test:webhook:idle
npm run test:webhook:reply
npm run test:webhook:multi
```

5. Inspecione o estado do servidor:
```
GET https://example.ngrok.io/api/webhook/utalk/debug
```
Retorno contém `activeTimers`, `idleMs` e amostra dos últimos eventos.

```

- `MANAGER_PHONE`: telefone fixo (c/ DDI) que receberá alertas
- `MANAGER_ATTENDANT_ID`: opcional, ID do atendente/gestor (para mapeamento de nome)

```

### Authentication
```
Authorization: Bearer {your_token}
```

### Key Endpoints Used
- `GET /v1/members/me/` - User information
- `GET /v1/channels/` - List channels
- `POST /v1/channels/starter/` - Create starter channel
- `POST /v1/channels/waba/` - Create business channel
- `POST /v1/messages/simplified/` - Send simple message
- `POST /v1/template-messages/simplified/` - Send template message
- `DELETE /v1/channels/{id}/` - Delete channel

## ⚖️ Ethical Usage Guidelines

**✅ DO:**
- Only message people who have given consent
- Respect WhatsApp Terms of Service
- Follow local privacy and communication laws
- Use template messages for marketing (outside 24h window)
- Monitor and respect rate limits

**❌ DON'T:**
- Send unsolicited marketing messages
- Spam or bulk message without permission
- Violate WhatsApp's Business Policy
- Exceed API rate limits intentionally
- Share personal data without consent

## 🛡️ Security Notes

- Keep API tokens secure and private
- Use environment variables for sensitive data
- Don't commit `.env` files to version control
- Regularly rotate API tokens
- Monitor API usage for unauthorized access

## 📞 Support

For UTalk API issues:
- [Umbler Support](https://umbler.com/support)
- [UTalk Documentation](https://app-utalk.umbler.com/api/docs/)

For this bot implementation:
- Check troubleshooting section above
- Verify configuration with `npm run setup`
- Test with `npm run test` before using web interface

---

**Happy messaging! 📱✨**

Remember to always follow WhatsApp's terms of service and respect your recipients' privacy.