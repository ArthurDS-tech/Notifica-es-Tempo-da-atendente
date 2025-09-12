// Endpoint de debug para Vercel
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminToken = req.headers['x-admin-token'] || req.query.token;
  if (process.env.ADMIN_TOKEN && adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const conversations = global.conversations || new Map();
    const now = Date.now();
    
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
      businessElapsedMinutes: s.lastInboundAt ? Math.round((now - s.lastInboundAt) / 60000) : null,
      webhookCount: (s.webhookHistory || []).length,
      recentWebhooks: (s.webhookHistory || []).slice(-5).map(w => ({
        timestamp: new Date(w.timestamp).toLocaleString('pt-BR'),
        direction: w.direction,
        attendantName: w.attendantName,
        isBot: w.isBot,
        messagePreview: w.messageText ? w.messageText.substring(0, 50) : null
      }))
    }));
    
    res.json({
      success: true,
      currentTime: new Date().toLocaleString('pt-BR'),
      isBusinessHours: isWithinBusinessHours(now),
      conversations: states,
      totalConversations: conversations.size,
      serverless: true,
      vercel: true
    });
    
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
};

function isWithinBusinessHours(timestamp) {
  const date = new Date(timestamp);
  const hour = date.getHours();
  const day = date.getDay();
  const BUSINESS_START_HOUR = Number(process.env.BUSINESS_START_HOUR || 8);
  const BUSINESS_END_HOUR = Number(process.env.BUSINESS_END_HOUR || 18);
  return day >= 1 && day <= 5 && hour >= BUSINESS_START_HOUR && hour < BUSINESS_END_HOUR;
}