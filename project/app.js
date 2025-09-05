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
    // Direct event fields
    event.sector, event.Sector, event.department, event.Department,
    event.queue, event.Queue, event.tag, event.Tag, event.team, event.Team,
    
    // Nested within Payload.Content for Chat snapshots  
    (event.Payload && event.Payload.Content && (
      event.Payload.Content.Sector || event.Payload.Content.Department || 
      event.Payload.Content.Queue || event.Payload.Content.Tag || 
      event.Payload.Content.Team || event.Payload.Content.sector ||
      event.Payload.Content.department
    )),
    (event.payload && event.payload.Content && (
      event.payload.Content.Sector || event.payload.Content.Department || 
      event.payload.Content.Queue || event.payload.Content.Tag || 
      event.payload.Content.Team || event.payload.Content.sector ||
      event.payload.Content.department
    )),

    // Nested within message object  
    message && (message.sector || message.Sector || message.department || 
               message.Department || message.queue || message.Queue || 
               message.tag || message.Tag || message.team || message.Team),
    
    // Additional potential nested fields
    (event.Context && (event.Context.Sector || event.Context.Department || 
                      event.Context.sector || event.Context.department)),
    (event.metadata && (event.metadata.sector || event.metadata.department ||
                       event.metadata.Sector || event.metadata.Department)),
    (event.context && (event.context.sector || event.context.department ||
                      event.context.Sector || event.context.Department))

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
  
  console.log('=== CHECKING FOR DUE ALERTS ===');
  console.log('Total conversations:', conversations.size);
  console.log('Current time:', new Date(now).toISOString());
  console.log('Business hours check:', isWithinBusinessHours(now));
  
  for (const [key, state] of conversations.entries()) {
    const { lastInboundAt, lastOutboundAt, alertedAt, meta } = state;
    
    if (!lastInboundAt) continue;
    
    const replied = lastOutboundAt && lastOutboundAt >= lastInboundAt;
    const businessElapsed = businessElapsedMs(lastInboundAt, now);
    const overdue = businessElapsed >= IDLE_MS;
    const alreadyAlerted = Boolean(alertedAt) && alertedAt >= lastInboundAt;
    const overCap = businessElapsed >= MAX_IDLE_ALERT_MINUTES * 60000; // >= 60 min úteis
    const nowWithinHours = isWithinBusinessHours(now);
    
    console.log(`[${key}] Checking conversation:`, {
      lastInboundAt: new Date(lastInboundAt).toISOString(),
      lastOutboundAt: lastOutboundAt ? new Date(lastOutboundAt).toISOString() : null,
      replied,
      businessElapsed: Math.round(businessElapsed / 60000) + ' min',
      overdue,
      alreadyAlerted,
      overCap,
      nowWithinHours
    });
    
    if (!replied && overdue && !overCap && !alreadyAlerted && nowWithinHours) {
      console.log(`[${key}] SENDING ALERT - Conditions met`);
      
      const attendantName = getAttendantNameById(meta.attendantId) || meta.attendantName || 'Atendente Responsável';
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
          console.log(`[${key}] Sending webhook alert:`, { sector, webhook: managerWebhook, clientName, attendantName, minutes });
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
          console.log(`[${key}] Sending WhatsApp alert:`, { sector, phone: managerPhone, clientName, attendantName, minutes });
          await api.sendMessage(channelId, managerPhone, alertMessage, organizationId);
          recordAlertStat(managerPhone, now);
        } else {
          console.warn(`[${key}] No manager target configured`);
        }
        state.alertedAt = now;
        console.log(`[${key}] Alert sent successfully`);
      } catch (e) {
        console.error(`[${key}] Failed to send alert:`, e.message);
      }
    } else {
      console.log(`[${key}] No alert needed:`, {
        replied,
        overdue,
        alreadyAlerted,
        nowWithinHours,
        overCap
      });
    }
  }
  console.log('=== ALERT CHECK COMPLETE ===');
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
    
    if (WEBHOOK_DEBUG) {
      console.log('=== RAW WEBHOOK RECEIVED ===');
      console.log(JSON.stringify(event, null, 2));
      console.log('================================');
    }

    // Extract webhook data with improved logic
    const webhookData = extractWebhookData(event);
    
    if (WEBHOOK_DEBUG) {
      console.log('=== EXTRACTED WEBHOOK DATA ===');
      console.log(JSON.stringify(webhookData, null, 2));
      console.log('===============================');
    }

    const { conversationId, fromPhone, fromName, attendantId, direction, sector, messageText } = webhookData;

    // Build conversation link
    const conversationLink = conversationId ? `https://app-utalk.umbler.com/chats/${conversationId}` : null;

    // Build key for tracking (priority: conversationId > fromPhone)
    const key = conversationId || fromPhone;

    // Record for debug/observability
    if (WEBHOOK_DEBUG) {
      recentWebhookEvents.unshift({
        ts: new Date().toISOString(),
        type: event.type || event.Type || 'unknown',
        direction,
        conversationId,
        fromPhone,
        fromName,
        attendantId,
        attendantName: getAttendantNameById(attendantId) || null,
        sector,
        messageText: messageText ? messageText.substring(0, 100) : null
      });
      if (recentWebhookEvents.length > MAX_RECENT_EVENTS) recentWebhookEvents.pop();
      console.log('=== WEBHOOK PROCESSED ===');
      console.log('Key:', key);
      console.log('Direction:', direction);
      console.log('ConversationId:', conversationId);
      console.log('FromPhone:', fromPhone);
      console.log('AttendantId:', attendantId);
      console.log('Sector:', sector);
      console.log('========================');
    }

    // Update conversation state; do NOT send here to avoid per-webhook sends
    if (key && direction) {
      const now = Date.now();
      const state = conversations.get(key) || { lastInboundAt: null, lastOutboundAt: null, alertedAt: null, meta: {} };
      
      if (direction === 'in') {
        console.log(`[${key}] CLIENT MESSAGE - Resetting alert timer`);
        state.lastInboundAt = now;
        // reset alert marker on new inbound
        state.alertedAt = null;
        state.meta = { 
          attendantId: null, // Client message has no attendant
          fromPhone, 
          fromName, 
          clientName: fromName, 
          link: conversationLink, 
          sector,
          lastMessageText: messageText
        };
      } else if (direction === 'out') {
        console.log(`[${key}] ATTENDANT MESSAGE - Canceling alert timer`);
        state.lastOutboundAt = now;
        // Update attendant info but keep client info
        state.meta = { 
          ...state.meta,
          attendantId, 
          attendantName: getAttendantNameById(attendantId),
          lastMessageText: messageText
        };
      }
      conversations.set(key, state);
    } else {
      // Record skip reason for debug
      const reason = !key ? 'missing_key' : !direction ? 'missing_direction' : 'other';
      recentWebhookSkips.unshift({ ts: new Date().toISOString(), reason, conversationId, fromPhone, type, payloadType, event });
      if (recentWebhookSkips.length > MAX_RECENT_EVENTS) recentWebhookSkips.pop();
      console.error('=== WEBHOOK SKIPPED ===');
      console.error('Reason:', reason);
      console.error('Key:', key);
      console.error('Direction:', direction);
      console.error('ConversationId:', conversationId);
      console.error('FromPhone:', fromPhone);
      console.error('======================');
    }

    // Acknowledge quickly
    res.json({ ok: true });
  } catch (error) {
    console.error('Webhook handling error:', error);
    res.status(200).json({ ok: true });
  }
});

// Enhanced webhook data extraction function
function extractWebhookData(event) {
  let conversationId = null;
  let fromPhone = null;
  let fromName = null;
  let attendantId = null;
  let direction = null;
  let messageText = null;
  let sector = 'Geral';

  // Check for Chat snapshot format (most common)
  const payloadType = (event.Payload && event.Payload.Type) || (event.payload && event.payload.Type);
  const content = (event.Payload && event.Payload.Content) || (event.payload && event.payload.Content);
  
  if (payloadType === 'Chat' && content) {
    // Chat snapshot webhook
    const lastMessage = content.LastMessage || {};
    
    conversationId = content.Id || (lastMessage.Chat && lastMessage.Chat.Id);
    fromPhone = (content.Contact && (content.Contact.PhoneNumber || content.Contact.Phone));
    fromName = (content.Contact && content.Contact.Name);
    messageText = lastMessage.Text || lastMessage.Content || lastMessage.MessageText;
    
    // Determine direction based on message source
    const messageSource = lastMessage.Source;
    const sentByMember = lastMessage.SentByOrganizationMember;
    
    if (messageSource === 'Contact') {
      direction = 'in';
      attendantId = null;
    } else if (messageSource === 'Member' && sentByMember && sentByMember.Id) {
      direction = 'out';
      attendantId = sentByMember.Id;
    }
    
    // Extract sector from various possible locations
    sector = extractSectorFromEvent(event, content) || 'Geral';
    
  } else {
    // Direct message webhook or other formats
    const message = event.message || event.Message || event.payload || event.Payload || {};
    
    // Try multiple extraction patterns
    conversationId = event.conversationId || event.ConversationId || 
                    message.conversationId || message.chatId || message.ticketId ||
                    (message.Chat && message.Chat.Id);
    
    fromPhone = event.fromPhone || event.FromPhone ||
                message.fromPhone || message.contactPhone ||
                (message.from && (message.from.phone || message.from.phoneNumber));
    
    fromName = event.fromName || event.FromName ||
               message.fromName || message.contactName ||
               (message.from && message.from.name);
    
    attendantId = event.attendantId || event.AttendantId ||
                  message.attendantId || message.agentId || 
                  (message.SentByOrganizationMember && message.SentByOrganizationMember.Id);
    
    messageText = message.text || message.Text || message.content || message.Content || message.message;
    
    // Determine direction
    direction = message.direction || event.direction;
    if (!direction) {
      const type = event.type || event.Type || '';
      if (type.includes('in') || type.includes('inbound')) direction = 'in';
      else if (type.includes('out') || type.includes('outbound')) direction = 'out';
      else if (attendantId) direction = 'out';
      else direction = 'in'; // Default assumption
    }
    
    sector = extractSectorFromEvent(event, message) || 'Geral';
  }

  // Normalize phone number
  if (fromPhone) {
    fromPhone = String(fromPhone).replace(/\D/g, '');
    if (fromPhone.length === 0) fromPhone = null;
  }

  return {
    conversationId,
    fromPhone,
    fromName,
    attendantId,
    direction,
    messageText,
    sector
  };
}

// Debug endpoint to verify webhook arrivals and internal state
app.get('/api/webhook/utalk/debug', requireAdmin, (req, res) => {
  try {
    const states = Array.from(conversations.entries()).map(([key, s]) => ({
      key,
      lastInboundAt: s.lastInboundAt,
      lastOutboundAt: s.lastOutboundAt,
      alertedAt: s.alertedAt,
      sector: s.meta && s.meta.sector,
      clientName: s.meta && s.meta.clientName,
      attendantId: s.meta && s.meta.attendantId,
      attendantName: s.meta && s.meta.attendantName,
      link: s.meta && s.meta.link,
      timeSinceLastInbound: s.lastInboundAt ? Math.round((Date.now() - s.lastInboundAt) / 60000) + ' min' : null,
      businessElapsed: s.lastInboundAt ? Math.round(businessElapsedMs(s.lastInboundAt, Date.now()) / 60000) + ' min' : null,
      shouldAlert: s.lastInboundAt && !s.alertedAt && 
                   (!s.lastOutboundAt || s.lastOutboundAt < s.lastInboundAt) &&
                   businessElapsedMs(s.lastInboundAt, Date.now()) >= IDLE_MS &&
                   businessElapsedMs(s.lastInboundAt, Date.now()) < MAX_IDLE_ALERT_MINUTES * 60000 &&
                   isWithinBusinessHours(Date.now())
    }));
    
    res.json({
      success: true,
      currentTime: new Date().toISOString(),
      isBusinessHours: isWithinBusinessHours(Date.now()),
      conversations: states,
      idleMs: IDLE_MS,
      idleMinutes: IDLE_MS / 60000,
      maxIdleAlertMinutes: MAX_IDLE_ALERT_MINUTES,
      businessHours: { startHour: BUSINESS_START_HOUR, endHour: BUSINESS_END_HOUR },
      managerPhones: MANAGER_PHONES.length ? MANAGER_PHONES : (MANAGER_PHONE ? [MANAGER_PHONE] : []),
      managerWebhooks: MANAGER_WEBHOOKS,
      sectorManagerMap: SECTOR_MANAGER_MAP,
      managersConfigured: Object.fromEntries(Object.entries(MANAGERS).map(([k, v]) => [k, { hasWebhook: Boolean(v.webhook), hasPhone: Boolean(v.phone) } ])),
      stats: alertStats,
      recentCount: recentWebhookEvents.length,
      recentSample: recentWebhookEvents.slice(0, 20),
      recentSkips: recentWebhookSkips.slice(0, 20),
      totalConversations: conversations.size,
      conversationsNeedingAlert: states.filter(s => s.shouldAlert).length
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

// Test endpoint to simulate client message (inbound)
app.post('/api/test/simulate-client-message', async (req, res) => {
  try {
    const { conversationId = 'TEST_CONV_CLIENT', clientPhone = '5511999999999', clientName = 'Cliente Teste', sector = 'Geral' } = req.body;
    
    // Simulate UTalk webhook for client message
    const simulatedWebhook = {
      Type: 'Message',
      Payload: {
        Type: 'Chat',
        Content: {
          Id: conversationId,
          Contact: {
            PhoneNumber: clientPhone,
            Name: clientName
          },
          LastMessage: {
            Source: 'Contact',
            Text: 'Olá, preciso de ajuda!',
            Chat: { Id: conversationId }
          }
        }
      },
      Sector: sector
    };
    
    // Process the webhook
    const webhookData = extractWebhookData(simulatedWebhook);
    const key = webhookData.conversationId || webhookData.fromPhone;
    
    if (key && webhookData.direction === 'in') {
      const now = Date.now();
      const state = conversations.get(key) || { lastInboundAt: null, lastOutboundAt: null, alertedAt: null, meta: {} };
      
      state.lastInboundAt = now;
      state.alertedAt = null;
      state.meta = {
        attendantId: null,
        fromPhone: webhookData.fromPhone,
        fromName: webhookData.fromName,
        clientName: webhookData.fromName,
        link: `https://app-utalk.umbler.com/chats/${conversationId}`,
        sector: webhookData.sector
      };
      
      conversations.set(key, state);
      
      res.json({
        success: true,
        message: 'Client message simulated successfully',
        data: { key, webhookData, state }
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Failed to process simulated webhook',
        webhookData
      });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Test endpoint to simulate attendant reply (outbound)
app.post('/api/test/simulate-attendant-reply', async (req, res) => {
  try {
    const { conversationId = 'TEST_CONV_CLIENT', attendantId = 'aGevxChnIrrCytFy', clientPhone = '5511999999999', clientName = 'Cliente Teste' } = req.body;
    
    // Simulate UTalk webhook for attendant reply
    const simulatedWebhook = {
      Type: 'Message',
      Payload: {
        Type: 'Chat',
        Content: {
          Id: conversationId,
          Contact: {
            PhoneNumber: clientPhone,
            Name: clientName
          },
          LastMessage: {
            Source: 'Member',
            Text: 'Olá! Como posso ajudar?',
            Chat: { Id: conversationId },
            SentByOrganizationMember: { Id: attendantId }
          }
        }
      }
    };
    
    // Process the webhook
    const webhookData = extractWebhookData(simulatedWebhook);
    const key = webhookData.conversationId || webhookData.fromPhone;
    
    if (key && webhookData.direction === 'out') {
      const now = Date.now();
      const state = conversations.get(key) || { lastInboundAt: null, lastOutboundAt: null, alertedAt: null, meta: {} };
      
      state.lastOutboundAt = now;
      state.meta = {
        ...state.meta,
        attendantId: webhookData.attendantId,
        attendantName: getAttendantNameById(webhookData.attendantId)
      };
      
      conversations.set(key, state);
      
      res.json({
        success: true,
        message: 'Attendant reply simulated successfully',
        data: { key, webhookData, state }
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Failed to process simulated webhook',
        webhookData
      });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Test endpoint for complete flow
app.post('/api/test/complete-flow', async (req, res) => {
  try {
    const conversationId = `TEST_FLOW_${Date.now()}`;
    const clientPhone = '5511999999999';
    const clientName = 'Cliente Teste Completo';
    
    // Step 1: Simulate client message
    const clientWebhook = {
      Type: 'Message',
      Payload: {
        Type: 'Chat',
        Content: {
          Id: conversationId,
          Contact: { PhoneNumber: clientPhone, Name: clientName },
          LastMessage: {
            Source: 'Contact',
            Text: 'Preciso de ajuda urgente!',
            Chat: { Id: conversationId }
          }
        }
      }
    };
    
    const clientData = extractWebhookData(clientWebhook);
    const key = clientData.conversationId;
    
    // Process client message
    const now = Date.now();
    const state = {
      lastInboundAt: now,
      lastOutboundAt: null,
      alertedAt: null,
      meta: {
        attendantId: null,
        fromPhone: clientData.fromPhone,
        fromName: clientData.fromName,
        clientName: clientData.fromName,
        link: `https://app-utalk.umbler.com/chats/${conversationId}`,
        sector: 'Geral'
      }
    };
    
    conversations.set(key, state);
    
    res.json({
      success: true,
      message: 'Complete test flow initiated',
      data: {
        conversationId,
        key,
        state,
        instructions: [
          'Client message has been simulated',
          `Wait ${IDLE_MS / 60000} minutes for automatic alert`,
          'Or call POST /api/webhook/utalk/sweep to force check',
          'Check debug endpoint for conversation state'
        ]
      }
    });
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
  console.log('   POST /api/webhook/utalk - UTalk webhook endpoint');
  console.log('   GET  /api/webhook/utalk/debug - Debug webhook state');
  console.log('\n📱 Configuration:');
  console.log(`   Organization ID: ${process.env.ORGANIZATION_ID || 'Not set'}`);
  console.log(`   Channel ID: ${process.env.CHANNEL_ID || 'Not set'}`);
  console.log(`   Manager Phone: ${MANAGER_PHONE || 'Not set'}`);
  console.log(`   Idle Time: ${IDLE_MS / 60000} minutes`);
  console.log('\n💡 Run "npm run setup" if configuration is missing');
  
  // Start automatic alert checking (important for serverless environments)
  startAlertChecker();
});

// Automatic alert checker for serverless environments
function startAlertChecker() {
  const CHECK_INTERVAL = 60000; // Check every minute
  
  console.log('🔄 Starting automatic alert checker...');
  
  setInterval(async () => {
    try {
      await maybeSendDueAlerts(Date.now());
    } catch (error) {
      console.error('Alert checker error:', error.message);
    }
  }, CHECK_INTERVAL);
  
  console.log(`✅ Alert checker started (interval: ${CHECK_INTERVAL / 1000}s)`);
}

module.exports = app;