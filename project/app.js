const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const UTalkAPI = require('./config/api');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize API
let api;
try {
  api = new UTalkAPI();
} catch (error) {
  console.error('Failed to initialize UTalk API:', error.message);
  console.log('Please run: npm run setup');
  process.exit(1);
}

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint to get account info
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
        channelId: process.env.CHANNEL_ID
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to get channel status
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

// API endpoint to send message
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
      link
    } = req.body;

    // Validate input
    if (!phoneNumber || !message) {
      return res.status(400).json({
        success: false,
        error: 'Phone number and message are required'
      });
    }

    // Clean phone number
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

    // Format message if business format is requested
    let finalMessage = message;
    if (useBusinessFormat === 'true') {
      finalMessage = api.formatBusinessMessage(message, attendantName, location, schedule, link);
    }
    let result;

    if (messageType === 'template' && templateName) {
      // Send template message
      const templateParams = parameters ? parameters.split(',').map(p => p.trim()) : [];
      result = await api.sendTemplateMessage(channelId, cleanPhoneNumber, finalMessage, templateParams, organizationId);
    } else {
      // Send simple message
      console.log('Sending message with params:', {
        channelId,
        cleanPhoneNumber,
        finalMessage,
        organizationId
      });
      result = await api.sendMessage(channelId, cleanPhoneNumber, finalMessage, organizationId);
    }

    res.json({
      success: true,
      data: result,
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

// API endpoint to list channels
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

// API endpoint to create channel
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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp UTalk Bot Server running on http://localhost:${PORT}`);
  console.log('\n📋 Available endpoints:');
  console.log('   GET  /               - Web interface');
  console.log('   GET  /api/info       - Account information');
  console.log('   POST /api/send-message - Send WhatsApp message');
  console.log('   GET  /api/channels   - List channels');
  console.log('   POST /api/create-channel - Create new channel');
  console.log('\n📱 Configuration:');
  console.log(`   Organization ID: ${process.env.ORGANIZATION_ID || 'Not set'}`);
  console.log(`   Channel ID: ${process.env.CHANNEL_ID || 'Not set'}`);
  console.log('\n💡 Run "npm run setup" if configuration is missing');
});

module.exports = app;