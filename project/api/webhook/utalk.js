// Webhook principal para Vercel (Serverless)
const UTalkAPI = require('../../config/api');
const { getAttendantNameById } = require('../../config/attendants');

// Configurações
const IDLE_MS = Number(process.env.IDLE_MS || 15 * 60 * 1000);
const BUSINESS_START_HOUR = Number(process.env.BUSINESS_START_HOUR || 8);
const BUSINESS_END_HOUR = Number(process.env.BUSINESS_END_HOUR || 18);
const MANAGER_ID = process.env.MANAGER_ID || 'aLrR-GU3ZQBaslwU';

// Palavras que indicam fim de conversa
const CONVERSATION_ENDERS = [
  /^(ok|okay|blz|beleza|obrigad[oa]|valeu|tchau|bye|flw|falou)$/i,
  /^(entendi|perfeito|certo|show|top|legal|massa)$/i,
  /^(👍|👌|✅|😊|😉|🙏)$/
];

// Tags/setores que não devem gerar alertas
const INTERNAL_TAGS = [
  'interno', 'internal', 'staff', 'equipe', 'atendente',
  'processos desp laís', 'autofacil', 'auto facil', 'auto fácil',
  'particular florianópolis', 'auto vistoria', 'são josé',
  'equipe particular são josé', 'grupos', 'lojas'
];

// Emojis que indicam grupos internos
const INTERNAL_EMOJIS = ['🚙', '🚍', '🐨', '🤍'];

// Storage global (limitado no Vercel)
global.conversations = global.conversations || new Map();

function isAutomaticMessage(messageText) {
  if (!messageText) return false;
  const botPatterns = [
    /olá.*bem.*vindo/i, /como.*posso.*ajudar/i, /digite.*opção/i,
    /selecione.*uma.*opção/i, /menu.*principal/i, /^\\d+\\s*-/
  ];
  return botPatterns.some(pattern => pattern.test(messageText));
}

function isConversationEnder(messageText) {
  if (!messageText) return false;
  return CONVERSATION_ENDERS.some(pattern => pattern.test(messageText.trim()));
}

function isInBusinessHours(timestamp) {
  const date = new Date(timestamp);
  const hour = date.getHours();
  const day = date.getDay();
  return day >= 1 && day <= 5 && hour >= BUSINESS_START_HOUR && hour < BUSINESS_END_HOUR;
}

function analyzeConversationForHumanAttendant(webhookHistory) {
  if (!webhookHistory || webhookHistory.length === 0) return false;
  const humanMessages = webhookHistory.filter(event => 
    event.direction === 'out' && !event.isBot && event.attendantId && event.attendantId !== MANAGER_ID
  );
  return humanMessages.length > 0;
}

function extractUmblerWebhookData(event) {
  const payload = event.Payload;
  if (!payload || payload.Type !== 'Chat') return null;

  const content = payload.Content;
  if (!content) return null;

  const lastMessage = content.LastMessage || {};
  
  let conversationId = content.Id;
  let fromPhone = content.Contact?.PhoneNumber || content.Contact?.Phone;
  let fromName = content.Contact?.Name;
  let sector = content.Sector?.Name || 'Geral';
  let messageText = lastMessage.Content || lastMessage.Text;
  let isPrivate = lastMessage.IsPrivate || false;
  let direction = null;
  let attendantId = null;

  const messageSource = lastMessage.Source;
  if (messageSource === 'Contact') {
    direction = 'in';
  } else if (messageSource === 'Member') {
    direction = 'out';
    attendantId = lastMessage.SentByOrganizationMember?.Id || null;
  } else if (messageSource === 'Bot') {
    direction = 'out';
    attendantId = 'BOT_SYSTEM';
  }

  const tags = content.Tags || [];
  const tagNames = tags.map(tag => (tag.Name || tag.name || '').toLowerCase());
  const sectorName = (sector || '').toLowerCase();
  const contactName = (fromName || '').toLowerCase();
  
  // Verifica se é conversa interna por tag, setor, nome ou emoji
  const isInternal = tagNames.some(tag => INTERNAL_TAGS.some(internal => tag.includes(internal))) ||
                    INTERNAL_TAGS.some(internal => sectorName.includes(internal)) ||
                    INTERNAL_TAGS.some(internal => contactName.includes(internal)) ||
                    INTERNAL_EMOJIS.some(emoji => sectorName.includes(emoji) || contactName.includes(emoji));

  if (fromPhone) {
    fromPhone = String(fromPhone).replace(/\\D/g, '');
    if (fromPhone.length === 0) fromPhone = null;
  }

  return {
    conversationId, fromPhone, fromName, attendantId, direction,
    messageText, sector, isPrivate, isInternal, tags: tagNames,
    eventId: event.EventId, eventDate: event.EventDate
  };
}

async function notifyManagerAboutUnattendedClient(conversationData) {
  const organizationId = process.env.ORGANIZATION_ID;
  const channelId = process.env.CHANNEL_ID;
  const managerPhone = process.env.MANAGER_PHONE;
  
  if (!managerPhone) return { success: false, error: 'Manager phone not configured' };

  const { key, clientName, attendantName, idleMinutes, link, sector, conversationId } = conversationData;
  const attendantFullName = getAttendantNameById(conversationData.attendantId) || attendantName || 'Sistema Automático';
  
  const managerMessage = `🚨 *CLIENTE NÃO ATENDIDO*

👤 *Cliente:* ${clientName || 'Nome não informado'}
💬 *Chat ID:* ${conversationId || key}
🧑💼 *Atendente Responsável:* ${attendantFullName}
📍 *Setor:* ${sector || 'Geral'}
⏱️ *Tempo aguardando:* ${idleMinutes} minutos (horário comercial)
🔗 *Link:* ${link || 'Não disponível'}
📅 *Data/Hora:* ${new Date().toLocaleString('pt-BR')}

⚠️ *Cliente aguarda atendimento humano há ${idleMinutes} minutos*

_Alerta automático - Horário: 8h-18h_`;

  try {
    const api = new UTalkAPI();
    await api.sendMessage(channelId, managerPhone, managerMessage, organizationId);
    return { success: true, target: 'whatsapp' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function notifyThirdPartyWebhook(alertData) {
  const webhookUrl = process.env.MANAGER1_WEBHOOK;
  if (!webhookUrl) return { success: false, error: 'Webhook URL not configured' };

  const eventId = `ALERT_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const webhookPayload = {
    Type: 'ClientUnattended',
    EventDate: new Date().toISOString(),
    EventId: eventId,
    Payload: {
      Type: 'Alert',
      Content: {
        Id: alertData.conversationId || alertData.key,
        ClientName: alertData.clientName,
        AttendantName: alertData.attendantName,
        Sector: alertData.sector,
        IdleMinutes: alertData.idleMinutes,
        Link: alertData.link,
        Timestamp: new Date().toISOString()
      }
    }
  };

  try {
    const axios = require('axios');
    const response = await axios.post(webhookUrl, webhookPayload, {
      timeout: 4500,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'UTalk-Bot-Webhook/2.0' }
    });
    
    if (response.status >= 200 && response.status <= 299) {
      return { success: true, status: response.status, eventId };
    } else {
      throw new Error(`Status inválido: ${response.status}`);
    }
  } catch (error) {
    return { success: false, error: error.message, eventId };
  }
}

// Handler principal para Vercel
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const event = req.body || {};
    
    // Resposta imediata (< 5 segundos)
    res.status(200).json({ 
      received: true, 
      eventId: event.EventId,
      timestamp: new Date().toISOString()
    });

    // Processa apenas eventos de Message
    if (event.Type !== 'Message') return;

    const webhookData = extractUmblerWebhookData(event);
    if (!webhookData || webhookData.isPrivate || webhookData.isInternal) return;

    const { conversationId, fromPhone, fromName, attendantId, direction, messageText, sector } = webhookData;
    const key = conversationId || fromPhone || `UNKNOWN_${Date.now()}`;
    const conversationLink = conversationId ? `https://app-utalk.umbler.com/chats/${conversationId}` : null;

    if (key && direction) {
      const now = Date.now();
      const state = global.conversations.get(key) || {
        lastInboundAt: null, lastOutboundAt: null, alertedAt: null,
        meta: {}, webhookHistory: []
      };

      // Adiciona ao histórico
      state.webhookHistory.push({
        timestamp: now, direction, attendantId,
        attendantName: getAttendantNameById(attendantId),
        messageText: messageText ? messageText.substring(0, 100) : null,
        isBot: isAutomaticMessage(messageText, attendantId)
      });

      if (state.webhookHistory.length > 50) {
        state.webhookHistory = state.webhookHistory.slice(-50);
      }

      if (direction === 'in') {
        // Verifica mensagem de fim
        if (isConversationEnder(messageText)) {
          global.conversations.delete(key);
          return;
        }

        // Verifica horário comercial
        if (!isInBusinessHours(now)) return;

        state.lastInboundAt = now;
        state.alertedAt = null;
        state.meta = {
          conversationId, attendantId: null, fromPhone, fromName,
          clientName: fromName, link: conversationLink,
          sector: sector || 'Geral', lastMessageText: messageText,
          tags: webhookData.tags || []
        };

      } else if (direction === 'out') {
        const isBot = isAutomaticMessage(messageText, attendantId);
        if (!isBot) {
          state.lastOutboundAt = now;
        }
        state.meta = {
          ...state.meta, attendantId,
          attendantName: getAttendantNameById(attendantId),
          lastMessageText: messageText
        };
      }

      global.conversations.set(key, state);

      // Verifica se precisa alertar
      const hasHumanAttendant = analyzeConversationForHumanAttendant(state.webhookHistory);
      const businessElapsed = now - (state.lastInboundAt || now);
      const overdue = businessElapsed >= IDLE_MS;
      const withinBusinessHours = isInBusinessHours(now);

      if (!hasHumanAttendant && overdue && !state.alertedAt && withinBusinessHours && state.lastInboundAt) {
        const idleMinutes = Math.round(businessElapsed / 60000);
        const conversationData = {
          key, conversationId: state.meta.conversationId || key,
          clientName: state.meta.clientName || 'Cliente',
          attendantId: state.meta.attendantId,
          attendantName: state.meta.attendantName || 'Sistema',
          idleMinutes, sector: state.meta.sector || 'Geral',
          link: state.meta.link || conversationLink,
          tags: state.meta.tags || []
        };

        // Envia notificações
        const [whatsappResult, webhookResult] = await Promise.all([
          notifyManagerAboutUnattendedClient(conversationData),
          notifyThirdPartyWebhook(conversationData)
        ]);

        if (whatsappResult.success || webhookResult.success) {
          state.alertedAt = now;
          global.conversations.set(key, state);
        }
      }
    }

  } catch (error) {
    console.error('Erro processando webhook:', error.message);
  }
};