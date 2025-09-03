const readline = require('readline');
const UTalkAPI = require('./config/api');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

function validatePhoneNumber(phoneNumber) {
  // Remove any non-digit characters
  const cleanNumber = phoneNumber.replace(/\D/g, '');
  
  // Check if it's a valid international format (country code + number)
  // Must be between 8-15 digits and start with country code
  if (cleanNumber.length < 8 || cleanNumber.length > 15) {
    return null;
  }
  
  // Ensure it doesn't start with 0 (invalid for international format)
  if (cleanNumber.startsWith('0')) {
    return null;
  }
  
  return cleanNumber;
}

async function sendTestMessage() {
  console.log('=== WhatsApp UTalk Message Sender ===\n');

  try {
    // Initialize API
    const api = new UTalkAPI();
    
    // Get configuration
    const organizationId = process.env.ORGANIZATION_ID;
    const channelId = process.env.CHANNEL_ID;
    const businessPhone = process.env.BUSINESS_PHONE;

    if (!organizationId || !channelId) {
      throw new Error('Missing ORGANIZATION_ID or CHANNEL_ID in .env file. Run: npm run setup');
    }

    console.log('📋 Current Configuration:');
    console.log(`   Organization ID: ${organizationId}`);
    console.log(`   Channel ID: ${channelId}`);
    console.log(`   Business Phone: ${businessPhone || 'Not set'}`);

    // Get channel status
    console.log('\n🔍 Checking channel status...');
    try {
      const channelStatus = await api.getChannelStatus(channelId);
      console.log(`✓ Channel: ${channelStatus.name} - Status: ${channelStatus.status || 'Active'}`);

      if (channelStatus.status === 'disconnected' || channelStatus.status === 'pending') {
        console.log('\n⚠️  Warning: Channel appears to be disconnected!');
        console.log('Please ensure your WhatsApp is properly connected to this channel.');
        console.log(`Visit: https://app-utalk.umbler.com/channels/${channelId}/`);
        
        const proceed = await question('\nProceed anyway? (y/n): ');
        if (proceed.toLowerCase() !== 'y') {
          console.log('Message sending cancelled.');
          rl.close();
          return;
        }
      }
    } catch (statusError) {
      console.log('⚠️  Could not check channel status, proceeding anyway...');
    }

    // Get recipient number
    const defaultNumber = process.env.DEFAULT_TEST_NUMBER || businessPhone || '';
    const phonePrompt = defaultNumber 
      ? `Enter recipient phone number (default: ${defaultNumber}): `
      : 'Enter recipient phone number (with country code, e.g., 554899895903): ';
    
    let phoneInput = await question(phonePrompt);
    if (!phoneInput && defaultNumber) {
      phoneInput = defaultNumber;
    }

    const phoneNumber = validatePhoneNumber(phoneInput);
    if (!phoneNumber) {
      throw new Error('Invalid phone number format. Use country code + number (e.g., 554899895903)');
    }

    // Ask for message format
    console.log('\n📝 Choose message format:');
    console.log('1. Simple message');
    console.log('2. Formato profissional (com atendente, local, horário, link)');
    
    const formatChoice = await question('Choose format (1/2): ');
    
    let message;
    let finalMessage;
    
    if (formatChoice === '2') {
      // Professional format
      message = await question('Enter base message: ');
      const attendantName = await question('Nome do atendente: ');
      const location = await question('Local (cidade/estado): ');
      const schedule = await question('Horário de funcionamento: ');
      const link = await question('Link (site/WhatsApp/opcional): ');
      
      finalMessage = api.formatBusinessMessage(message, attendantName, location, schedule, link || null);
      
      console.log('\n📋 Mensagem formatada:');
      console.log('─'.repeat(50));
      console.log(finalMessage);
      console.log('─'.repeat(50));
      
      const confirm = await question('\nConfirmar envio desta mensagem? (y/n): ');
      if (confirm.toLowerCase() !== 'y') {
        console.log('Envio cancelado.');
        rl.close();
        return;
      }
    } else {
      // Simple message
      finalMessage = await question('Enter your message: ');
    }
    
    if (!finalMessage.trim()) {
      throw new Error('Message cannot be empty');
    }

    // Ask for message type
    const messageType = await question('Send as (1) Simple message or (2) Template message? (1/2): ');

    console.log('\n📤 Sending message...');
    console.log(`   To: +${phoneNumber}`);
    console.log(`   Message: ${finalMessage.substring(0, 100)}${finalMessage.length > 100 ? '...' : ''}`);
    console.log(`   Type: ${messageType === '2' ? 'Template' : 'Simple'}`);

    let result;

    if (messageType === '2') {
      // Template message
      const templateName = await question('Enter template name: ');
      const parametersInput = await question('Enter parameters (comma-separated, or press Enter for none): ');
      const parameters = parametersInput ? parametersInput.split(',').map(p => p.trim()) : [];

      result = await api.sendTemplateMessage(channelId, phoneNumber, templateName, parameters, organizationId);
      console.log('✅ Template message sent successfully!');
    } else {
      // Simple message
      result = await api.sendMessage(channelId, phoneNumber, finalMessage, organizationId);
      console.log('✅ Message sent successfully!');
    }

    console.log('\n📊 Response Details:');
    console.log(JSON.stringify(result, null, 2));

    // Ask if user wants to send another message
    const sendAnother = await question('\nSend another message? (y/n): ');
    if (sendAnother.toLowerCase() === 'y') {
      rl.close();
      // Restart the process
      setTimeout(() => sendTestMessage(), 100);
      return;
    }

  } catch (error) {
    console.error('\n❌ Failed to send message:', error.message);
    
    if (error.message.includes('401') || error.message.includes('Unauthorized')) {
      console.log('\n🔧 Troubleshooting:');
      console.log('• Check if your API token is correct and active');
      console.log('• Run: npm run setup (to reconfigure)');
    } else if (error.message.includes('404') || error.message.includes('Not Found')) {
      console.log('\n🔧 Troubleshooting:');
      console.log('• Verify your channel ID exists');
      console.log('• Check if the channel was deleted');
      console.log('• Run: npm run setup (to create a new channel)');
    } else if (error.message.includes('429') || error.message.includes('Rate Limit')) {
      console.log('\n🔧 Rate Limit Information:');
      console.log('• UTalk API has rate limits (typically 100 requests per 5 seconds)');
      console.log('• Wait a few seconds before trying again');
    } else if (error.message.includes('Business API')) {
      console.log('\n🔧 Business API Information:');
      console.log('• Business API channels require WhatsApp Business API approval');
      console.log('• Contact Umbler support for Business API access');
      console.log('• Alternatively, use Starter channels with QR code setup');
    }
  }

  rl.close();
}

if (require.main === module) {
  sendTestMessage().catch(console.error);
}

module.exports = { sendTestMessage };