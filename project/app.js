const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const UTalkAPI = require('./config/api');
const { getAttendantNameById } = require('./config/attendants');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIGURAÇÃO DO SISTEMA DE MONITORAMENTO =====
const ALERT_CHAT_ID = process.env.ALERT_CHAT_ID || 'aLrR-GU3ZQBaslwU';
const MANAGER_PHONE = process.env.MANAGER_PHONE;
const MANAGER_ATTENDANT_ID = process.env.MANAGER_ATTENDANT_ID;
const WEBHOOK_DEBUG = (process.env.WEBHOOK_DEBUG || 'true') === 'true';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// MONITORA TODOS OS CHATS - NÃO APENAS UM ESPECÍFICO
const MONITOR_ALL_CHATS = true;

// Configurações de tempo
const IDLE_MS = Number(process.env.IDLE_MS || 15 * 60 * 1000); // 15 minutos padrão
const MAX_IDLE_ALERT_MINUTES = Number(process.env.MAX_IDLE_ALERT_MINUTES || 60); // 60 min máx
const BUSINESS_START_HOUR = Number(process.env.BUSINESS_START_HOUR || 8); // 08:00
const BUSINESS_END_HOUR = Number(process.env.BUSINESS_END_HOUR || 18); // 18:00

// Palavras que indicam fim de conversa (cliente não precisa de resposta)
const CONVERSATION_ENDERS = [
  /^(ok|okay|blz|beleza|obrigad[oa]|valeu|tchau|bye|flw|falou)$/i,
  /^(entendi|perfeito|certo|show|top|legal|massa)$/i,
  /^(👍|👌|✅|😊|😉|🙏)$/,
  /^(obrigad[oa]\s*(mesmo|demais)?[!.]*)$/i
];

// Tags/setores que indicam conversa interna ou que não devem gerar alertas
const INTERNAL_TAGS = [
  'interno', 'internal', 'staff', 'equipe', 'atendente',
  'processos desp laís', 'autofacil', 'auto facil', 'auto fácil',
  'particular florianópolis', 'auto vistoria', 'são josé',
  'equipe particular são josé', 'grupos', 'lojas'
];

// Emojis que indicam grupos internos
const INTERNAL_EMOJIS = ['🚙', '🚍', '🐨', '🤍'];

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
const conversations = new Map(); // key -> { lastInboundAt, lastOutboundAt, alertedAt, meta, webhookHistory }
const recentWebhookEvents = [];
const recentWebhookSkips = [];
const MAX_RECENT_EVENTS = 200;

// ID do chat da gestora
const MANAGER_ID = process.env.MANAGER_ID || 'aLrR-GU3ZQBaslwU';

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

// ===== LIMPEZA DE CONVERSAS ANTIGAS =====

// Limpa conversas antigas (após 6 horas de inatividade)
function cleanOldConversations() {
  const now = Date.now();
  const SIX_HOURS = 6 * 60 * 60 * 1000; // 6 horas em ms
  let cleaned = 0;
  
  for (const [key, state] of conversations.entries()) {
    const lastActivity = Math.max(
      state.lastInboundAt || 0,
      state.lastOutboundAt || 0,
      state.alertedAt || 0
    );
    
    // Remove apenas se passou 6 horas da última atividade
    if (lastActivity && (now - lastActivity) > SIX_HOURS) {
      conversations.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Limpeza automática: ${cleaned} conversas antigas removidas (>6h)`);
  }
}

// ===== ANÁLISE DE ATENDIMENTO HUMANO =====

// Verifica se mensagem é automática (bot)
function isAutomaticMessage(messageText, attendantId) {
  if (!messageText) return false;
  
  // Mensagens típicas de bot/automação
  const botPatterns = [
    /olá.*bem.*vindo/i,
    /como.*posso.*ajudar/i,
    /digite.*opção/i,
    /selecione.*uma.*opção/i,
    /menu.*principal/i,
    /atendimento.*automático/i,
    /bot.*atendimento/i,
    /^\d+\s*-/,  // Opções numeradas
    /para.*falar.*atendente/i,
    /horário.*funcionamento/i
  ];
  
  return botPatterns.some(pattern => pattern.test(messageText));
}

// Verifica se mensagem indica fim de conversa
function isConversationEnder(messageText) {
  if (!messageText) return false;
  
  const cleanText = messageText.trim();
  return CONVERSATION_ENDERS.some(pattern => pattern.test(cleanText));
}

// Verifica se conversa está em horário de atendimento
function isInBusinessHours(timestamp) {
  const date = new Date(timestamp);
  const hour = date.getHours();
  const day = date.getDay(); // 0=Dom, 6=Sáb
  
  // Segunda a sexta, 8h às 18h
  return day >= 1 && day <= 5 && hour >= BUSINESS_START_HOUR && hour < BUSINESS_END_HOUR;
}

// Analisa histórico de webhooks para determinar se houve atendimento humano
function analyzeConversationForHumanAttendant(webhookHistory) {
  if (!webhookHistory || webhookHistory.length === 0) return false;
  
  // Procura por mensagens de saída (atendente) que não sejam bot
  const humanMessages = webhookHistory.filter(event => 
    event.direction === 'out' && 
    !event.isBot && 
    event.attendantId && 
    event.attendantId !== MANAGER_ID // Exclui mensagens da gestora
  );
  
  return humanMessages.length > 0;
}

// Envia notificação para gestora via WhatsApp
async function notifyManagerAboutUnattendedClient(conversationData) {
  const organizationId = process.env.ORGANIZATION_ID;
  const channelId = process.env.CHANNEL_ID;
  const managerPhone = process.env.MANAGER_PHONE;
  
  if (!managerPhone) {
    console.warn('MANAGER_PHONE não configurado');
    return { success: false, error: 'Manager phone not configured' };
  }

  const { key, clientName, attendantName, idleMinutes, link, sector, conversationId } = conversationData;
  
  // Busca nome do atendente responsável
  const attendantFullName = getAttendantNameById(conversationData.attendantId) || attendantName || 'Sistema Automático';
  
  // Mensagem formatada para WhatsApp
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
    console.log(`[${key}] Enviando para WhatsApp ${managerPhone}`);
    
    // Envia via WhatsApp para o telefone da gestora
    const result = await api.sendMessage(channelId, managerPhone, managerMessage, organizationId);
    
    console.log(`[${key}] ✅ Gestora notificada via WhatsApp`);
    return { success: true, target: 'whatsapp', result };
    
  } catch (error) {
    console.error(`[${key}] ❌ Erro ao notificar gestora:`, error.message);
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
  console.log('=== MONITORAMENTO GLOBAL DE TODOS OS CHATS ===');
  console.log('Total conversas monitoradas:', conversations.size);
  console.log('Horário atual:', new Date(now).toLocaleString('pt-BR'));
  console.log('Dentro do horário comercial:', isWithinBusinessHours(now));
  console.log('Monitora todos os chats:', MONITOR_ALL_CHATS);
  console.log('Gestora (Manager ID):', MANAGER_ID);
  
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
    
    // Verifica se cliente foi atendido por humano
    const hasHumanAttendant = analyzeConversationForHumanAttendant(state.webhookHistory || []);
    
    // Condições para enviar alerta:
    // 1. Cliente ainda não foi atendido por humano
    // 2. Tempo de inatividade >= IDLE_MS
    // 3. Não foi enviado alerta ainda
    // 4. Não passou do tempo máximo
    // 5. Está dentro do horário comercial
    if (!hasHumanAttendant && overdue && !alreadyAlerted && !overCap && withinBusinessHours) {
      console.log(`[${key}] 🚨 ENVIANDO ALERTA - Todas condições atendidas`);
      
      const conversationData = {
        key,
        conversationId: meta.conversationId || key,
        clientName: meta.clientName || meta.fromName || meta.fromPhone || 'Cliente',
        attendantId: meta.attendantId,
        attendantName: meta.attendantName || getAttendantNameById(meta.attendantId) || 'Sistema',
        idleMinutes,
        link: meta.link || `https://app-utalk.umbler.com/chats/${meta.conversationId || key}`,
        sector: meta.sector || 'Geral',
        tags: meta.tags || []
      };
      
      // 1. ENVIA PARA WHATSAPP DA GESTORA
      const whatsappResult = await notifyManagerAboutUnattendedClient(conversationData);
      
      // 2. ENVIA WEBHOOK PARA APLICAÇÃO TERCEIRA (PADRÃO UMBLER)
      const webhookResult = await notifyThirdPartyWebhook(conversationData);
      
      if (whatsappResult.success || webhookResult.success) {
        state.alertedAt = now;
        alertsSent++;
        console.log(`[${key}] ✅ Notificações enviadas - WhatsApp: ${whatsappResult.success}, Webhook: ${webhookResult.success}`);
      } else {
        console.error(`[${key}] ❌ Ambas notificações falharam`);
      }
    } else {
      // Log do motivo de não enviar
      const reasons = [];
      if (hasHumanAttendant) reasons.push('já_atendido_por_humano');
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

// ===== WEBHOOK PRINCIPAL (UMBLER TALK 2.0) =====
app.post('/api/webhook/utalk', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const event = req.body || {};
    const attempt = parseInt(req.headers['x-attempt'] || '1');
    
    // RESPOSTA IMEDIATA CONFORME UMBLER (< 5 segundos)
    res.status(200).json({ 
      received: true, 
      eventId: event.EventId,
      timestamp: new Date().toISOString()
    });
    
    if (WEBHOOK_DEBUG) {
      console.log('=== WEBHOOK UMBLER RECEBIDO ===');
      console.log('EventId:', event.EventId);
      console.log('Type:', event.Type);
      console.log('Attempt:', attempt);
      console.log('EventDate:', event.EventDate);
      console.log('Payload Type:', event.Payload?.Type);
      console.log('Processing Time:', Date.now() - startTime, 'ms');
      console.log('===============================');
    }

    // Processa em background para não afetar tempo de resposta
    setImmediate(() => processWebhookInBackground(event, attempt));
    
  } catch (error) {
    console.error('Erro no webhook:', error);
    // Sempre retorna 200 para não causar retry desnecessário
    if (!res.headersSent) {
      res.status(200).json({ received: true, error: 'processed' });
    }
  }
});

// ===== PROCESSAMENTO EM BACKGROUND =====
async function processWebhookInBackground(event, attempt) {
  try {
    // Processa apenas eventos de Message
    if (event.Type !== 'Message') {
      if (WEBHOOK_DEBUG) console.log('Ignorando evento não-Message:', event.Type);
      return;
    }
    
    // Log de retry se necessário
    if (attempt > 1) {
      console.log(`🔄 Reprocessando evento ${event.EventId} - Tentativa ${attempt}`);
    }

    const webhookData = extractUmblerWebhookData(event);
    
    if (!webhookData) {
      if (WEBHOOK_DEBUG) console.log('Webhook inválido ou não-chat');
      return;
    }
    
    // Ignora mensagens privadas (notas internas)
    if (webhookData.isPrivate) {
      if (WEBHOOK_DEBUG) console.log('Ignorando nota interna');
      return;
    }
    
    // Ignora conversas internas (atendente com atendente, grupos, setores específicos)
    if (webhookData.isInternal) {
      if (WEBHOOK_DEBUG) console.log('Ignorando conversa interna/grupo:', webhookData.sector, webhookData.fromName);
      return;
    }
    
    if (WEBHOOK_DEBUG) {
      console.log('=== DADOS EXTRAÍDOS ===');
      console.log('Data:', JSON.stringify(webhookData, null, 2));
      console.log('======================');
    }

    const { conversationId, fromPhone, fromName, attendantId, direction, sector, messageText } = webhookData;

    // Link da conversa
    const conversationLink = conversationId ? `https://app-utalk.umbler.com/chats/${conversationId}` : null;

    // Chave para rastreamento - SEMPRE aceita qualquer chat
    const key = conversationId || fromPhone || `UNKNOWN_${Date.now()}`;

    // Registra evento para debug
    if (WEBHOOK_DEBUG) {
      recentWebhookEvents.unshift({
        eventId: webhookData.eventId,
        eventDate: webhookData.eventDate,
        ts: new Date().toISOString(),
        type: event.Type,
        direction: webhookData.direction,
        conversationId: webhookData.conversationId,
        fromPhone: webhookData.fromPhone,
        fromName: webhookData.fromName,
        attendantId: webhookData.attendantId,
        attendantName: getAttendantNameById(webhookData.attendantId) || null,
        sector: webhookData.sector,
        messageText: webhookData.messageText ? webhookData.messageText.substring(0, 100) : null,
        isPrivate: webhookData.isPrivate
      });
      if (recentWebhookEvents.length > MAX_RECENT_EVENTS) {
        recentWebhookEvents.pop();
      }
    }

    // ACEITA TODOS OS WEBHOOKS - Mesmo sem direção clara
    if (key && MONITOR_ALL_CHATS) {
      // Se não tem direção, tenta inferir
      if (!direction) {
        if (attendantId) {
          direction = 'out';
        } else if (fromPhone) {
          direction = 'in';
        } else {
          direction = 'in'; // Padrão
        }
        console.log(`[${key}] 🔍 Direção inferida: ${direction}`);
      }
      const now = Date.now();
      const state = conversations.get(key) || {
        lastInboundAt: null,
        lastOutboundAt: null,
        alertedAt: null,
        meta: {},
        webhookHistory: []
      };
      
      // Adiciona evento ao histórico de webhooks
      state.webhookHistory.push({
        timestamp: now,
        direction,
        attendantId,
        attendantName: getAttendantNameById(attendantId),
        messageText: messageText ? messageText.substring(0, 100) : null,
        isBot: isAutomaticMessage(messageText, attendantId)
      });
      
      // Mantém apenas os últimos 50 eventos
      if (state.webhookHistory.length > 50) {
        state.webhookHistory = state.webhookHistory.slice(-50);
      }
      
      // Limpa conversas antigas apenas após 6 horas
      cleanOldConversations();
      
      if (direction === 'in') {
        // Verifica se é mensagem de fim de conversa
        const isEnding = isConversationEnder(messageText);
        
        if (isEnding) {
          console.log(`[${key}] 👋 MENSAGEM DE DESPEDIDA - Não precisa resposta: "${messageText}"`);
          // Remove da lista de monitoramento
          conversations.delete(key);
          return;
        }
        
        // Verifica se está no horário de atendimento
        if (!isInBusinessHours(now)) {
          console.log(`[${key}] 🕰 FORA DO HORÁRIO - Não monitora (8h-18h)`);
          return;
        }
        
        console.log(`[${key}] 📨 MENSAGEM DO CLIENTE - Analisando atendimento`);
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
          lastMessageText: messageText,
          tags: webhookData.tags || []
        };
        
        // Analisa se cliente já foi atendido por humano
        const hasHumanAttendant = analyzeConversationForHumanAttendant(state.webhookHistory);
        
        if (hasHumanAttendant) {
          console.log(`[${key}] ✅ Cliente já foi atendido por humano - não monitora`);
        } else {
          console.log(`[${key}] ⏰ Cliente ainda não foi atendido - iniciando monitoramento`);
        }
        
      } else if (direction === 'out') {
        const isBot = isAutomaticMessage(messageText, attendantId);
        
        if (isBot) {
          console.log(`[${key}] 🤖 MENSAGEM AUTOMÁTICA - Continua monitoramento`);
        } else {
          console.log(`[${key}] 👤 RESPOSTA HUMANA - Cancelando timer`);
          state.lastOutboundAt = now;
        }
        
        // Mantém informações do cliente, atualiza atendente
        state.meta = {
          ...state.meta,
          attendantId,
          attendantName: getAttendantNameById(attendantId),
          lastMessageText: messageText
        };
      }
      
      conversations.set(key, state);
      
      // Log resumido do estado
      console.log(`[${key}] Estado atualizado:`, {
          hasInbound: Boolean(state.lastInboundAt),
        hasOutbound: Boolean(state.lastOutboundAt),
        hasHumanAttendant: analyzeConversationForHumanAttendant(state.webhookHistory || []),
        webhookCount: (state.webhookHistory || []).length,
        recentWebhooks: (state.webhookHistory || []).slice(-5).map(w => ({
          timestamp: new Date(w.timestamp).toLocaleString('pt-BR'),
          direction: w.direction,
          attendantName: w.attendantName,
          isBot: w.isBot,
          messagePreview: w.messageText ? w.messageText.substring(0, 50) : null
        })),
        needsAlert: state.lastInboundAt && !analyzeConversationForHumanAttendant(state.webhookHistory || []) && !state.alertedAt,
        clientName: state.meta.clientName,
        attendantName: state.meta.attendantName,
        sector: state.meta.sector
      });
      
    } else {
      // Log apenas para debug - Casos muito raros
      const reason = !key ? 'chave_ausente' : 'monitoramento_desabilitado';
      
      if (WEBHOOK_DEBUG && !key) {
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
    }

    
  } catch (error) {
    console.error(`❌ Erro processando webhook ${event.EventId}:`, error.message);
    
    // Se falhar muito, pode ser pausado automaticamente pelo Umbler
    if (attempt >= 3) {
      console.error(`⚠️ Webhook ${event.EventId} falhou ${attempt} vezes - pode ser pausado`);
    }
  }
}

// Função para extrair dados do webhook Umbler Talk 2.0
function extractUmblerWebhookData(event) {
  let conversationId = null;
  let fromPhone = null;
  let fromName = null;
  let attendantId = null;
  let direction = null;
  let messageText = null;
  let sector = 'Geral';
  let isPrivate = false;

  // Estrutura padrão Umbler Talk 2.0
  const payload = event.Payload;
  if (!payload || payload.Type !== 'Chat') {
    return null; // Não é um evento de chat válido
  }

  const content = payload.Content;
  if (!content) return null;

  const lastMessage = content.LastMessage || {};
  
  // Dados básicos do chat
  conversationId = content.Id;
  fromPhone = content.Contact?.PhoneNumber || content.Contact?.Phone;
  fromName = content.Contact?.Name;
  sector = content.Sector?.Name || 'Geral';
  
  // Extrai tags/etiquetas e verifica se é interno
  const tags = content.Tags || [];
  const tagNames = tags.map(tag => (tag.Name || tag.name || '').toLowerCase());
  const sectorName = (sector || '').toLowerCase();
  const contactName = (fromName || '').toLowerCase();
  
  // Verifica se é conversa interna por tag, setor, nome ou emoji
  const isInternal = tagNames.some(tag => INTERNAL_TAGS.some(internal => tag.includes(internal))) ||
                    INTERNAL_TAGS.some(internal => sectorName.includes(internal)) ||
                    INTERNAL_TAGS.some(internal => contactName.includes(internal)) ||
                    INTERNAL_EMOJIS.some(emoji => sectorName.includes(emoji) || contactName.includes(emoji));
  
  // Dados da mensagem
  messageText = lastMessage.Content || lastMessage.Text;
  isPrivate = lastMessage.IsPrivate || false;
  
  // Determina direção baseada na origem (padrão Umbler)
  const messageSource = lastMessage.Source;
  
  if (messageSource === 'Contact') {
    direction = 'in';
    attendantId = null;
  } else if (messageSource === 'Member') {
    direction = 'out';
    attendantId = lastMessage.SentByOrganizationMember?.Id || null;
  } else if (messageSource === 'Bot') {
    direction = 'out';
    attendantId = 'BOT_SYSTEM';
  } else {
    // Fallback
    direction = attendantId ? 'out' : 'in';
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
    sector,
    isPrivate,
    isInternal,
    tags: tagNames,
    eventId: event.EventId,
    eventDate: event.EventDate
  };
}

// Extrai setor do evento - ACEITA QUALQUER SETOR
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
  
  // ACEITA QUALQUER SETOR - não restringe
  if (tryValues.length > 0) return String(tryValues[0]).trim();
  return 'Todos_os_Setores'; // Indica que monitora todos
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
      clientName = 'Cliente Teste',
      isBot = false
    } = req.body;
    
    const messageText = isBot ? 
      'Olá! Bem-vindo ao nosso atendimento. Digite 1 para falar com atendente.' :
      'Olá! Como posso ajudar você?';
    
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
            Text: messageText,
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
        meta: {},
        webhookHistory: []
      };
      
      // Adiciona ao histórico
      state.webhookHistory.push({
        timestamp: now,
        direction: 'out',
        attendantId,
        attendantName: getAttendantNameById(attendantId),
        messageText,
        isBot: isAutomaticMessage(messageText, attendantId)
      });
      
      if (!isBot) {
        state.lastOutboundAt = now;
      }
      
      state.meta = {
        ...state.meta,
        attendantId: webhookData.attendantId,
        attendantName: getAttendantNameById(webhookData.attendantId)
      };
      
      conversations.set(key, state);
      
      const hasHumanAttendant = analyzeConversationForHumanAttendant(state.webhookHistory);
      
      res.json({
        success: true,
        message: `${isBot ? 'Mensagem de bot' : 'Resposta humana'} simulada com sucesso`,
        data: { key, webhookData, state },
        analysis: {
          isBot: isAutomaticMessage(messageText, attendantId),
          hasHumanAttendant,
          webhookHistoryCount: state.webhookHistory.length
        },
        result: hasHumanAttendant ? 'Cliente foi atendido por humano' : 'Cliente ainda não foi atendido por humano'
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

// Testar notificação para gestora
app.post('/api/test/notify-manager', async (req, res) => {
  try {
    const {
      clientName = 'Cliente Teste',
      conversationId = 'TEST_CONV_123',
      attendantName = 'Atendente Teste',
      sector = 'Geral',
      idleMinutes = 20
    } = req.body;
    
    const conversationData = {
      key: conversationId,
      clientName,
      conversationId,
      attendantName,
      sector,
      idleMinutes,
      link: `https://app-utalk.umbler.com/chats/${conversationId}`
    };
    
    const result = await notifyManagerAboutUnattendedClient(conversationData);
    
    res.json({
      success: true,
      message: 'Teste de notificação para gestora executado',
      result,
      managerId: MANAGER_ID,
      conversationData
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Simular webhook real de qualquer chat
app.post('/api/test/simulate-any-chat', async (req, res) => {
  try {
    const {
      conversationId = `CHAT_${Date.now()}`,
      clientPhone = `5548${Math.floor(Math.random() * 100000000)}`,
      clientName = 'Cliente Real',
      sector = 'Vendas',
      messageText = 'Olá, preciso de ajuda!'
    } = req.body;
    
    // Simula webhook real do UTalk
    const realWebhook = {
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
            Text: messageText,
            Chat: { Id: conversationId }
          }
        }
      },
      Sector: sector
    };
    
    // Processa como webhook real
    const webhookData = extractWebhookData(realWebhook);
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
        },
        webhookHistory: [{
          timestamp: now,
          direction: 'in',
          attendantId: null,
          attendantName: null,
          messageText,
          isBot: false
        }]
      };
      
      conversations.set(key, state);
      
      res.json({
        success: true,
        message: 'Chat simulado e adicionado ao monitoramento global',
        data: {
          key,
          conversationId,
          clientName,
          sector,
          monitoringStarted: new Date(now).toLocaleString('pt-BR')
        },
        instructions: [
          'Chat agora está sendo monitorado globalmente',
          `Aguarde ${IDLE_MS/60000} minutos ou force sweep`,
          'Gestora será notificada se não houver atendimento humano'
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

// ===== NOTIFICAÇÃO PARA APLICAÇÕES TERCEIRAS =====

// Envia webhook para aplicação terceira seguindo padrão Umbler
async function notifyThirdPartyWebhook(alertData, attempt = 1) {
  const webhookUrl = process.env.MANAGER1_WEBHOOK;
  
  if (!webhookUrl) {
    console.log('MANAGER1_WEBHOOK não configurado');
    return { success: false, error: 'Webhook URL not configured' };
  }

  const eventId = `ALERT_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Payload seguindo estrutura Umbler Talk 2.0
  const webhookPayload = {
    Type: 'ClientUnattended',
    EventDate: new Date().toISOString(),
    EventId: eventId,
    Payload: {
      Type: 'Alert',
      Content: {
        Id: alertData.conversationId || alertData.key,
        ClientName: alertData.clientName,
        ConversationId: alertData.conversationId || alertData.key,
        AttendantId: alertData.attendantId,
        AttendantName: alertData.attendantName,
        Sector: alertData.sector,
        IdleMinutes: alertData.idleMinutes,
        Link: alertData.link,
        Tags: alertData.tags || [],
        BusinessHours: {
          start: BUSINESS_START_HOUR,
          end: BUSINESS_END_HOUR,
          current: new Date().getHours()
        },
        Timestamp: new Date().toISOString()
      }
    }
  };

  try {
    const axios = require('axios');
    const response = await axios.post(webhookUrl, webhookPayload, {
      timeout: 4500, // < 5 segundos conforme Umbler
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'UTalk-Bot-Webhook/2.0',
        'x-attempt': attempt.toString(),
        'x-event-id': eventId
      }
    });
    
    // Verifica se resposta está no range 200-299
    if (response.status >= 200 && response.status <= 299) {
      console.log(`✅ Webhook terceiro enviado: ${response.status} (tentativa ${attempt})`);
      return { success: true, status: response.status, eventId };
    } else {
      throw new Error(`Status inválido: ${response.status}`);
    }
    
  } catch (error) {
    console.error(`❌ Erro webhook terceiro (tentativa ${attempt}):`, error.message);
    
    // Retry automático até 2 tentativas (conforme Umbler)
    if (attempt < 3) {
      console.log(`🔄 Tentando novamente em 2 segundos... (${attempt + 1}/3)`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return await notifyThirdPartyWebhook(alertData, attempt + 1);
    }
    
    return { success: false, error: error.message, attempts: attempt, eventId };
  }
}

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
  console.log('\n🔍 SISTEMA DE MONITORAMENTO GLOBAL:');
  console.log(`   ✅ Monitora TODOS os chats: ${MONITOR_ALL_CHATS}`);
  console.log(`   👤 Gestora (Manager ID): ${MANAGER_ID}`);
  console.log(`   ⏰ Tempo limite: ${IDLE_MS / 60000} minutos`);
  console.log(`   🕰 Horário comercial: ${BUSINESS_START_HOUR}:00 - ${BUSINESS_END_HOUR}:00`);
  console.log(`   💬 Chat backup: ${ALERT_CHAT_ID || 'Not set'}`);
  
  if (!MANAGER_ID) {
    console.log('\n⚠️  WARNING: MANAGER_ID not configured!');
    console.log('   Sistema não conseguirá notificar gestora.');
  } else {
    console.log('\n✅ Sistema configurado para monitorar TODOS os chats!');
    console.log('   Qualquer cliente não atendido será reportado à gestora.');
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