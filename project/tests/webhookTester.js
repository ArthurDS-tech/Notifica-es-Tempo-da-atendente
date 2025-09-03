const axios = require('axios');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function buildUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

async function post(baseUrl, path, payload) {
  const url = buildUrl(baseUrl, path);
  const res = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
  return res.data;
}

function makeInbound({ conversationId, fromPhone, fromName }) {
  return {
    type: 'message-in',
    direction: 'in',
    message: {
      conversationId,
      direction: 'in',
      from: { phone: fromPhone, name: fromName },
      text: 'Olá, preciso de ajuda.'
    }
  };
}

function makeOutbound({ conversationId, attendantId, text = 'Olá, posso ajudar.' }) {
  return {
    type: 'message-out',
    direction: 'out',
    message: {
      conversationId,
      direction: 'out',
      attendantId,
      text
    }
  };
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('baseUrl', { type: 'string', demandOption: true, desc: 'Base URL, e.g., https://<ngrok>.ngrok.io' })
    .option('conversationId', { type: 'string', default: 'TEST_CONV_1' })
    .option('fromPhone', { type: 'string', default: '5511999999999' })
    .option('fromName', { type: 'string', default: 'Cliente Teste' })
    .option('attendantId', { type: 'string', default: 'aGevxChnIrrCytFy' })
    .option('scenario', { type: 'string', default: 'idle', choices: ['idle', 'reply', 'multi-attendants'] })
    .option('idleMs', { type: 'number', default: 10_000, desc: 'Override server IDLE_MS before running (ms)' })
    .help()
    .argv;

  console.log('Testing webhook on', argv.baseUrl);

  // Show debug state
  try {
    const debug1 = await axios.get(buildUrl(argv.baseUrl, '/api/webhook/utalk/debug')).then(r => r.data);
    console.log('Initial debug:', debug1);
  } catch (e) {
    console.log('Debug fetch failed (ok if endpoint not public):', e.message);
  }

  if (argv.idleMs) {
    console.log('Note: set server env IDLE_MS to', argv.idleMs, 'to speed up idle tests.');
  }

  if (argv.scenario === 'idle') {
    // Inbound, wait (expect manager alert from server after IDLE_MS)
    console.log('Sending inbound (client message) ...');
    await post(argv.baseUrl, '/api/webhook/utalk', makeInbound(argv));
    console.log('Await idle period on server...');
  }

  if (argv.scenario === 'reply') {
    // Inbound, then outbound (should cancel timer)
    console.log('Sending inbound (client message) ...');
    await post(argv.baseUrl, '/api/webhook/utalk', makeInbound(argv));
    console.log('Sending outbound (attendant reply) ...');
    await post(argv.baseUrl, '/api/webhook/utalk', makeOutbound(argv));
  }

  if (argv.scenario === 'multi-attendants') {
    // Only outbound from multiple attendants (should not schedule timer)
    console.log('Sending outbound from attendant A ...');
    await post(argv.baseUrl, '/api/webhook/utalk', makeOutbound({ ...argv, attendantId: argv.attendantId, text: 'Atendente A respondendo' }));
    console.log('Sending outbound from attendant B ...');
    await post(argv.baseUrl, '/api/webhook/utalk', makeOutbound({ ...argv, attendantId: 'ZUqcbp8LSKZvEHKO', text: 'Atendente B respondendo' }));
  }

  await sleep(1000);
  try {
    const debug2 = await axios.get(buildUrl(argv.baseUrl, '/api/webhook/utalk/debug')).then(r => r.data);
    console.log('Final debug:', debug2);
  } catch (e) {
    console.log('Final debug fetch failed:', e.message);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
