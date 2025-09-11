// Teste do sistema de análise de webhooks para detecção de atendimento humano
const axios = require('axios');

const BASE_URL = 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

class WebhookAnalyzerTester {
  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        'x-admin-token': ADMIN_TOKEN
      }
    });
  }

  async testCompleteFlow() {
    console.log('🧪 TESTANDO FLUXO COMPLETO DE ANÁLISE DE WEBHOOKS\n');

    try {
      // 1. Simular mensagem do cliente
      console.log('1️⃣ Simulando mensagem do cliente...');
      const clientMessage = await this.client.post('/api/test/simulate-client-message', {
        conversationId: 'TEST_WEBHOOK_FLOW',
        clientPhone: '5511999888777',
        clientName: 'João Silva',
        sector: 'Vendas'
      });
      console.log('✅ Cliente enviou mensagem:', clientMessage.data.message);

      // 2. Simular resposta automática (bot)
      console.log('\n2️⃣ Simulando resposta automática do bot...');
      const botResponse = await this.client.post('/api/test/simulate-attendant-reply', {
        conversationId: 'TEST_WEBHOOK_FLOW',
        attendantId: 'BOT_SYSTEM',
        isBot: true
      });
      console.log('✅ Bot respondeu:', botResponse.data.analysis);

      // 3. Verificar estado atual
      console.log('\n3️⃣ Verificando estado da conversa...');
      const debugState = await this.client.get('/api/webhook/utalk/debug');
      const conversation = debugState.data.conversations.find(c => c.key === 'TEST_WEBHOOK_FLOW');
      
      if (conversation) {
        console.log('📊 Estado da conversa:');
        console.log(`   - Cliente atendido por humano: ${conversation.hasHumanAttendant}`);
        console.log(`   - Webhooks registrados: ${conversation.webhookCount}`);
        console.log(`   - Precisa de alerta: ${conversation.needsAlert}`);
        console.log(`   - Últimos webhooks:`, conversation.recentWebhooks);
      }

      // 4. Aguardar tempo suficiente para trigger de alerta
      console.log('\n4️⃣ Forçando verificação de alertas...');
      const alertCheck = await this.client.post('/api/webhook/utalk/sweep');
      console.log('✅ Verificação de alertas:', alertCheck.data);

      // 5. Simular resposta humana
      console.log('\n5️⃣ Simulando resposta humana do atendente...');
      const humanResponse = await this.client.post('/api/test/simulate-attendant-reply', {
        conversationId: 'TEST_WEBHOOK_FLOW',
        attendantId: 'ZrzsX_BLm_zYqujY', // Adrielli Saturnino
        isBot: false
      });
      console.log('✅ Atendente humano respondeu:', humanResponse.data.analysis);

      // 6. Verificar estado final
      console.log('\n6️⃣ Verificando estado final...');
      const finalState = await this.client.get('/api/webhook/utalk/debug');
      const finalConversation = finalState.data.conversations.find(c => c.key === 'TEST_WEBHOOK_FLOW');
      
      if (finalConversation) {
        console.log('📊 Estado final da conversa:');
        console.log(`   - Cliente atendido por humano: ${finalConversation.hasHumanAttendant}`);
        console.log(`   - Webhooks registrados: ${finalConversation.webhookCount}`);
        console.log(`   - Precisa de alerta: ${finalConversation.needsAlert}`);
      }

      console.log('\n✅ TESTE COMPLETO FINALIZADO COM SUCESSO!');

    } catch (error) {
      console.error('❌ Erro no teste:', error.response?.data || error.message);
    }
  }

  async testManagerNotification() {
    console.log('🧪 TESTANDO NOTIFICAÇÃO PARA GESTORA\n');

    try {
      const result = await this.client.post('/api/test/notify-manager', {
        clientName: 'Maria Santos',
        conversationId: 'TEST_MANAGER_NOTIF',
        attendantName: 'Sistema Automático',
        sector: 'Suporte',
        idleMinutes: 25
      });

      console.log('✅ Notificação enviada para gestora:');
      console.log(`   - Sucesso: ${result.data.result.success}`);
      console.log(`   - Manager ID: ${result.data.managerId}`);
      console.log(`   - Dados da conversa:`, result.data.conversationData);

    } catch (error) {
      console.error('❌ Erro ao testar notificação:', error.response?.data || error.message);
    }
  }

  async testBotDetection() {
    console.log('🧪 TESTANDO DETECÇÃO DE MENSAGENS AUTOMÁTICAS\n');

    const testMessages = [
      { text: 'Olá! Bem-vindo ao nosso atendimento automático', expected: true },
      { text: 'Digite 1 para vendas, 2 para suporte', expected: true },
      { text: 'Como posso ajudar você hoje?', expected: true },
      { text: 'Oi! Tudo bem? Vou te ajudar com seu pedido', expected: false },
      { text: 'Claro, vou verificar isso para você agora mesmo', expected: false },
      { text: 'Menu principal: selecione uma opção', expected: true }
    ];

    console.log('🔍 Testando detecção de mensagens automáticas:');
    
    for (const test of testMessages) {
      // Simular função de detecção (seria necessário expor via API para teste completo)
      const isBot = this.detectBotMessage(test.text);
      const status = isBot === test.expected ? '✅' : '❌';
      console.log(`   ${status} "${test.text}" -> Bot: ${isBot} (esperado: ${test.expected})`);
    }
  }

  // Replica a lógica de detecção do servidor para teste
  detectBotMessage(messageText) {
    if (!messageText) return false;
    
    const botPatterns = [
      /olá.*bem.*vindo/i,
      /como.*posso.*ajudar/i,
      /digite.*opção/i,
      /selecione.*uma.*opção/i,
      /menu.*principal/i,
      /atendimento.*automático/i,
      /bot.*atendimento/i,
      /^\d+\s*-/,
      /para.*falar.*atendente/i,
      /horário.*funcionamento/i
    ];
    
    return botPatterns.some(pattern => pattern.test(messageText));
  }

  async runAllTests() {
    console.log('🚀 INICIANDO TODOS OS TESTES DO SISTEMA DE WEBHOOKS\n');
    console.log('=' .repeat(60));
    
    await this.testBotDetection();
    console.log('\n' + '=' .repeat(60));
    
    await this.testManagerNotification();
    console.log('\n' + '=' .repeat(60));
    
    await this.testCompleteFlow();
    console.log('\n' + '=' .repeat(60));
    
    console.log('\n🎉 TODOS OS TESTES CONCLUÍDOS!');
  }
}

// Executa testes se chamado diretamente
if (require.main === module) {
  const tester = new WebhookAnalyzerTester();
  
  const testType = process.argv[2];
  
  switch (testType) {
    case 'flow':
      tester.testCompleteFlow();
      break;
    case 'manager':
      tester.testManagerNotification();
      break;
    case 'bot':
      tester.testBotDetection();
      break;
    default:
      tester.runAllTests();
  }
}

module.exports = WebhookAnalyzerTester;