// Endpoint de teste para Vercel
const UTalkAPI = require('../../config/api');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { 
      clientName = 'Cliente Teste',
      attendantName = 'Atendente Teste',
      idleMinutes = 15,
      sector = 'Geral'
    } = req.body;
    
    const organizationId = process.env.ORGANIZATION_ID;
    const channelId = process.env.CHANNEL_ID;
    const managerPhone = process.env.MANAGER_PHONE;
    
    if (!managerPhone) {
      return res.status(400).json({
        success: false,
        error: 'MANAGER_PHONE não configurado'
      });
    }

    const alertMessage = `🚨 *TESTE DE ALERTA VERCEL*

👤 *Cliente:* ${clientName}
🧑💼 *Atendente:* ${attendantName}
📍 *Setor:* ${sector}
⏱️ *Tempo:* ${idleMinutes} minutos
📅 *Data/Hora:* ${new Date().toLocaleString('pt-BR')}

_Teste do sistema Vercel Serverless_`;

    const api = new UTalkAPI();
    const result = await api.sendMessage(channelId, managerPhone, alertMessage, organizationId);
    
    res.json({
      success: true,
      message: 'Teste de alerta executado no Vercel',
      result,
      sentTo: managerPhone,
      serverless: true
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      serverless: true 
    });
  }
};