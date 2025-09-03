const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const UTalkAPI = require('./config/api');
const { getAttendantNameById } = require('./config/attendants');

const app = express();
const PORT = process.env.PORT || 3000;
const MANAGER_PHONE = process.env.MANAGER_PHONE; // digits only with country code
const MANAGER_ATTENDANT_ID = process.env.MANAGER_ATTENDANT_ID; // optional ID mapping
const WEBHOOK_DEBUG = (process.env.WEBHOOK_DEBUG || 'true') === 'true';

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize API
let api;
try {
  api = new UTalkAPI();
} catch (error) {
  console.error('Failed to initialize UTalk API:', error.message);
  console.log('Please run: npm run setup');
  process.exit(1);
}

// In-memory store for idle timers per conversation (e.g., by contact phone or conversation id)
const idleTimers = new Map();
const recentWebhookEvents = [];
const MAX_RECENT_EVENTS = 200;
const IDLE_MS = Number(process.env.IDLE_MS || 15 * 60 * 1000); // override via env

function scheduleIdleAlert(key, context) {
  clearIdleAlert(key);
  const timer = setTimeout(async () => {
    try {
      if (!MANAGER_PHONE) {
        console.warn('Manager phone not configured; skipping idle alert');
        return;
      }
      const organizationId = process.env.ORGANIZATION_ID;
      const channelId = process.env.CHANNEL_ID;
      const attendantName = getAttendantNameById(context.attendantId) || context.attendantName || 'Atendente';
      const clientName = context.clientName || context.fromName || context.fromPhone;
      const link = context.link || '';
      const idleTime = '15 minutos';

      const alertMessage = api.formatOrganizedNotification({
        clientName,
        attendantName,
        idleTime,
        link
      });

      console.log('Sending idle alert to manager:', { MANAGER_PHONE, clientName, attendantName });
      await api.sendMessage(channelId, MANAGER_PHONE, alertMessage, organizationId);
    } catch (err) {
      console.error('Failed to send idle alert:', err.message);
    }
  }, IDLE_MS);
  idleTimers.set(key, timer);
}

function clearIdleAlert(key) {
  const t = idleTimers.get(key);
  if (t) {
    clearTimeout(t);
    idleTimers.delete(key);
  }
}

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint to get account info
app.get('/api/info', async (req, res) => {
  try {
    const userInfo = await api.getMe();
    const channels = await api.getChannels();
    
    res.json({
      success: true,
      user: userInfo,
      channels: channels.results || [],
      config: {
        organizationId: process.env.ORGANIZATION_ID,
        channelId: process.env.CHANNEL_ID
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to get channel status
app.get('/api/channel-status/:channelId', async (req, res) => {
  try {
    const channelStatus = await api.getChannelStatus(req.params.channelId);
    res.json({
      success: true,
      channel: channelStatus
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Webhook endpoint to receive UTalk events/messages
// Configure this URL in UTalk dashboard (POST)
app.post('/api/webhook/utalk', async (req, res) => {
  try {
    const event = req.body || {};
    // Normalize fields (UTalk payloads may vary)
    const type = event.type || event.event || '';
    const message = event.message || event.payload || {};
    const conversationId = message.conversationId || message.chatId || message.ticketId || event.conversationId || null;
    const fromPhone = (message.from && (message.from.phone || message.from.phoneNumber)) || message.fromPhone || message.contactPhone || event.fromPhone || null;
    const fromName = (message.from && message.from.name) || message.contactName || event.fromName || null;
    const attendantId = message.attendantId || message.agentId || event.assignedTo || event.attendantId || null;
    const direction = message.direction || event.direction || (type.includes('in') ? 'in' : type.includes('out') ? 'out' : '');

    // Build link using conversationId when available
    const conversationLink = conversationId ? `https://app-utalk.umbler.com/chats/${conversationId}` : null;

    // Build a key to track idle by conversation (fallback to phone)
    const key = conversationId || fromPhone;

    // Record for debug/observability
    if (WEBHOOK_DEBUG) {
      recentWebhookEvents.unshift({
        ts: new Date().toISOString(),
        type,
        direction,
        conversationId,
        fromPhone,
        fromName,
        attendantId,
        attendantName: getAttendantNameById(attendantId) || null
      });
      if (recentWebhookEvents.length > MAX_RECENT_EVENTS) recentWebhookEvents.pop();
      console.log('Webhook received:', { type, direction, conversationId, fromPhone, attendantId });
    }

    // Only schedule idle alert on inbound messages from client
    // If two attendants are talking (both outbound), this will not schedule
    if (direction === 'in') {
      if (key) {
        scheduleIdleAlert(key, {
          attendantId,
          attendantName: getAttendantNameById(attendantId),
          clientName: fromName,
          fromPhone,
          fromName,
          link: conversationLink
        });
      }
    }

    // On any outbound (attendant response), clear the timer for that conversation
    if (direction === 'out') {
      if (key) clearIdleAlert(key);
    }

    // Acknowledge quickly
    res.json({ ok: true });
  } catch (error) {
    console.error('Webhook handling error:', error);
    res.status(200).json({ ok: true });
  }
});

// Debug endpoint to verify webhook arrivals and internal state
app.get('/api/webhook/utalk/debug', (req, res) => {
  try {
    const activeTimers = Array.from(idleTimers.keys());
    res.json({
      success: true,
      activeTimers,
      idleMs: IDLE_MS,
      recentCount: recentWebhookEvents.length,
      recentSample: recentWebhookEvents.slice(0, 20)
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// API endpoint to send message
app.post('/api/send-message', async (req, res) => {
  try {
    const { 
      phoneNumber, 
      message, 
      messageType, 
      templateName, 
      parameters,
      useBusinessFormat,
      attendantName,
      location,
      schedule,
      link,
      useOrganizedFormat,
      clientName,
      idleTime
    } = req.body;

    // Validate input
    if (!phoneNumber || !message) {
      return res.status(400).json({
        success: false,
        error: 'Phone number and message are required'
      });
    }

    // Clean phone number
    const cleanPhoneNumber = phoneNumber.replace(/\D/g, '');
    if (cleanPhoneNumber.length < 8 || cleanPhoneNumber.length > 15 || cleanPhoneNumber.startsWith('0')) {
      return res.status(400).json({
        success: false,
        error: 'Invalid phone number format. Use country code + number (e.g., 554899895903)'
      });
    }

    const organizationId = process.env.ORGANIZATION_ID;
    const channelId = process.env.CHANNEL_ID;

    if (!organizationId || !channelId) {
      return res.status(500).json({
        success: false,
        error: 'Missing configuration. Run: npm run setup'
      });
    }

    // Format message if organized or business format is requested
    let finalMessage = message;
    if (useOrganizedFormat === 'true') {
      finalMessage = api.formatOrganizedNotification({
        clientName,
        attendantName,
        idleTime,
        link
      });
    } else 
    if (useBusinessFormat === 'true') {
      finalMessage = api.formatBusinessMessage(message, attendantName, location, schedule, link);
    }
    let result;

    if (messageType === 'template' && templateName) {
      // Send template message
      const templateParams = parameters ? parameters.split(',').map(p => p.trim()) : [];
      result = await api.sendTemplateMessage(channelId, cleanPhoneNumber, templateName, templateParams, organizationId);
    } else {
      // Send simple message
      console.log('Sending message with params:', {
        channelId,
        cleanPhoneNumber,
        finalMessage,
        organizationId
      });
      result = await api.sendMessage(channelId, cleanPhoneNumber, finalMessage, organizationId);
    }

    res.json({
      success: true,
      data: result,
      sentMessage: finalMessage,
      message: 'Message sent successfully!'
    });

  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to list channels
app.get('/api/channels', async (req, res) => {
  try {
    const channels = await api.getChannels();
    res.json({
      success: true,
      channels: channels.results || []
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to create channel
app.post('/api/create-channel', async (req, res) => {
  try {
    const { name, type } = req.body;
    
    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Channel name is required'
      });
    }

    let result;
    if (type === 'business') {
      const { phoneNumber } = req.body;
      if (!phoneNumber) {
        return res.status(400).json({
          success: false,
          error: 'Phone number is required for business channels'
        });
      }
      result = await api.createBusinessChannel(name, phoneNumber);
    } else {
      result = await api.createStarterChannel(name);
    }

    res.json({
      success: true,
      channel: result,
      message: 'Channel created successfully!'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp UTalk Bot Server running on http://localhost:${PORT}`);
  console.log('\n📋 Available endpoints:');
  console.log('   GET  /               - Web interface');
  console.log('   GET  /api/info       - Account information');
  console.log('   POST /api/send-message - Send WhatsApp message');
  console.log('   GET  /api/channels   - List channels');
  console.log('   POST /api/create-channel - Create new channel');
  console.log('\n📱 Configuration:');
  console.log(`   Organization ID: ${process.env.ORGANIZATION_ID || 'Not set'}`);
  console.log(`   Channel ID: ${process.env.CHANNEL_ID || 'Not set'}`);
  console.log('\n💡 Run "npm run setup" if configuration is missing');
});

module.exports = app;