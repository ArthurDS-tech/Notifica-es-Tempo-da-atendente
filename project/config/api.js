const axios = require('axios');
require('dotenv').config();

class UTalkAPI {
  constructor() {
    this.baseURL = (process.env.UTALK_BASE_URL || 'https://app-utalk.umbler.com/api').replace(/\/$/, '');
    this.token = process.env.UTALK_API_TOKEN;
    
    if (!this.token) {
      throw new Error('UTALK_API_TOKEN is required in environment variables');
    }

    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/json'
      },
      timeout: 30000
    });

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        console.error('API Request failed:', {
          url: error.config?.url,
          method: error.config?.method,
          status: error.response?.status,
          data: error.response?.data
        });
        
        if (error.response) {
          const { status, data } = error.response;
          
          switch (status) {
            case 400:
              throw new Error(`Bad Request: ${data.detail || data.message || 'Invalid request data'}`);
            case 401:
              throw new Error('Unauthorized: Check your API token');
            case 403:
              throw new Error('Forbidden: Insufficient permissions');
            case 404:
              throw new Error('Not Found: Resource does not exist');
            case 429:
              throw new Error('Rate Limit Exceeded: Please wait before making more requests');
            case 500:
              throw new Error(`Server Error: ${data.detail || data.message || 'Please try again later'}`);
            default:
              throw new Error(`API Error ${status}: ${data.detail || data.message || 'Unknown error occurred'}`);
          }
        }
        
        if (error.code === 'ECONNREFUSED') {
          throw new Error('Connection refused: Check your internet connection');
        }
        
        throw error;
      }
    );
  }

  // Get user information and organization ID
  async getMe() {
    try {
      const response = await this.client.get('/v1/members/me');
      return response.data;
    } catch (error) {
      console.error('Failed to get user info:', error.message);
      throw error;
    }
  }

  // List all channels
  async getChannels() {
    try {
      const response = await this.client.get('/v1/channels');
      return response.data;
    } catch (error) {
      console.error('Failed to get channels:', error.message);
      throw error;
    }
  }

  // Create a Business API channel with phone number (no QR needed)
  async createBusinessChannel(name, phoneNumber) {
    try {
      // Clean phone number and ensure it starts with "+"
      let cleanPhone = phoneNumber.replace(/\D/g, '');
      if (!cleanPhone.startsWith('+')) {
        cleanPhone = '+' + cleanPhone;
      }
      
      const response = await this.client.post('/v1/channels/waba', {
        name: name,
        phoneNumber: cleanPhone
      });
      return response.data;
    } catch (error) {
      console.error('Failed to create business channel:', error.message);
      throw error;
    }
  }

  // Create a Starter channel (fallback option)
  async createStarterChannel(name) {
    try {
      const response = await this.client.post('/v1/channels/starter', { name });
      return response.data;
    } catch (error) {
      console.error('Failed to create starter channel:', error.message);
      throw error;
    }
  }

  // Delete a channel
  async deleteChannel(channelId) {
    try {
      await this.client.delete(`/v1/channels/${channelId}`);
      return { success: true, message: 'Channel deleted successfully' };
    } catch (error) {
      console.error('Failed to delete channel:', error.message);
      throw error;
    }
  }

  // Send a simple text message
  async sendMessage(channelId, phoneNumber, message, organizationId) {
    try {
      // Validate required parameters
      if (!channelId) {
        throw new Error('channelId is required');
      }
      if (!phoneNumber) {
        throw new Error('phoneNumber is required');
      }
      if (!message) {
        throw new Error('message is required');
      }

      // Clean phone number (API expects just digits with country code)
      const cleanPhone = phoneNumber.replace(/\D/g, '');
      
      // Validate phone number format
      if (cleanPhone.length < 9 || cleanPhone.length > 16) {
        throw new Error('Invalid phone number format. Must include country code (e.g., +5511999999999)');
      }

      const payload = {
        ToPhone: cleanPhone,
        FromPhone: process.env.BUSINESS_PHONE,
        OrganizationId: organizationId,
        Message: message.trim()
      };

      console.log('Sending message with payload:', payload);
      
      // Simplified send endpoint per docs
      const response = await this.client.post('/v1/messages/simplified/', payload, {
        headers: { 'Content-Type': 'application/json' }
      });
      return response.data;
    } catch (error) {
      if (error.response?.data) {
        console.error('API Error Details:', error.response.data);
      }
      console.error('Failed to send message:', error.message);
      throw error;
    }
  }

  // ===== NOVO MÉTODO: Enviar mensagem para usuário específico =====
  async sendMessageToUser(userId, message, organizationId) {
    try {
      if (!userId || !message || !organizationId) {
        throw new Error('userId, message and organizationId are required');
      }

      console.log(`Enviando mensagem para usuário ${userId}`);

      const userPayload = {
        UserId: userId,
        OrganizationId: organizationId,
        Message: message.trim(),
        MessageType: 'Text'
      };

      const response = await this.client.post('/v1/users/send-message/', userPayload, {
        headers: { 'Content-Type': 'application/json' }
      });
      
      console.log(`✅ Mensagem enviada para usuário ${userId}`);
      return response.data;
      
    } catch (error) {
      console.error(`❌ Falha ao enviar mensagem para usuário ${userId}:`, error.message);
      throw new Error(`Failed to send message to user ${userId}: ${error.message}`);
    }
  }

  // ===== MÉTODO: Enviar mensagem para chat específico =====
  async sendMessageToChat(chatId, message, organizationId) {
    try {
      // Validate required parameters
      if (!chatId) {
        throw new Error('chatId is required');
      }
      if (!message) {
        throw new Error('message is required');
      }
      if (!organizationId) {
        throw new Error('organizationId is required');
      }

      console.log(`Enviando mensagem para chat ${chatId}:`, message.substring(0, 100) + '...');

      // Primeiro, tenta enviar via endpoint de chat direto
      try {
        const chatPayload = {
          ChatId: chatId,
          OrganizationId: organizationId,
          Message: message.trim(),
          MessageType: 'Text'
        };

        const response = await this.client.post('/v1/chats/send-message/', chatPayload, {
          headers: { 'Content-Type': 'application/json' }
        });
        
        console.log(`✅ Mensagem enviada para chat ${chatId} via endpoint direto`);
        return response.data;
        
      } catch (chatError) {
        console.warn(`Endpoint de chat direto falhou, tentando método alternativo:`, chatError.message);
        
        // Método alternativo: enviar via endpoint de mensagens com chat ID
        try {
          const altPayload = {
            chat_id: chatId,
            organization_id: organizationId,
            message: message.trim(),
            message_type: 'text'
          };

          const altResponse = await this.client.post('/v1/messages/', altPayload, {
            headers: { 'Content-Type': 'application/json' }
          });
          
          console.log(`✅ Mensagem enviada para chat ${chatId} via método alternativo`);
          return altResponse.data;
          
        } catch (altError) {
          console.warn(`Método alternativo também falhou, tentando terceira opção:`, altError.message);
          
          // Terceira tentativa: usar endpoint interno de chat
          const internalPayload = {
            Id: chatId,
            OrganizationId: organizationId,
            Content: message.trim(),
            Type: 'Text'
          };

          const internalResponse = await this.client.post('/v1/internal/chats/message/', internalPayload, {
            headers: { 'Content-Type': 'application/json' }
          });
          
          console.log(`✅ Mensagem enviada para chat ${chatId} via endpoint interno`);
          return internalResponse.data;
        }
      }
      
    } catch (error) {
      console.error(`❌ Falha ao enviar mensagem para chat ${chatId}:`, error.message);
      if (error.response?.data) {
        console.error('Detalhes do erro da API:', error.response.data);
      }
      throw new Error(`Failed to send message to chat ${chatId}: ${error.message}`);
    }
  }

  // Send a template message (for messages outside 24h window)
  async sendTemplateMessage(channelId, phoneNumber, templateName, parameters = [], organizationId) {
    try {
      // Clean phone number
      const cleanPhone = phoneNumber.replace(/\D/g, '');
      
      const response = await this.client.post('/v1/template-messages/simplified/', {
        ToPhone: cleanPhone,
        FromPhone: process.env.BUSINESS_PHONE,
        OrganizationId: organizationId,
        TemplateName: templateName,
        Parameters: parameters
      }, { headers: { 'Content-Type': 'application/json' } });
      return response.data;
    } catch (error) {
      console.error('Failed to send template message:', error.message);
      throw error;
    }
  }

  // Get channel status and QR code (for initial setup)
  async getChannelStatus(channelId) {
    try {
      const response = await this.client.get(`/v1/channels/${channelId}`);
      return response.data;
    } catch (error) {
      console.error('Failed to get channel status:', error.message);
      throw error;
    }
  }

  // Get chat information
  async getChatInfo(chatId) {
    try {
      const response = await this.client.get(`/v1/chats/${chatId}`);
      return response.data;
    } catch (error) {
      console.error(`Failed to get chat info for ${chatId}:`, error.message);
      throw error;
    }
  }

  // List all chats (for debugging)
  async getChats(organizationId, limit = 50) {
    try {
      const response = await this.client.get('/v1/chats/', {
        params: {
          organization_id: organizationId,
          limit: limit,
          ordering: '-created_at'
        }
      });
      return response.data;
    } catch (error) {
      console.error('Failed to get chats:', error.message);
      throw error;
    }
  }

  // Format professional message with business details
  formatBusinessMessage(message, attendantName, location, schedule, link = null) {
    let formattedMessage = `${message}\n\n`;
    
    if (attendantName) {
      formattedMessage += `👤 *Atendente:* ${attendantName}\n`;
    }
    
    if (location) {
      formattedMessage += `📍 *Local:* ${location}\n`;
    }
    
    if (schedule) {
      formattedMessage += `🕐 *Horário:* ${schedule}\n`;
    }
    
    if (link) {
      formattedMessage += `🔗 *Link:* ${link}\n`;
    }
    
    formattedMessage += `\n_Mensagem enviada automaticamente via UTalk Bot_`;
    
    return formattedMessage;
  }

  // Format organized customer notification message
  formatOrganizedNotification({ clientName, attendantName, idleTime, link }) {
    const lines = [];
    lines.push('📩 *Notificação de Atendimento*');
    if (clientName) lines.push(`👤 *Cliente:* ${clientName}`);
    if (attendantName) lines.push(`🧑‍💼 *Atendente:* ${attendantName}`);
    if (idleTime) lines.push(`⏱️ *Tempo sem resposta:* ${idleTime}`);
    if (link) lines.push(`🔗 *Link:* ${link}`);
    lines.push('');
    lines.push('_Mensagem enviada automaticamente via UTalk Bot_');
    return lines.join('\n');
  }

  // ===== MÉTODO ESPECÍFICO PARA ALERTAS DE INATIVIDADE =====
  formatInactivityAlert({ clientName, attendantName, idleMinutes, link, sector, timestamp }) {
    const lines = [];
    lines.push('🚨 *ALERTA DE INATIVIDADE*');
    lines.push('');
    lines.push(`👤 *Cliente:* ${clientName || 'Nome não informado'}`);
    lines.push(`🧑‍💼 *Atendente:* ${attendantName || 'Não definido'}`);
    lines.push(`📍 *Setor:* ${sector || 'Geral'}`);
    lines.push(`⏱️ *Tempo sem resposta:* ${idleMinutes} minutos`);
    
    if (link) {
      lines.push(`🔗 *Conversa:* ${link}`);
    }
    
    lines.push(`📅 *Data/Hora:* ${timestamp || new Date().toLocaleString('pt-BR')}`);
    lines.push('');
    lines.push('⚠️ *Ação necessária:* Verificar e responder ao cliente');
    lines.push('');
    lines.push('_Alerta automático do sistema UTalk Bot_');
    
    return lines.join('\n');
  }

  // ===== MÉTODO PARA FORMATAÇÃO DE ALERTA DE CLIENTE NÃO ATENDIDO =====
  formatUnattendedClientAlert({ clientName, conversationId, attendantName, sector, idleMinutes, link, timestamp }) {
    const lines = [];
    lines.push('🚨 *CLIENTE NÃO ATENDIDO*');
    lines.push('');
    lines.push(`👤 *Cliente:* ${clientName || 'Nome não informado'}`);
    lines.push(`💬 *Chat ID:* ${conversationId || 'Não disponível'}`);
    lines.push(`🧑💼 *Último atendente:* ${attendantName || 'Não definido'}`);
    lines.push(`📍 *Setor:* ${sector || 'Geral'}`);
    lines.push(`⏱️ *Tempo aguardando:* ${idleMinutes} minutos`);
    
    if (link) {
      lines.push(`🔗 *Link:* ${link}`);
    }
    
    lines.push(`📅 *Data/Hora:* ${timestamp || new Date().toLocaleString('pt-BR')}`);
    lines.push('');
    lines.push('⚠️ *Cliente ainda não recebeu atendimento humano após mensagens automáticas*');
    lines.push('');
    lines.push('_Notificação automática do sistema UTalk Bot_');
    
    return lines.join('\n');
  }
}

module.exports = UTalkAPI;