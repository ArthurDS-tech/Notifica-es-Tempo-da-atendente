const readline = require('readline');
const UTalkAPI = require('./config/api');
const fs = require('fs');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function setupUTalkBot() {
  console.log('=== WhatsApp UTalk Bot Setup ===\n');
  
  try {
    // Check if .env exists
    if (!fs.existsSync('.env')) {
      console.log('Creating .env file from template...');
      fs.copyFileSync('.env.example', '.env');
      console.log('✓ .env file created. Please edit it with your API credentials.\n');
    }

    const token = await question('Enter your UTalk API Bearer Token: ');
    const businessPhone = await question('Enter your business WhatsApp number (with country code, e.g., 5511999999999): ');
    
    // Initialize API with token
    process.env.UTALK_API_TOKEN = token;
    const api = new UTalkAPI();

    console.log('\n🔍 Getting your account information...');
    const userInfo = await api.getMe();
    console.log(`✓ Welcome, ${userInfo.name || 'User'}!`);
    
    const organizationId = userInfo.organization?.id || userInfo.organizationId;
    if (!organizationId) {
      throw new Error('Could not find organization ID in user data');
    }
    console.log(`✓ Organization ID: ${organizationId}`);

    // List existing channels
    console.log('\n📱 Checking existing channels...');
    const channels = await api.getChannels();
    
    if (channels.results && channels.results.length > 0) {
      console.log('Existing channels:');
      channels.results.forEach((channel, index) => {
        console.log(`  ${index + 1}. ${channel.name} (ID: ${channel.id}) - Status: ${channel.status || 'Unknown'}`);
      });

      const useExisting = await question('\nUse existing channel? (y/n): ');
      
      if (useExisting.toLowerCase() === 'y') {
        const channelIndex = await question('Enter channel number (1, 2, etc.): ');
        const selectedChannel = channels.results[parseInt(channelIndex) - 1];
        
        if (selectedChannel) {
          console.log(`✓ Using channel: ${selectedChannel.name} (${selectedChannel.id})`);
          
          // Update .env file
          updateEnvFile({
            UTALK_API_TOKEN: token,
            ORGANIZATION_ID: organizationId,
            CHANNEL_ID: selectedChannel.id,
            BUSINESS_PHONE: businessPhone
          });
          
          console.log('\n✅ Setup complete! Your credentials have been saved to .env');
          console.log('\nNext steps:');
          console.log('1. Run: npm run test    (to test message sending)');
          console.log('2. Run: npm start       (to start the web interface)');
          
          rl.close();
          return;
        }
      }
    }

    // Create new Business channel
    console.log('\n🆕 Creating new Business API channel...');
    const channelName = await question('Enter channel name (or press Enter for default): ') || 'WhatsApp Bot Channel';
    
    const newChannel = await api.createBusinessChannel(channelName, businessPhone, organizationId);
    console.log(`✓ Channel created: ${newChannel.name} (ID: ${newChannel.id})`);

    // Update .env file
    updateEnvFile({
      UTALK_API_TOKEN: token,
      ORGANIZATION_ID: organizationId,
      CHANNEL_ID: newChannel.id,
      BUSINESS_PHONE: businessPhone
    });

    console.log('\n📱 Business Channel Created!');
    console.log('Your Business API channel is ready to use.');
    console.log(`Phone Number: ${businessPhone}`);
    console.log('No QR code scanning required for Business API channels.');

    console.log('\n✅ Setup complete! Your credentials have been saved to .env');
    console.log('\nNext steps:');
    console.log('1. Run: npm run test    (to test message sending)');
    console.log('2. Run: npm start       (to start the web interface)');

  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    
    if (error.message.includes('Business API')) {
      console.log('\n💡 Trying Starter channel as fallback...');
      try {
        const channelName = 'WhatsApp Bot Channel (Starter)';
        const newChannel = await api.createStarterChannel(channelName, organizationId);
        console.log(`✓ Starter channel created: ${newChannel.name} (ID: ${newChannel.id})`);
        
        updateEnvFile({
          UTALK_API_TOKEN: token,
          ORGANIZATION_ID: organizationId,
          CHANNEL_ID: newChannel.id,
          BUSINESS_PHONE: businessPhone
        });
        
        console.log('\n📱 Starter Channel Setup:');
        console.log(`Visit: https://app-utalk.umbler.com/channels/${newChannel.id}/`);
        console.log('Scan the QR code with your WhatsApp (one-time setup)');
        
      } catch (fallbackError) {
        console.error('Fallback also failed:', fallbackError.message);
      }
    }
    
    console.log('\nTroubleshooting:');
    console.log('• Verify your API token is correct');
    console.log('• Check your internet connection');
    console.log('• Ensure your UTalk account is active');
    console.log('• For Business API, ensure your account has WhatsApp Business API access');
  }

  rl.close();
}

function updateEnvFile(values) {
  let envContent = fs.readFileSync('.env', 'utf8');
  
  Object.entries(values).forEach(([key, value]) => {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    const newLine = `${key}=${value}`;
    
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, newLine);
    } else {
      envContent += `\n${newLine}`;
    }
  });
  
  fs.writeFileSync('.env', envContent);
}

if (require.main === module) {
  setupUTalkBot().catch(console.error);
}

module.exports = { setupUTalkBot };