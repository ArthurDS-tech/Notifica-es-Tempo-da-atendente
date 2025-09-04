const axios = require('axios');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

async function post(baseUrl, path, payload, headers = {}) {
  const url = buildUrl(baseUrl, path);
  const res = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json', ...headers } });
  return res.data;
}

async function get(baseUrl, path, headers = {}) {
  const url = buildUrl(baseUrl, path);
  const res = await axios.get(url, { headers });
  return res.data;
}

function makeInboundWithSector({ conversationId, phone, name, sector }) {
  return {
    Type: 'Message',
    Payload: {
      Type: 'Chat',
      Content: {
        Contact: { PhoneNumber: phone, Name: name, Id: 'CONTACT_VERIFY' },
        LastMessage: { Source: 'Contact', Chat: { Id: conversationId } },
        Id: conversationId
      }
    },
    Sector: sector
  };
}

async function main() {
  const baseUrl = process.env.BASE_URL;
  const adminToken = process.env.ADMIN_TOKEN;
  const sector = process.env.SECTOR || 'Geral';
  const conversationId = process.env.CONVERSATION_ID || `VERIFY_${Date.now()}`;
  const phone = process.env.CLIENT_PHONE || '5511999999999';
  const name = process.env.CLIENT_NAME || 'Cliente Verificacao';
  const waitMs = Number(process.env.WAIT_MS || 65000);

  if (!baseUrl) {
    console.error('Missing BASE_URL env. Example: BASE_URL=https://<your-app>.vercel.app');
    process.exit(1);
  }
  if (!adminToken) {
    console.error('Missing ADMIN_TOKEN env. Provide the same token configured on the server.');
    process.exit(1);
  }

  console.log('--- Verify Alerts Start ---');
  console.log('Base URL:', baseUrl);
  console.log('Sector:', sector);
  console.log('Conversation:', conversationId);

  try {
    // 1) Send inbound to arm timer
    console.log('Posting inbound (client message) ...');
    await post(baseUrl, '/api/webhook/utalk', makeInboundWithSector({ conversationId, phone, name, sector }));

    // 2) Wait for idle window (assumes IDLE_MS ~ 60s in env for quick verify)
    console.log('Waiting', waitMs, 'ms for idle period ...');
    await sleep(waitMs);

    // 3) Force sweep (required on serverless)
    console.log('Triggering sweep ...');
    await post(baseUrl, '/api/webhook/utalk/sweep', {}, { 'X-Admin-Token': adminToken });

    // 4) Fetch debug and print relevant fields
    console.log('Fetching debug ...');
    const debug = await get(baseUrl, '/api/webhook/utalk/debug', { 'X-Admin-Token': adminToken });
    const conv = (debug.conversations || []).find(c => c.key === conversationId || (c.key && String(c.key).includes(conversationId)));
    console.log('Conversations entry:', conv || 'not-found');
    console.log('Stats totalAlertsSent:', debug.stats && debug.stats.totalAlertsSent);
    console.log('Stats byManager:', debug.stats && debug.stats.byManager);
    console.log('Recent skips (if any):', debug.recentSkips || []);

    console.log('--- Verify Alerts Done ---');
    process.exit(0);
  } catch (e) {
    console.error('Verification failed:', e.response?.data || e.message);
    process.exit(1);
  }
}

main();


