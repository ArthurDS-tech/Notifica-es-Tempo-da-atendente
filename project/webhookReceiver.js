#!/usr/bin/env node

// Servidor de teste para receber webhooks de aplicações terceiras
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.WEBHOOK_TEST_PORT || 3001;

app.use(bodyParser.json());

// Armazena webhooks recebidos para análise
const receivedWebhooks = [];
const MAX_STORED_WEBHOOKS = 100;

// ===== ENDPOINT PARA RECEBER WEBHOOKS =====
app.post('/api/webhook/utalk', (req, res) => {
  const startTime = Date.now();
  
  try {
    const event = req.body || {};
    const attempt = req.headers['x-attempt'] || '1';
    const eventId = req.headers['x-event-id'] || event.EventId;
    
    console.log('=== WEBHOOK RECEBIDO ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Event ID:', eventId);
    console.log('Type:', event.Type);
    console.log('Attempt:', attempt);
    console.log('Event Date:', event.EventDate);
    
    // Armazena webhook para análise
    receivedWebhooks.unshift({
      receivedAt: new Date().toISOString(),
      eventId,
      attempt: parseInt(attempt),
      type: event.Type,
      eventDate: event.EventDate,
      payload: event.Payload,
      headers: {
        'x-attempt': req.headers['x-attempt'],
        'x-event-id': req.headers['x-event-id'],
        'user-agent': req.headers['user-agent']
      },
      processingTime: Date.now() - startTime
    });
    
    // Mantém apenas os últimos webhooks
    if (receivedWebhooks.length > MAX_STORED_WEBHOOKS) {
      receivedWebhooks.pop();
    }
    
    // Log detalhado do conteúdo
    if (event.Type === 'ClientUnattended' && event.Payload?.Content) {
      const content = event.Payload.Content;
      console.log('--- DETALHES DO ALERTA ---');
      console.log('Cliente:', content.ClientName);
      console.log('Conversa ID:', content.ConversationId);
      console.log('Atendente:', content.AttendantName);
      console.log('Setor:', content.Sector);
      console.log('Tempo aguardando:', content.IdleMinutes, 'minutos');
      console.log('Link:', content.Link);
      console.log('Tags:', content.Tags);
      console.log('Horário comercial:', content.BusinessHours);
      console.log('-------------------------');
    }
    
    const processingTime = Date.now() - startTime;
    console.log('Processamento:', processingTime, 'ms');
    console.log('========================\n');
    
    // Resposta rápida conforme padrão Umbler (< 5 segundos)
    res.status(200).json({
      received: true,
      eventId,
      timestamp: new Date().toISOString(),
      processingTime
    });
    
  } catch (error) {
    console.error('Erro processando webhook:', error);
    res.status(200).json({
      received: true,
      error: 'processed_with_error',
      timestamp: new Date().toISOString()
    });
  }
});

// ===== ENDPOINT PARA VER WEBHOOKS RECEBIDOS =====
app.get('/api/webhooks/received', (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const type = req.query.type;
  
  let filtered = receivedWebhooks;
  
  if (type) {
    filtered = receivedWebhooks.filter(w => w.type === type);
  }
  
  res.json({
    success: true,
    total: receivedWebhooks.length,
    filtered: filtered.length,
    webhooks: filtered.slice(0, limit),
    summary: {
      totalReceived: receivedWebhooks.length,
      byType: receivedWebhooks.reduce((acc, w) => {
        acc[w.type] = (acc[w.type] || 0) + 1;
        return acc;
      }, {}),
      retries: receivedWebhooks.filter(w => w.attempt > 1).length,
      avgProcessingTime: receivedWebhooks.length > 0 
        ? Math.round(receivedWebhooks.reduce((sum, w) => sum + w.processingTime, 0) / receivedWebhooks.length)
        : 0
    }
  });
});

// ===== ENDPOINT PARA LIMPAR HISTÓRICO =====
app.delete('/api/webhooks/clear', (req, res) => {
  const cleared = receivedWebhooks.length;
  receivedWebhooks.length = 0;
  
  res.json({
    success: true,
    message: `${cleared} webhooks removidos do histórico`
  });
});

// ===== PÁGINA DE STATUS =====
app.get('/', (req, res) => {
  const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Webhook Receiver - Status</title>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .status { background: #e8f5e8; padding: 15px; border-radius: 5px; margin: 10px 0; }
        .webhook { background: #f5f5f5; padding: 10px; margin: 5px 0; border-radius: 3px; }
        .error { background: #ffe8e8; }
        pre { background: #f0f0f0; padding: 10px; overflow-x: auto; }
    </style>
</head>
<body>
    <h1>🎣 Webhook Receiver</h1>
    
    <div class="status">
        <h3>📊 Status do Servidor</h3>
        <p><strong>Porta:</strong> ${PORT}</p>
        <p><strong>Endpoint:</strong> POST /api/webhook/utalk</p>
        <p><strong>Webhooks recebidos:</strong> ${receivedWebhooks.length}</p>
        <p><strong>Última atualização:</strong> ${new Date().toLocaleString('pt-BR')}</p>
    </div>
    
    <h3>📋 Últimos Webhooks</h3>
    ${receivedWebhooks.slice(0, 5).map(w => `
        <div class="webhook">
            <strong>${w.type}</strong> - ${w.eventId} 
            <small>(${w.receivedAt})</small>
            ${w.attempt > 1 ? `<span style="color: orange;">Tentativa ${w.attempt}</span>` : ''}
            <br>
            <small>Processamento: ${w.processingTime}ms</small>
        </div>
    `).join('')}
    
    <p><a href="/api/webhooks/received">Ver todos os webhooks (JSON)</a></p>
    
    <script>
        // Auto-refresh a cada 10 segundos
        setTimeout(() => location.reload(), 10000);
    </script>
</body>
</html>`;
  
  res.send(html);
});

// ===== INICIALIZAÇÃO =====
app.listen(PORT, () => {
  console.log(`🎣 Webhook Receiver rodando na porta ${PORT}`);
  console.log(`📋 Status: http://localhost:${PORT}`);
  console.log(`🎯 Endpoint: http://localhost:${PORT}/api/webhook/utalk`);
  console.log(`📊 API: http://localhost:${PORT}/api/webhooks/received`);
  console.log('');
  console.log('💡 Configure no .env:');
  console.log(`   MANAGER1_WEBHOOK=http://localhost:${PORT}/api/webhook/utalk`);
  console.log('');
});

module.exports = app;