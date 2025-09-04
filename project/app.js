const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const UTalkAPI = require('./config/api');
const { getAttendantNameById } = require('./config/attendants');

const app = express();
const PORT = process.env.PORT || 3000;
const MANAGER_PHONE = process.env.MANAGER_PHONE; // digits only with country code
const MANAGER_PHONES = (process.env.MANAGER_PHONES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const MANAGER_WEBHOOKS = (process.env.MANAGER_WEBHOOKS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const MANAGER_ATTENDANT_ID = process.env.MANAGER_ATTENDANT_ID; // optional ID mapping
const WEBHOOK_DEBUG = (process.env.WEBHOOK_DEBUG || 'true') === 'true';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Sector-based routing configuration
// Define manager configs (name keys are arbitrary but must match mapping values)
const MANAGERS = {
  PAOLA: {
    id: process.env.MANAGER1_ID || 'ZUpCF58LSKZvBvJr',
    phone: (process.env.MANAGER1_PHONE || '+55 48 98811-2957').replace(/\D/g, ''),
    webhook: process.env.MANAGER1_WEBHOOK || ''
  },
  MICHELE: {
    id: process.env.MANAGER2_ID || 'ZZRSipl_JmIQx5qg',
    phone: (process.env.MANAGER2_PHONE || '+55 48 99622-2357').replace(/\D/g, ''),
    webhook: process.env.MANAGER2_WEBHOOK || ''
  },
  G3: {
    id: process.env.MANAGER3_ID || '',
    phone: (process.env.MANAGER3_PHONE || '').replace(/\D/g, ''),
    webhook: process.env.MANAGER3_WEBHOOK || ''
  }
};

// Map sectors to manager keys. Accepts JSON or ";" separated pairs Sector=MANAGERKEY
function parseSectorManagerMap(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    const map = {};
    String(raw).split(';').map(s => s.trim()).filter(Boolean).forEach(pair => {
      const [sector, managerKey] = pair.split('=').map(x => x && x.trim());
      if (sector && managerKey) map[sector] = managerKey.toUpperCase();
    });
    return map;
  }
}
const SECTOR_MANAGER_MAP = parseSectorManagerMap(process.env.SECTOR_MANAGER_MAP || '');

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (ADMIN_TOKEN && token === ADMIN_TOKEN) return next();
  return res.status(401).json({ success: false, error: 'Unauthorized' });
}

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
// Conversation state (in-memory; for production, use persistent store)
const conversations = new Map(); // key -> { lastInboundAt, lastOutboundAt, alertedAt, meta }
const recentWebhookEvents = [];
const recentWebhookSkips = [];
const MAX_RECENT_EVENTS = 200;
const IDLE_MS = Number(process.env.IDLE_MS || 15 * 60 * 1000); // override via env
const BUSINESS_START_HOUR = 9; // 09:00 local time
const BUSINESS_END_HOUR = 17; // 17:00 local time (non-inclusive)
const MAX_IDLE_ALERT_MINUTES = 60; // if >= 60 minutes de inatividade, não envia

function isBusinessDay(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 6=Sat
  return day >= 1 && day <= 5; // Mon-Fri
}

function isWithinBusinessHours(date) {
  const d = new Date(date);
  const h = d.getHours();
  return isBusinessDay(d) && h >= BUSINESS_START_HOUR && h < BUSINESS_END_HOUR;
}

function getBusinessWindowForDate(date) {
  const d = new Date(date);
  const start = new Date(d);
  start.setHours(BUSINESS_START_HOUR, 0, 0, 0);
  const end = new Date(d);
  end.setHours(BUSINESS_END_HOUR, 0, 0, 0);
  return { start, end };
}

function businessElapsedMs(startMs, endMs) {
  if (!startMs || !endMs || endMs <= startMs) return 0;
  let elapsed = 0;
  let cursor = new Date(startMs);
  const end = new Date(endMs);
  // iterate by days
  while (cursor < end) {
    const { start, end: dayEnd } = getBusinessWindowForDate(cursor);
    const dayStart = start;
    const curEndOfWindow = dayEnd;
    if (isBusinessDay(cursor)) {
      const curStart = cursor > dayStart ? cursor : dayStart;
      const curEnd = end < curEndOfWindow ? end : curEndOfWindow;
      if (curEnd > curStart) {
        elapsed += curEnd - curStart;
      }
    }
    // move to next day 00:00
    const nextDay = new Date(dayStart);
    nextDay.setDate(nextDay.getDate() + 1);
    cursor = nextDay;
  }
  return elapsed;
}

function stableHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function selectManagerPhoneForKey(key) {
  if (MANAGER_PHONES.length > 0) {
    const idx = stableHash(key) % MANAGER_PHONES.length;
    return MANAGER_PHONES[idx];
  }
  return MANAGER_PHONE;
}

function selectManagerWebhookForKey(key) {
  if (MANAGER_WEBHOOKS.length > 0) {
    const idx = stableHash(key) % MANAGER_WEBHOOKS.length;
    return MANAGER_WEBHOOKS[idx];
  }
  return null;
}

function selectManagerBySector(sector) {
  const managerKey = (SECTOR_MANAGER_MAP[sector] || '').toUpperCase();
  if (managerKey && MANAGERS[managerKey]) {
    const m = MANAGERS[managerKey];
    return { managerKey, webhook: m.webhook || null, phone: m.phone || null };
  }
  return null;
}

function extractSectorFromEvent(event, message) {
  // Try common fields that might carry department/sector info, prioritizing specific fields
  const tryValues = [
    event.sector, event.Sector, event.department, event.Department, // Direct event fields
    event.queue, event.Queue, event.tag, event.Tag, event.team, event.Team,
    
    // Nested within Payload.Content for Chat snapshots
    (event.Payload && event.Payload.Content && (event.Payload.Content.Sector || event.Payload.Content.Department || event.Payload.Content.Queue || event.Payload.Content.Tag || event.Payload.Content.Team)),
    (event.payload && event.payload.Content && (event.payload.Content.Sector || event.payload.Content.Department || event.payload.Content.Queue || event.payload.Content.Tag || event.payload.Content.Team)),

    // Nested within message object
    message && (message.sector || message.department || message.queue || message.tag || message.team),
    
    // Additional potential nested fields (e.g., in a 'context' or 'metadata' object)
    (event.Context && (event.Context.Sector || event.Context.Department)),
    (event.metadata && (event.metadata.sector || event.metadata.department))

  ].filter(Boolean);
  if (tryValues.length > 0) return String(tryValues[0]).trim();
  return 'Geral';
}

// Stats for admin
const alertStats = {
  totalAlertsSent: 0,
  byManager: {},
  byDay: {}
};

function recordAlertStat(targetKey, whenMs) {
  alertStats.totalAlertsSent += 1;
  if (targetKey) {
    alertStats.byManager[targetKey] = (alertStats.byManager[targetKey] || 0) + 1;
  }
  const day = new Date(whenMs).toISOString().slice(0, 10);
  alertStats.byDay[day] = (alertStats.byDay[day] || 0) + 1;
}

async function maybeSendDueAlerts(now = Date.now()) {
  const hasAnyManager = MANAGER_WEBHOOKS.length > 0 || MANAGER_PHONES.length > 0 || MANAGER_PHONE;
  if (!hasAnyManager) return;
  const organizationId = process.env.ORGANIZATION_ID;
  const channelId = process.env.CHANNEL_ID;
  for (const [key, state] of conversations.entries()) {
    const { lastInboundAt, lastOutboundAt, alertedAt, meta } = state;
    if (!lastInboundAt) continue;
    const replied = lastOutboundAt && lastOutboundAt >= lastInboundAt;
    const businessElapsed = businessElapsedMs(lastInboundAt, now);
    const overdue = businessElapsed >= IDLE_MS;
    const alreadyAlerted = Boolean(alertedAt) && alertedAt >= lastInboundAt;
    const overCap = businessElapsed >= MAX_IDLE_ALERT_MINUTES * 60000; // >= 60 min úteis
    const nowWithinHours = isWithinBusinessHours(now);
    if (!replied && overdue && !overCap && !alreadyAlerted && nowWithinHours) {
      const attendantName = getAttendantNameById(meta.attendantId) || meta.attendantName || 'Atendente';
      const clientName = meta.clientName || meta.fromName || meta.fromPhone;
      const link = meta.link || '';
      const minutes = Math.round(businessElapsed / 60000);
      // Prefer sector-based routing if sector is known
      const sector = meta.sector || 'Geral';
      const sectorTarget = selectManagerBySector(sector);
      const managerWebhook = (sectorTarget && sectorTarget.webhook) || selectManagerWebhookForKey(key);
      const managerPhone = (sectorTarget && sectorTarget.phone) || selectManagerPhoneForKey(key);
      const alertMessage = api.formatOrganizedNotification({ clientName, attendantName, idleTime: `${minutes} minutos`, link });
      try {
        if (managerWebhook) {
          console.log('Posting idle alert to manager webhook:', { key, sector, managerWebhook, clientName, attendantName, minutes });
          await require('axios').post(managerWebhook, {
            type: 'idle-alert',
            conversationId: key,
            clientName,
            attendantName,
            idleMinutes: minutes,
            link,
            sector,
            occurredAt: new Date(now).toISOString()
          }, { headers: { 'Content-Type': 'application/json' } });
          recordAlertStat(managerWebhook, now);
        } else if (managerPhone) {
          console.log('Sending idle alert to manager phone:', { key, sector, managerPhone, clientName, attendantName, minutes });
          await api.sendMessage(channelId, managerPhone, alertMessage, organizationId);
          recordAlertStat(managerPhone, now);
        } else {
          console.warn('No manager target configured for key:', key);
        }
        state.alertedAt = now;
      } catch (e) {
        console.error('Failed to send idle alert:', e.message);
      }
    }
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
    const type = event.type || event.Type || event.event || '';
    let message = event.message || event.Message || event.payload || event.Payload || {};

    // Robustly extract conversationId, fromPhone, fromName, attendantId, direction
    let conversationId = 
        event.conversationId || event.ConversationId ||
        message.conversationId || message.chatId || message.ticketId ||
        (message.Chat && message.Chat.Id) ||
        (event.Payload && event.Payload.Content && event.Payload.Content.Id) ||
        (event.payload && event.payload.Content && event.payload.Content.Id) ||
        (message.Chat && message.Chat.Id) || null;

    let fromPhone = 
        event.fromPhone || event.FromPhone ||
        message.fromPhone || message.contactPhone ||
        (message.from && (message.from.phone || message.from.phoneNumber)) ||
        (event.Payload && event.Payload.Content && event.Payload.Content.Contact && (event.Payload.Content.Contact.PhoneNumber || event.Payload.Content.Contact.Phone)) ||
        (event.payload && event.payload.Content && event.payload.Content.Contact && (event.payload.Content.Contact.PhoneNumber || event.payload.Content.Contact.Phone)) ||
        null;

    let fromName =
        event.fromName || event.FromName ||
        message.fromName || message.contactName ||
        (message.from && message.from.name) ||
        (event.Payload && event.Payload.Content && event.Payload.Content.Contact && event.Payload.Content.Contact.Name) ||
        (event.payload && event.payload.Content && event.payload.Content.Contact && event.payload.Content.Contact.Name) ||
        null;
        
    let attendantId =
        event.attendantId || event.AttendantId ||
        message.attendantId || message.agentId || message.AssignedTo || event.assignedTo ||
        (event.Payload && event.Payload.Content && event.Payload.Content.OrganizationMember && event.Payload.Content.OrganizationMember.Id) ||
        (event.payload && event.payload.Content && event.payload.Content.OrganizationMember && event.payload.Content.OrganizationMember.Id) ||
        (message.SentByOrganizationMember && message.SentByOrganizationMember.Id) || null;

    let direction = message.direction || event.direction || (typeof type === 'string' ? (type.includes('in') ? 'in' : type.includes('out') ? 'out' : '') : '');

    // Handle Chat snapshot style (Payload.Type === 'Chat') - this part is already quite robust, keep it
    const payloadType = (event.Payload && event.Payload.Type) || (event.payload && event.payload.Type) || null;
    const content = (event.Payload && event.Payload.Content) || (event.payload && event.payload.Content) || null;
    if (payloadType === 'Chat' && content) {
      const lastMessage = content.LastMessage || {};
      conversationId = (lastMessage.Chat && lastMessage.Chat.Id) || content.Id || conversationId;
      fromPhone = (content.Contact && (content.Contact.PhoneNumber || content.Contact.Phone)) || fromPhone;
      fromName = (content.Contact && content.Contact.Name) || fromName;
      attendantId = (lastMessage.SentByOrganizationMember && lastMessage.SentByOrganizationMember.Id) || attendantId;
      const src = lastMessage.Source || null; // 'Member' for attendant, 'Contact' for client
      if (!direction) {
        if (src === 'Member' || attendantId) direction = 'out';
        else if (src === 'Contact') direction = 'in';
      }
      // For observability
      message = { ...message, conversationId, contactPhone: fromPhone, contactName: fromName };
    }

    // Normalize phone to digits if present
    if (fromPhone) {
      fromPhone = String(fromPhone).replace(/\D/g, '');
      if (fromPhone.length === 0) fromPhone = null;
    }

    // Build link using conversationId when available
    const conversationLink = conversationId ? `https://app-utalk.umbler.com/chats/${conversationId}` : null;

    // Build a key to track idle by conversation (fallbacks)
    const contactId = (event.Payload && event.Payload.Content && event.Payload.Content.Contact && event.Payload.Content.Contact.Id)
      || (event.payload && event.payload.Content && event.payload.Content.Contact && event.payload.Content.Contact.Id)
      || null;
    const key = conversationId || fromPhone || contactId;

    // Extract sector for routing - enhance this as well
    const sector = extractSectorFromEvent(event, message);

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
        attendantName: getAttendantNameById(attendantId) || null,
        sector
      });
      if (recentWebhookEvents.length > MAX_RECENT_EVENTS) recentWebhookEvents.pop();
      console.log('Webhook received (processed):', { type, direction, conversationId, fromPhone, attendantId, sector, key }); // Enhanced logging
    }

    // Update conversation state; do NOT send here to avoid per-webhook sends
    if (key && direction) {
      const now = Date.now();
      const state = conversations.get(key) || { lastInboundAt: null, lastOutboundAt: null, alertedAt: null, meta: {} };
      if (direction === 'in') {
        state.lastInboundAt = now;
        // reset alert marker on new inbound
        state.alertedAt = null;
        state.meta = { attendantId, fromPhone, fromName, clientName: fromName, link: conversationLink, sector };
      } else if (direction === 'out') {
        state.lastOutboundAt = now;
        // allow future alerts after new inbound
      }
      conversations.set(key, state);
    } else {
      // Record skip reason for debug
      const reason = !key ? 'missing_key' : !direction ? 'missing_direction' : 'unknown';
      recentWebhookSkips.unshift({ ts: new Date().toISOString(), reason, conversationId, fromPhone, type, payloadType, event });
      if (recentWebhookSkips.length > MAX_RECENT_EVENTS) recentWebhookSkips.pop();
      console.error('Webhook skipped. Reason:', reason, { conversationId, fromPhone, type, payloadType, event, normalizedKey: key, normalizedDirection: direction }); // Even more enhanced logging
    }

    // Acknowledge quickly
    res.json({ ok: true });
  } catch (error) {
    console.error('Webhook handling error:', error);
    res.status(200).json({ ok: true });
  }
});

// Debug endpoint to verify webhook arrivals and internal state
app.get('/api/webhook/utalk/debug', requireAdmin, (req, res) => {
  try {
    const states = Array.from(conversations.entries()).map(([key, s]) => ({ key, lastInboundAt: s.lastInboundAt, lastOutboundAt: s.lastOutboundAt, alertedAt: s.alertedAt, sector: s.meta && s.meta.sector }));
    res.json({
      success: true,
      conversations: states,
      idleMs: IDLE_MS,
      businessHours: { startHour: BUSINESS_START_HOUR, endHour: BUSINESS_END_HOUR },
      managerPhones: MANAGER_PHONES.length ? MANAGER_PHONES : (MANAGER_PHONE ? [MANAGER_PHONE] : []),
      managerWebhooks: MANAGER_WEBHOOKS,
      sectorManagerMap: SECTOR_MANAGER_MAP,
      managersConfigured: Object.fromEntries(Object.entries(MANAGERS).map(([k, v]) => [k, { hasWebhook: Boolean(v.webhook), hasPhone: Boolean(v.phone) } ])),
      stats: alertStats,
      recentCount: recentWebhookEvents.length,
      recentSample: recentWebhookEvents.slice(0, 20),
      recentSkips: recentWebhookSkips.slice(0, 20)
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Cron/sweep endpoint to evaluate due alerts
app.post('/api/webhook/utalk/sweep', requireAdmin, async (req, res) => {
  try {
    await maybeSendDueAlerts(Date.now());
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Admin: reset stats
app.post('/api/admin/reset-stats', requireAdmin, (req, res) => {
  alertStats.totalAlertsSent = 0;
  alertStats.byManager = {};
  alertStats.byDay = {};
  res.json({ success: true });
});

// Manual test endpoint to send an immediate alert to manager
app.post('/api/test/send-manager-alert', async (req, res) => {
  try {
    if (!MANAGER_PHONE) {
      return res.status(400).json({ success: false, error: 'MANAGER_PHONE is not configured' });
    }
    const organizationId = process.env.ORGANIZATION_ID;
    const channelId = process.env.CHANNEL_ID;
    const { clientName = 'Cliente Teste', attendantId = MANAGER_ATTENDANT_ID, conversationId = 'TEST_CONV_MANUAL' } = req.body || {};
    const attendantName = getAttendantNameById(attendantId) || 'Atendente';
    const link = `https://app-utalk.umbler.com/chats/${conversationId}`;
    const alertMessage = api.formatOrganizedNotification({ clientName, attendantName, idleTime: '15 minutos', link });
    const result = await api.sendMessage(channelId, MANAGER_PHONE, alertMessage, organizationId);
    res.json({ success: true, data: result, sentMessage: alertMessage });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
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