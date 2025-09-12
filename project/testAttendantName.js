#!/usr/bin/env node

const axios = require('axios');
require('dotenv').config();

const BASE_URL = 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'DESP102030';

class AttendantNameTester {
  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        'x-admin-token': ADMIN_TOKEN
      },
      timeout: 10000
    });
  }

  async testWithRealAttendant() {
    console.log('🧪 TESTANDO NOTIFICAÇÃO COM NOME REAL DO ATENDENTE\n');

    try {
      // 1. Simular cliente enviando mensagem
      console.log('1️⃣ Simulando cliente enviando mensagem...');
      const clientMessage = await this.client.post('/api/test/simulate-client-message', {
        conversationId: 'TEST_ATTENDANT_NAME',
        clientPhone: '5548999887766',
        clientName: 'Pedro Santos',
        sector: 'Vendas'
      });
      console.log('✅ Cliente enviou mensagem:', clientMessage.data.message);

      // 2. Simular bot respondendo
      console.log('\n2️⃣ Simulando resposta do bot...');
      const botResponse = await this.client.post('/api/test/simulate-attendant-reply', {
        conversationId: 'TEST_ATTENDANT_NAME',
        attendantId: 'BOT_SYSTEM',
        isBot: true,
        clientName: 'Pedro Santos'
      });
      console.log('✅ Bot respondeu');

      // 3. Simular atribuição para atendente específico (sem resposta ainda)
      console.log('\n3️⃣ Simulando atribuição para Adrielli Saturnino...');
      const assignResponse = await this.client.post('/api/test/simulate-attendant-reply', {
        conversationId: 'TEST_ATTENDANT_NAME',
        attendantId: 'ZrzsX_BLm_zYqujY', // Adrielli Saturnino
        isBot: true, // Ainda é automático, só atribuiu
        clientName: 'Pedro Santos'
      });
      console.log('✅ Conversa atribuída para Adrielli Saturnino');

      // 4. Verificar estado atual
      console.log('\n4️⃣ Verificando estado da conversa...');
      const debugState = await this.client.get('/api/webhook/utalk/debug');
      const conversation = debugState.data.conversations.find(c => c.key === 'TEST_ATTENDANT_NAME');
      
      if (conversation) {
        console.log('📊 Estado da conversa:');
        console.log(`   - Cliente: ${conversation.clientName}`);
        console.log(`   - Atendente ID: ${conversation.attendantId}`);
        console.log(`   - Atendente Nome: ${conversation.attendantName}`);
        console.log(`   - Setor: ${conversation.sector}`);
        console.log(`   - Precisa alerta: ${conversation.needsAlert}`);
        console.log(`   - Tempo aguardando: ${conversation.businessElapsedMinutes} minutos`);
      }

      // 5. Testar notificação direta com dados completos
      console.log('\n5️⃣ Testando notificação com dados completos...');
      const notificationTest = await this.client.post('/api/test/notify-manager', {
        clientName: 'Pedro Santos',
        conversationId: 'TEST_ATTENDANT_NAME',
        attendantId: 'ZrzsX_BLm_zYqujY', // Adrielli Saturnino
        attendantName: 'Adrielli Saturnino',
        sector: 'Vendas',
        idleMinutes: 25
      });

      console.log('✅ Teste de notificação:');
      console.log(`   - Sucesso WhatsApp: ${notificationTest.data.result?.success}`);
      console.log(`   - Dados enviados:`, {
        cliente: notificationTest.data.conversationData?.clientName,
        atendente: notificationTest.data.conversationData?.attendantName,
        setor: notificationTest.data.conversationData?.sector,
        tempo: notificationTest.data.conversationData?.idleMinutes
      });

      // 6. Forçar verificação de alertas para ver se funciona automaticamente
      console.log('\n6️⃣ Forçando verificação automática de alertas...');
      const alertCheck = await this.client.post('/api/webhook/utalk/sweep');
      console.log('✅ Verificação automática:', alertCheck.data);

      console.log('\n🎉 TESTE COMPLETO! Verifique se a mensagem chegou no WhatsApp com o nome correto.');

    } catch (error) {
      console.error('❌ Erro no teste:', error.response?.data || error.message);
    }
  }

  async testAllAttendants() {
    console.log('🧪 TESTANDO TODOS OS ATENDENTES\n');

    const attendants = [
      { id: 'ZrzsX_BLm_zYqujY', name: 'Adrielli Saturnino' },
      { id: 'ZuGqFp5N9i3HAKOn', name: 'Amanda Arruda' },
      { id: 'ZqOw4cIS50M0IyW4', name: 'ANA PAULA GOMES LOPES' },
      { id: 'ZaZkfnFmogpzCidw', name: 'Ana Paula Prates' },
      { id: 'Z46pqSA937XAoQjO', name: 'Andresa Oliveira' }
    ];

    for (const attendant of attendants) {
      try {
        console.log(`\n📋 Testando: ${attendant.name} (${attendant.id})`);
        
        const result = await this.client.post('/api/test/notify-manager', {
          clientName: 'Cliente Teste',
          conversationId: `TEST_${attendant.id}`,
          attendantId: attendant.id,
          attendantName: attendant.name,
          sector: 'Teste',
          idleMinutes: 20
        });

        if (result.data.result?.success) {
          console.log(`   ✅ ${attendant.name} - Notificação enviada`);
        } else {
          console.log(`   ❌ ${attendant.name} - Falha:`, result.data.result?.error);
        }

      } catch (error) {
        console.log(`   ❌ ${attendant.name} - Erro:`, error.message);
      }
    }
  }

  async checkCurrentConversations() {
    console.log('🔍 VERIFICANDO CONVERSAS ATUAIS\n');

    try {
      const response = await this.client.get('/api/webhook/utalk/debug');
      const data = response.data;
      
      if (!data.success) {
        console.error('❌ Erro ao buscar dados:', data.error);
        return;
      }

      const conversations = data.conversations || [];
      
      console.log(`📊 Total de conversas: ${conversations.length}`);
      console.log(`⏰ Horário comercial: ${data.isBusinessHours ? '✅ SIM' : '❌ NÃO'}`);
      console.log('');

      if (conversations.length === 0) {
        console.log('📭 Nenhuma conversa sendo monitorada.');
        return;
      }

      conversations.forEach((conv, index) => {
        console.log(`${index + 1}. 💬 ${conv.key}`);
        console.log(`   Cliente: ${conv.clientName || 'N/A'}`);
        console.log(`   Atendente: ${conv.attendantName || 'N/A'} (ID: ${conv.attendantId || 'N/A'})`);
        console.log(`   Setor: ${conv.sector || 'N/A'}`);
        console.log(`   Tempo: ${conv.businessElapsedMinutes || 0} min`);
        console.log(`   Precisa alerta: ${conv.needsAlert ? '🚨 SIM' : '⏸️ NÃO'}`);
        console.log('');
      });

    } catch (error) {
      console.error('❌ Erro:', error.message);
    }
  }
}

// Execução do script
async function main() {
  const tester = new AttendantNameTester();
  const args = process.argv.slice(2);
  
  if (args.includes('--all') || args.includes('-a')) {
    await tester.testAllAttendants();
  } else if (args.includes('--check') || args.includes('-c')) {
    await tester.checkCurrentConversations();
  } else if (args.includes('--help') || args.includes('-h')) {
    console.log('📋 USO DO SCRIPT:');
    console.log('');
    console.log('  node testAttendantName.js           # Teste completo com nome');
    console.log('  node testAttendantName.js --all     # Testa todos os atendentes');
    console.log('  node testAttendantName.js --check   # Verifica conversas atuais');
    console.log('  node testAttendantName.js --help    # Mostra esta ajuda');
    console.log('');
  } else {
    await tester.testWithRealAttendant();
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = AttendantNameTester;