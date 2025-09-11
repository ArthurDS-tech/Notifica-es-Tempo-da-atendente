#!/usr/bin/env node

const axios = require('axios');
require('dotenv').config();

const BASE_URL = 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'DESP102030';

class ContactChecker {
  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        'x-admin-token': ADMIN_TOKEN
      },
      timeout: 10000
    });
  }

  async checkAllContacts() {
    console.log('🔍 VERIFICANDO TODOS OS CONTATOS...\n');
    
    try {
      // Busca estado atual de todas as conversas
      const response = await this.client.get('/api/webhook/utalk/debug');
      const data = response.data;
      
      if (!data.success) {
        console.error('❌ Erro ao buscar dados:', data.error);
        return;
      }

      const conversations = data.conversations || [];
      
      console.log(`📊 RESUMO GERAL:`);
      console.log(`   Total de conversas: ${conversations.length}`);
      console.log(`   Horário comercial: ${data.isBusinessHours ? '✅ SIM' : '❌ NÃO'}`);
      console.log(`   Tempo atual: ${data.currentTime}`);
      console.log(`   Precisam de alerta: ${data.conversationsNeedingAlert || 0}`);
      console.log('');

      if (conversations.length === 0) {
        console.log('📭 Nenhuma conversa sendo monitorada no momento.');
        return;
      }

      // Agrupa por status
      const responded = conversations.filter(c => c.lastOutboundAt && c.lastInboundAt && c.lastOutboundAt >= c.lastInboundAt);
      const pending = conversations.filter(c => !c.lastOutboundAt || (c.lastInboundAt && c.lastOutboundAt < c.lastInboundAt));
      const alerted = conversations.filter(c => c.alertedAt);

      console.log(`📈 STATUS DAS CONVERSAS:`);
      console.log(`   ✅ Respondidas: ${responded.length}`);
      console.log(`   ⏳ Pendentes: ${pending.length}`);
      console.log(`   🚨 Já alertadas: ${alerted.length}`);
      console.log('');

      // Mostra detalhes das pendentes
      if (pending.length > 0) {
        console.log('⏳ CONVERSAS PENDENTES DE RESPOSTA:');
        console.log(''.padEnd(80, '='));
        
        pending.forEach((conv, index) => {
          const minutes = conv.businessElapsedMinutes || 0;
          const status = minutes >= (data.idleMinutes || 15) ? '🔴 ATRASADA' : '🟡 AGUARDANDO';
          
          console.log(`${index + 1}. ${status}`);
          console.log(`   Cliente: ${conv.clientName || 'Não informado'}`);
          console.log(`   Chat ID: ${conv.key}`);
          console.log(`   Setor: ${conv.sector || 'Geral'}`);
          console.log(`   Última mensagem: ${conv.lastInboundAt || 'N/A'}`);
          console.log(`   Tempo aguardando: ${minutes} minutos`);
          console.log(`   Atendente: ${conv.attendantName || 'Não atribuído'}`);
          console.log(`   Precisa alerta: ${conv.needsAlert ? '🚨 SIM' : '⏸️ NÃO'}`);
          console.log('');
        });
      }

      // Mostra detalhes das respondidas
      if (responded.length > 0) {
        console.log('✅ CONVERSAS JÁ RESPONDIDAS:');
        console.log(''.padEnd(80, '='));
        
        responded.forEach((conv, index) => {
          console.log(`${index + 1}. ✅ RESPONDIDA`);
          console.log(`   Cliente: ${conv.clientName || 'Não informado'}`);
          console.log(`   Chat ID: ${conv.key}`);
          console.log(`   Atendente: ${conv.attendantName || 'Sistema'}`);
          console.log(`   Última resposta: ${conv.lastOutboundAt || 'N/A'}`);
          console.log('');
        });
      }

      // Estatísticas finais
      console.log('📊 ESTATÍSTICAS:');
      console.log(''.padEnd(80, '='));
      console.log(`   Taxa de resposta: ${conversations.length > 0 ? Math.round((responded.length / conversations.length) * 100) : 0}%`);
      console.log(`   Alertas enviados hoje: ${data.stats?.totalAlertsSent || 0}`);
      console.log(`   Uptime do sistema: ${data.stats?.uptimeHours || 0}h`);
      console.log('');

    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        console.error('❌ Servidor não está rodando. Inicie com: npm start');
      } else {
        console.error('❌ Erro:', error.message);
      }
    }
  }

  async watchContacts() {
    console.log('👀 MODO MONITORAMENTO CONTÍNUO INICIADO');
    console.log('Pressione Ctrl+C para parar\n');
    
    const checkInterval = setInterval(async () => {
      console.clear();
      console.log(`🕐 ${new Date().toLocaleString('pt-BR')} - Atualizando...\n`);
      await this.checkAllContacts();
      console.log('\n⏰ Próxima atualização em 30 segundos...');
    }, 30000);

    // Primeira verificação imediata
    await this.checkAllContacts();
    console.log('\n⏰ Próxima atualização em 30 segundos...');

    // Graceful shutdown
    process.on('SIGINT', () => {
      clearInterval(checkInterval);
      console.log('\n👋 Monitoramento interrompido.');
      process.exit(0);
    });
  }

  async forceCheck() {
    console.log('🔄 FORÇANDO VERIFICAÇÃO DE ALERTAS...\n');
    
    try {
      const response = await this.client.post('/api/webhook/utalk/sweep');
      const data = response.data;
      
      if (data.success) {
        console.log(`✅ ${data.message}`);
        console.log(`📤 Alertas enviados: ${data.alertsSent}`);
      } else {
        console.error('❌ Erro:', data.error);
      }
    } catch (error) {
      console.error('❌ Erro ao forçar verificação:', error.message);
    }
  }
}

// Execução do script
async function main() {
  const checker = new ContactChecker();
  const args = process.argv.slice(2);
  
  if (args.includes('--watch') || args.includes('-w')) {
    await checker.watchContacts();
  } else if (args.includes('--force') || args.includes('-f')) {
    await checker.forceCheck();
  } else if (args.includes('--help') || args.includes('-h')) {
    console.log('📋 USO DO SCRIPT:');
    console.log('');
    console.log('  node checkAllContacts.js           # Verificação única');
    console.log('  node checkAllContacts.js --watch   # Monitoramento contínuo');
    console.log('  node checkAllContacts.js --force   # Força verificação de alertas');
    console.log('  node checkAllContacts.js --help    # Mostra esta ajuda');
    console.log('');
  } else {
    await checker.checkAllContacts();
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = ContactChecker;