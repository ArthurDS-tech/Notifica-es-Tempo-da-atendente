const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const UTalkAPI = require('./config/api');
const { getAttendantNameById } = require('./config/attendants');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIGURAÇÃO DO CHAT DE ALERTAS =====
const ALERT_CHAT_ID = process.env.ALERT_CHAT_ID || 'aLrR-GU3ZQBaslwU';
const MANAGER_PHONE = process.env.MANAGER_PHONE; // fallback apenas
const MANAGER_ATTENDANT_ID = process.env.MANAGER_ATTENDANT_ID;
const WEBHOOK_DEBUG = (process.env.WEBHOOK_DEBUG || 'true') === 'true';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Configurações de tempo
const IDLE_MS = Number(process.env.IDLE_MS || 15 * 60 * 1000); // 15 minutos padrão
const MAX_IDLE_ALERT_MINUTES = Number(process.env.MAX_IDLE_ALERT_MINUTES || 60); // 60 min máx
const BUSINESS_START_HOUR = Number(process.env.BUSINESS_START_HOUR || 9); // 09:00
const BUSINESS_END_HOUR = Number(process.env.BUSINESS_END_HOUR || 17); // 17:00

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

// ===== SISTEMA DE MONITORAMENTO DE CONVERSAS =====
const conversations = new Map(); // key -> { lastInboundAt, lastOutboundAt, alertedAt, meta }
const recentWebhookEvents = [];
const recentWebhookSkips = [];
const MAX_RECENT_EVENTS = 200;

// Estatísticas de alertas
const alertStats = {
  totalAlertsSent: 0,
  alertsToChat: 0,
  alertsToFallback: 0,
  byDay: {},
  startTime: Date.now()
};

// ===== FUNÇÕES DE HORÁRIO COMERCIAL =====
function isBusinessDay(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Dom, 6=Sáb
  return day >= 1 && day <= 5; // Seg-Sex
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

// Calcula tempo útil (horário comercial) entre duas datas
function businessElapsedMs(startMs, endMs) {
  if (!startMs || !endMs || endMs <= startMs) return 0;
  let elapsed = 0;
  let cursor = new Date(startMs);
  const end = new Date(endMs);
  
  while (cursor < end) {
    const { start: dayStart, end: dayEnd } = getBusinessWindowForDate(cursor);
    
    if (isBusinessDay(cursor)) {
      const curStart = cursor > dayStart ? cursor : dayStart;
      const curEnd = end < dayEnd ? end : dayEnd;
      if (curEnd > curStart) {
        elapsed += curEnd - curStart;
      }
    }
    
    // Move para próximo dia às 00:00
    const nextDay = new Date(dayStart);
    nextDay.setDate(nextDay.getDate() + 1);
    cursor = nextDay;
  }
  
  return elapsed;
}

// ===== ENVIO DE ALERTAS PARA CHAT ESPECÍFICO =====
async function sendAlertToChat(conversationData) {
  const organizationId = process.env.ORGANIZATION_ID;
  const channelId = process.env.CHANNEL_ID;
  
  if (!ALERT_CHAT_ID) {
    console.warn('ALERT_CHAT_ID não configurado, usando fallback');
    return await sendAlertFallback(conversationData);
  }

  const { key, clientName, attendantName, idleMinutes, link, sector } = conversationData;
  
  // Mensagem formatada para o chat de alertas
  const alertMessage = `🚨 *ALERTA DE INATIVIDADE*

👤 *Cliente:* ${clientName || 'Nome não informado'}
🧑‍💼 *Atendente:* ${attendantName || 'Não definido'}
📍 *Setor:* ${sector || 'Geral'}
⏱️ *Tempo sem resposta:* ${idleMinutes} minutos
🔗 *Link da conversa:* ${link || 'Não disponível'}
📅 *Data/Hora:* ${new Date().toLocaleString('pt-BR')}

_Alerta automático do sistema UTalk Bot_`;

  try {
    console.log(`[${key}] Enviando alerta para chat ${ALERT_CHAT_ID}`);
    
    // Envia mensagem diretamente para o chat através da API
    const result = await api.sendMessageToChat(ALERT_CHAT_ID, alertMessage, organizationId);
    
    alertStats.totalAlertsSent++;
    alertStats.alertsToChat++;
    
    const today = new Date().toISOString().slice(0, 10);
    alertStats.byDay[today] = (alertStats.byDay[today] || 0) + 1;
    
    console.log(`[${key}] ✅ Alerta enviado com sucesso para chat ${ALERT_CHAT_ID}`);
    return { success: true, target: 'chat', result };
    
  } catch (error) {
    console.error(`[${key}] ❌ Erro ao enviar para chat ${ALERT_CHAT_ID}:`, error.message);
    
    // Fallback para telefone se chat falhar
    console.log(`[${key}] Tentando fallback...`);
    return await sendAlertFallback(conversationData);
  }
}

// Fallback caso o chat não funcione
async function sendAlertFallback(conversationData) {
  if (!MANAGER_PHONE) {
    console.warn('Nenhum fallback configurado (MANAGER_PHONE)');
    return { success: false, error: 'No fallback configured' };
  }

  const organizationId = process.env.ORGANIZATION_ID;
  const channelId = process.env.CHANNEL_ID;
  const { key, clientName, attendantName, idleMinutes, link } = conversationData;
  
  const fallbackMessage = api.formatOrganizedNotification({
    clientName,
    attendantName,
    idleTime: `${idleMinutes} minutos`,
    link
  });

  try {
    console.log(`[${key}] Enviando fallback para WhatsApp ${MANAGER_PHONE}`);
    const result = await api.sendMessage(channelId, MANAGER_PHONE, fallbackMessage, organizationId);
    
    alertStats.totalAlertsSent++;
    alertStats.alertsToFallback++;
    
    const today = new Date().toISOString().slice(0, 10);
    alertStats.byDay[today] = (alertStats.byDay[today] || 0) + 1;
    
    console.log(`[${key}] ✅ Alerta fallback enviado com sucesso`);
    return { success: true, target: 'fallback', result };
    
  } catch (error) {
    console.error(`[${key}] ❌ Erro no fallback:`, error.message);
    return { success: false, error: error.message };
  }
}

// ===== VERIFICAÇÃO DE ALERTAS DEVIDOS =====
async function checkAndSendDueAlerts(now = Date.now()) {
  if (!ALERT_CHAT_ID && !MANAGER_PHONE) {
    console.warn('Nenhum destino de alerta configurado');
    return;
  }
  
  console.log('=== VERIFICANDO ALERTAS DEVIDOS ===');
  console.log('Total conversas monitoradas:', conversations.size);
  console.log('Horário atual:', new Date(now).toLocaleString('pt-BR'));
  console.log('Dentro do horário comercial:', isWithinBusinessHours(now));
  console.log('Chat de alertas:', ALERT_CHAT_ID);
  
  let alertsSent = 0;
  
  for (const [key, state] of conversations.entries()) {
    const { lastInboundAt, lastOutboundAt, alertedAt, meta } = state;
    
    // Pula se não há mensagem de entrada
    if (!lastInboundAt) continue;
    
    const replied = lastOutboundAt && lastOutboundAt >= lastInboundAt;
    const businessElapsed = businessElapsedMs(lastInboundAt, now);
    const idleMinutes = Math.round(businessElapsed / 60000);
    const overdue = businessElapsed >= IDLE_MS;
    const alreadyAlerted = Boolean(alertedAt) && alertedAt >= lastInboundAt;
    const overCap = businessElapsed >= MAX_IDLE_ALERT_MINUTES * 60000;
    const withinBusinessHours = isWithinBusinessHours(now);
    
    console.log(`[${key}] Análise da conversa:`, {
      lastInboundAt: new Date(lastInboundAt).toLocaleString('pt-BR'),
      lastOutboundAt: lastOutboundAt ? new Date(lastOutboundAt).toLocaleString('pt-BR') : null,
      replied,
      businessElapsedMinutes: idleMinutes,
      overdue,
      alreadyAlerted,
      overCap,
      withinBusinessHours,
      clientName: meta.clientName,
      attendantName: meta.attendantName
    });
    
    // Condições para enviar alerta:
    // 1. Não foi respondida pelo atendente
    // 2. Tempo de inatividade >= IDLE_MS
    // 3. Não foi enviado alerta ainda
    // 4. Não passou do tempo máximo
    // 5. Está dentro do horário comercial
    if (!replied && overdue && !alreadyAlerted && !overCap && withinBusinessHours) {
      console.log(`[${key}] 🚨 ENVIANDO ALERTA - Todas condições atendidas`);
      
      const conversationData = {
        key,
        clientName: meta.clientName || meta.fromName || meta.fromPhone || 'Cliente',
        attendantName: meta.attendantName || getAttendantNameById(meta.attendantId) || 'Atendente',
        idleMinutes,
        link: meta.link || `https://app-utalk.umbler.com/chats/${meta.conversationId || key}`,
        sector: meta.sector || 'Geral'
      };
      
      const result = await sendAlertToChat(conversationData);
      
      if (result.success) {
        state.alertedAt = now;
        alertsSent++;
        console.log(`[${key}] ✅ Alerta enviado com sucesso via ${result.target}`);
      } else {
        console.error(`[${key}] ❌ Falha ao enviar alerta:`, result.error);
      }
    } else {
      // Log do motivo de não enviar
      const reasons = [];
      if (replied) reasons.push('já_respondida');
      if (!overdue) reasons.push('não_expirada');
      if (alreadyAlerted) reasons.push('já_alertada');
      if (overCap) reasons.push('tempo_excedido');
      if (!withinBusinessHours) reasons.push('fora_horário_comercial');
      
      if (reasons.length > 0) {
        console.log(`[${key}] ⏸️ Não envia alerta: ${reasons.join(', ')}`);
      }
    }
  }
  
  console.log(`=== VERIFICAÇÃO COMPLETA - ${alertsSent} alertas enviados ===`);
  return alertsSent;
}

// ===== ENDPOINTS DA API =====

// Página principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Informações da conta
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
        channelId: process.env.CHANNEL_ID,
        alertChatId: ALERT_CHAT_ID,
        idleMinutes: IDLE_MS / 60000,
        businessHours: `${BUSINESS_START_HOUR}:00 - ${BUSINESS_END_HOUR}:00`
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Status do canal
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

// ===== WEBHOOK PRINCIPAL =====
app.post('/api/webhook/utalk', async (req, res) => {
  try {
    const event = req.body || {};
    
    if (WEBHOOK_DEBUG) {
      console.log('=== WEBHOOK RECEBIDO ===');
      console.log('Timestamp:', new Date().toISOString());
      console.log('Event:', JSON.stringify(event, null, 2));
      console.log('=========================');
    }

    const webhookData = extractWebhookData(event);
    
    if (WEBHOOK_DEBUG) {
      console.log('=== DADOS EXTRAÍDOS ===');
      console.log('Data:', JSON.stringify(webhookData, null, 2));
      console.log('======================');
    }

    const { conversationId, fromPhone, fromName, attendantId, direction, sector, messageText } = webhookData;

    // Link da conversa
    const conversationLink = conversationId ? `https://app-utalk.umbler.com/chats/${conversationId}` : null;

    // Chave para rastreamento (prioridade: conversationId > fromPhone)
    const key = conversationId || fromPhone;

    // Registra evento para debug
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
      if (recentWebhookEvents.length > MAX_RECENT_EVENTS) {
        recentWebhookEvents.pop();
      }
    }

    // Atualiza estado da conversa
    if (key && direction) {
      const now = Date.now();
      const state = conversations.get(key) || {
        lastInboundAt: null,
        lastOutboundAt: null,
        alertedAt: null,
        meta: {}
      };
      
      if (direction === 'in') {
        console.log(`[${key}] 📨 MENSAGEM DO CLIENTE - Iniciando monitoramento`);
        state.lastInboundAt = now;
        state.alertedAt = null; // Reset alerta em nova mensagem do cliente
        state.meta = {
          conversationId,
          attendantId: null,
          fromPhone,
          fromName,
          clientName: fromName,
          link: conversationLink,
          sector: sector || 'Geral',
          lastMessageText: messageText
        };
        
        console.log(`[${key}] ⏰ Timer de ${IDLE_MS/60000} minutos iniciado`);
        
      } else if (direction === 'out') {
        console.log(`[${key}] 📤 RESPOSTA DO ATENDENTE - Cancelando timer`);
        state.lastOutboundAt = now;
        // Mantém informações do cliente, atualiza atendente
        state.meta = {
          ...state.meta,
          attendantId,
          attendantName: getAttendantNameById(attendantId),
          lastMessageText: messageText
        };
        
        // Se havia timer ativo, cancela
        const timeSinceInbound = state.lastInboundAt ? now - state.lastInboundAt : 0;
        console.log(`[${key}] ✅ Timer cancelado após ${Math.round(timeSinceInbound/60000)} minutos`);
      }
      
      conversations.set(key, state);
      
      // Log resumido do estado
      console.log(`[${key}] Estado atualizado:`, {
        hasInbound: Boolean(state.lastInboundAt),
        hasOutbound: Boolean(state.lastOutboundAt),
        needsAlert: state.lastInboundAt && (!state.lastOutboundAt || state.lastOutboundAt < state.lastInboundAt) && !state.alertedAt,
        clientName: state.meta.clientName,
        attendantName: state.meta.attendantName,
        sector: state.meta.sector
      });
      
    } else {
      // Registra pulos para debug
      const reason = !key ? 'chave_ausente' : !direction ? 'direção_ausente' : 'outro';
      recentWebhookSkips.unshift({
        ts: new Date().toISOString(),
        reason,
        conversationId,
        fromPhone,
        event: JSON.stringify(event).substring(0, 200)
      });
      if (recentWebhookSkips.length > MAX_RECENT_EVENTS) {
        recentWebhookSkips.pop();
      }
      
      console.warn(`[WEBHOOK] ⚠️ Evento ignorado - ${reason}:`, {
        key, direction, conversationId, fromPhone
      });
    }

    res.json({ ok: true });
    
  } catch (error) {
    console.error('Erro no webhook:', error);
    res.status(200).json({ ok: true }); // Sempre retorna OK para não quebrar UTalk
  }
});

// Função para extrair dados do webhook
function extractWebhookData(event) {
  let conversationId = null;
  let fromPhone = null;
  let fromName = null;
  let attendantId = null;
  let direction = null;
  let messageText = null;
  let sector = 'Geral';

  // Formato Chat snapshot (mais comum)
  const payloadType = (event.Payload && event.Payload.Type) || (event.payload && event.payload.Type);
  const content = (event.Payload && event.Payload.Content) || (event.payload && event.payload.Content);
  
  if (payloadType === 'Chat' && content) {
    const lastMessage = content.LastMessage || {};
    
    conversationId = content.Id || (lastMessage.Chat && lastMessage.Chat.Id);
    fromPhone = (content.Contact && (content.Contact.PhoneNumber || content.Contact.Phone));
    fromName = (content.Contact && content.Contact.Name);
    messageText = lastMessage.Text || lastMessage.Content || lastMessage.MessageText;
    
    // Determina direção baseada na origem da mensagem
    const messageSource = lastMessage.Source;
    const sentByMember = lastMessage.SentByOrganizationMember;
    
    if (messageSource === 'Contact') {
      direction = 'in';
      attendantId = null;
    } else if (messageSource === 'Member' && sentByMember && sentByMember.Id) {
      direction = 'out';
      attendantId = sentByMember.Id;
    }
    
    // Extrai setor
    sector = extractSectorFromEvent(event, content) || 'Geral';
    
  } else {
    // Formato direto de mensagem
    const message = event.message || event.Message || event.payload || event.Payload || {};
    
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
    
    direction = message.direction || event.direction;
    if (!direction) {
      const type = event.type || event.Type || '';
      if (type.includes('in') || type.includes('inbound')) direction = 'in';
      else if (type.includes('out') || type.includes('outbound')) direction = 'out';
      else if (attendantId) direction = 'out';
      else direction = 'in'; // Assume entrada por padrão
    }
    
    sector = extractSectorFromEvent(event, message) || 'Geral';
  }

  // Normaliza telefone
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

// Extrai setor do evento
function extractSectorFromEvent(event, message) {
  const tryValues = [
    event.sector, event.Sector, event.department, event.Department,
    event.queue, event.Queue, event.tag, event.Tag, event.team, event.Team,
    
    (event.Payload && event.Payload.Content && (
      event.Payload.Content.Sector || event.Payload.Content.Department || 
      event.Payload.Content.Queue || event.Payload.Content.Tag || 
      event.Payload.Content.Team || event.Payload.Content.sector ||
      event.Payload.Content.department
    )),
    
    message && (message.sector || message.Sector || message.department || 
               message.Department || message.queue || message.Queue || 
               message.tag || message.Tag || message.team || message.Team),
    
    (event.Context && (event.Context.Sector || event.Context.Department || 
                      event.Context.sector || event.Context.department)),
    (event.metadata && (event.metadata.sector || event.metadata.department ||
                       event.metadata.Sector || event.metadata.Department))
  ].filter(Boolean);
  
  if (tryValues.length > 0) return String(tryValues[0]).trim();
  return 'Geral';
}

// ===== ENDPOINTS DE DEBUG E ADMIN =====

// Debug do webhook
app.get('/api/webhook/utalk/debug', requireAdmin, (req, res) => {
  try {
    const states = Array.from(conversations.entries()).map(([key, s]) => ({
      key,
      lastInboundAt: s.lastInboundAt ? new Date(s.lastInboundAt).toLocaleString('pt-BR') : null,
      lastOutboundAt: s.lastOutboundAt ? new Date(s.lastOutboundAt).toLocaleString('pt-BR') : null,
      alertedAt: s.alertedAt ? new Date(s.alertedAt).toLocaleString('pt-BR') : null,
      sector: s.meta && s.meta.sector,
      clientName: s.meta && s.meta.clientName,
      attendantId: s.meta && s.meta.attendantId,
      attendantName: s.meta && s.meta.attendantName,
      link: s.meta && s.meta.link,
      businessElapsedMinutes: s.lastInboundAt ? Math.round(businessElapsedMs(s.lastInboundAt, Date.now()) / 60000) : null,
      needsAlert: s.lastInboundAt && !s.alertedAt && 
                 (!s.lastOutboundAt || s.lastOutboundAt < s.lastInboundAt) &&
                 businessElapsedMs(s.lastInboundAt, Date.now()) >= IDLE_MS &&
                 businessElapsedMs(s.lastInboundAt, Date.now()) < MAX_IDLE_ALERT_MINUTES * 60000 &&
                 isWithinBusinessHours(Date.now())
    }));
    
    res.json({
      success: true,
      currentTime: new Date().toLocaleString('pt-BR'),
      isBusinessHours: isWithinBusinessHours(Date.now()),
      alertChatId: ALERT_CHAT_ID,
      conversations: states,
      idleMinutes: IDLE_MS / 60000,
      maxIdleAlertMinutes: MAX_IDLE_ALERT_MINUTES,
      businessHours: { startHour: BUSINESS_START_HOUR, endHour: BUSINESS_END_HOUR },
      stats: {
        ...alertStats,
        uptimeHours: Math.round((Date.now() - alertStats.startTime) / 3600000 * 100) / 100
      },
      recentEventsCount: recentWebhookEvents.length,
      recentEventsSample: recentWebhookEvents.slice(0, 10),
      recentSkips: recentWebhookSkips.slice(0, 10),
      totalConversations: conversations.size,
      conversationsNeedingAlert: states.filter(s => s.needsAlert).length
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Força verificação de alertas
app.post('/api/webhook/utalk/sweep', requireAdmin, async (req, res) => {
  try {
    const alertsSent = await checkAndSendDueAlerts(Date.now());
    res.json({ 
      success: true, 
      alertsSent,
      message: `Verificação concluída. ${alertsSent} alertas enviados.`
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Reset estatísticas
app.post('/api/admin/reset-stats', requireAdmin, (req, res) => {
  alertStats.totalAlertsSent = 0;
  alertStats.alertsToChat = 0;
  alertStats.alertsToFallback = 0;
  alertStats.byDay = {};
  alertStats.startTime = Date.now();
  res.json({ success: true, message: 'Estatísticas resetadas' });
});

// ===== ENDPOINTS DE TESTE =====

// Teste de alerta manual
app.post('/api/test/send-alert', async (req, res) => {
  try {
    const { 
      clientName = 'Cliente Teste',
      attendantName = 'Atendente Teste',
      idleMinutes = 15,
      sector = 'Geral'
    } = req.body;
    
    const conversationData = {
      key: `TEST_${Date.now()}`,
      clientName,
      attendantName,
      idleMinutes,
      link: 'https://app-utalk.umbler.com/chats/TEST_CONVERSATION',
      sector
    };
    
    const result = await sendAlertToChat(conversationData);
    
    res.json({
      success: true,
      message: 'Teste de alerta executado',
      result,
      sentTo: ALERT_CHAT_ID,
      fallbackUsed: result.target === 'fallback'
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Simular mensagem de cliente
app.post('/api/test/simulate-client-message', async (req, res) => {
  try {
    const {
      conversationId = `TEST_CONV_${Date.now()}`,
      clientPhone = '5511999999999',
      clientName = 'Cliente Teste',
      sector = 'Geral'
    } = req.body;
    
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
            Text: 'Olá, preciso de ajuda urgente!',
            Chat: { Id: conversationId }
          }
        }
      },
      Sector: sector
    };
    
    const webhookData = extractWebhookData(simulatedWebhook);
    const key = webhookData.conversationId || webhookData.fromPhone;
    
    if (key && webhookData.direction === 'in') {
      const now = Date.now();
      const state = {
        lastInboundAt: now,
        lastOutboundAt: null,
        alertedAt: null,
        meta: {
          conversationId,
          attendantId: null,
          fromPhone: webhookData.fromPhone,
          fromName: webhookData.fromName,
          clientName: webhookData.fromName,
          link: `https://app-utalk.umbler.com/chats/${conversationId}`,
          sector: webhookData.sector
        }
      };
      
      conversations.set(key, state);
      
      res.json({
        success: true,
        message: 'Mensagem de cliente simulada com sucesso',
        data: { key, webhookData, state },
        instructions: [
          `Timer de ${IDLE_MS/60000} minutos iniciado`,
          'Aguarde o tempo configurado ou force sweep via POST /api/webhook/utalk/sweep',
          'Verifique estado via GET /api/webhook/utalk/debug'
        ]
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Falha ao processar webhook simulado',
        webhookData
      });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Simular resposta de atendente
app.post('/api/test/simulate-attendant-reply', async (req, res) => {
  try {
    const {
      conversationId = 'TEST_CONV_CLIENT',
      attendantId = 'aGevxChnIrrCytFy',
      clientPhone = '5511999999999',
      clientName = 'Cliente Teste'
    } = req.body;
    
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
            Text: 'Olá! Como posso ajudar você?',
            Chat: { Id: conversationId },
            SentByOrganizationMember: { Id: attendantId }
          }
        }
      }
    };
    
    const webhookData = extractWebhookData(simulatedWebhook);
    const key = webhookData.conversationId || webhookData.fromPhone;
    
    if (key && webhookData.direction === 'out') {
      const now = Date.now();
      const state = conversations.get(key) || {
        lastInboundAt: null,
        lastOutboundAt: null,
        alertedAt: null,
        meta: {}
      };
      
      state.lastOutboundAt = now;
      state.meta = {
        ...state.meta,
        attendantId: webhookData.attendantId,
        attendantName: getAttendantNameById(webhookData.attendantId)
      };
      
      conversations.set(key, state);
      
      res.json({
        success: true,
        message: 'Resposta de atendente simulada com sucesso',
        data: { key, webhookData, state },
        result: 'Timer cancelado - não será enviado alerta'
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Falha ao processar webhook simulado',
        webhookData
      });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== OUTROS ENDPOINTS =====

// Enviar mensagem
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

    if (!phoneNumber || !message) {
      return res.status(400).json({
        success: false,
        error: 'Phone number and message are required'
      });
    }

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

    let finalMessage = message;
    if (useOrganizedFormat === 'true') {
      finalMessage = api.formatOrganizedNotification({
        clientName,
        attendantName,
        idleTime,
        link
      });
    } else if (useBusinessFormat === 'true') {
      finalMessage = api.formatBusinessMessage(message, attendantName, location, schedule, link);
    }

    let result;

    if (messageType === 'template' && templateName) {
      const templateParams = parameters ? parameters.split(',').map(p => p.trim()) : [];
      result = await api.sendTemplateMessage(channelId, cleanPhoneNumber, templateName, templateParams, organizationId);
    } else {
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

// Listar canais
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

// Criar canal
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

// Middleware de tratamento de erros
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// ===== INICIALIZAÇÃO DO SERVIDOR =====
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp UTalk Bot Server running on http://localhost:${PORT}`);
  console.log('\n📋 Available endpoints:');
  console.log('   GET  /               - Web interface');
  console.log('   GET  /api/info       - Account information');
  console.log('   POST /api/send-message - Send WhatsApp message');
  console.log('   POST /api/webhook/utalk - UTalk webhook endpoint');
  console.log('   GET  /api/webhook/utalk/debug - Debug webhook state');
  console.log('   POST /api/webhook/utalk/sweep - Force alert check');
  console.log('\n📱 Configuration:');
  console.log(`   Organization ID: ${process.env.ORGANIZATION_ID || 'Not set'}`);
  console.log(`   Channel ID: ${process.env.CHANNEL_ID || 'Not set'}`);
  console.log(`   Alert Chat ID: ${ALERT_CHAT_ID || 'Not set'}`);
  console.log(`   Idle Time: ${IDLE_MS / 60000} minutes`);
  console.log(`   Business Hours: ${BUSINESS_START_HOUR}:00 - ${BUSINESS_END_HOUR}:00`);
  console.log(`   Max Alert Time: ${MAX_IDLE_ALERT_MINUTES} minutes`);
  
  if (!ALERT_CHAT_ID) {
    console.log('\n⚠️  WARNING: ALERT_CHAT_ID not configured!');
    console.log('   Alerts will use fallback methods only.');
  }
  
  console.log('\n💡 Run "npm run setup" if configuration is missing');
  
  // Inicia verificador automático de alertas
  startAlertChecker();
});

// ===== VERIFICADOR AUTOMÁTICO DE ALERTAS =====
function startAlertChecker() {
  const CHECK_INTERVAL = 60000; // Verifica a cada minuto
  
  console.log('🔄 Starting automatic alert checker...');
  
  setInterval(async () => {
    try {
      // Só verifica se estamos no horário comercial
      if (isWithinBusinessHours(Date.now())) {
        const alertsSent = await checkAndSendDueAlerts(Date.now());
        if (alertsSent > 0) {
          console.log(`✅ Alert check completed - ${alertsSent} alerts sent`);
        }
      }
    } catch (error) {
      console.error('Alert checker error:', error.message);
    }
  }, CHECK_INTERVAL);
  
  console.log(`✅ Alert checker started (interval: ${CHECK_INTERVAL / 1000}s, business hours only)`);
}

module.exports = app;