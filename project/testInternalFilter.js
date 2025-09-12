#!/usr/bin/env node

// Teste para verificar filtro de conversas internas
const testCases = [
  // Casos que DEVEM ser filtrados (não gerar alerta)
  { name: 'Processos Desp Laís', sector: 'Processos Desp Laís / AutoFacil', shouldFilter: true },
  { name: 'Auto Fácil', sector: 'Auto Fácil / Auto Vistoria - São José', shouldFilter: true },
  { name: 'Particular Floripa', sector: 'Particular Florianópolis 🚙', shouldFilter: true },
  { name: 'Equipe São José', sector: 'Equipe Particular São José 🚍', shouldFilter: true },
  { name: 'Grupos', sector: '🐨 Grupos', shouldFilter: true },
  { name: 'Interno', sector: '🤍 Interno', shouldFilter: true },
  { name: 'Lojas', sector: 'lojas', shouldFilter: true },
  { name: 'Cliente com emoji', fromName: 'João Silva 🚙', shouldFilter: true },
  { name: 'Atendente interno', fromName: 'Equipe Particular', shouldFilter: true },
  
  // Casos que NÃO devem ser filtrados (gerar alerta normal)
  { name: 'Cliente normal', sector: 'Vendas', fromName: 'Maria Santos', shouldFilter: false },
  { name: 'Suporte', sector: 'Suporte Técnico', fromName: 'Pedro Costa', shouldFilter: false },
  { name: 'Atendimento', sector: 'Atendimento Geral', fromName: 'Ana Silva', shouldFilter: false }
];

// Replica a lógica de detecção
const INTERNAL_TAGS = [
  'interno', 'internal', 'staff', 'equipe', 'atendente',
  'processos desp laís', 'autofacil', 'auto facil', 'auto fácil',
  'particular florianópolis', 'auto vistoria', 'são josé',
  'equipe particular são josé', 'grupos', 'lojas'
];

const INTERNAL_EMOJIS = ['🚙', '🚍', '🐨', '🤍'];

function isInternalConversation(sector, fromName, tags = []) {
  const tagNames = tags.map(tag => (tag.Name || tag.name || '').toLowerCase());
  const sectorName = (sector || '').toLowerCase();
  const contactName = (fromName || '').toLowerCase();
  
  return tagNames.some(tag => INTERNAL_TAGS.some(internal => tag.includes(internal))) ||
         INTERNAL_TAGS.some(internal => sectorName.includes(internal)) ||
         INTERNAL_TAGS.some(internal => contactName.includes(internal)) ||
         INTERNAL_EMOJIS.some(emoji => sectorName.includes(emoji) || contactName.includes(emoji));
}

console.log('🧪 TESTANDO FILTRO DE CONVERSAS INTERNAS\n');
console.log('=' .repeat(80));

let passed = 0;
let failed = 0;

testCases.forEach((test, index) => {
  const result = isInternalConversation(test.sector, test.fromName, test.tags);
  const status = result === test.shouldFilter ? '✅' : '❌';
  
  if (result === test.shouldFilter) {
    passed++;
  } else {
    failed++;
  }
  
  console.log(`${index + 1}. ${status} ${test.name}`);
  console.log(`   Setor: "${test.sector || 'N/A'}"`);
  console.log(`   Nome: "${test.fromName || 'N/A'}"`);
  console.log(`   Filtrado: ${result} (esperado: ${test.shouldFilter})`);
  console.log(`   Ação: ${result ? '🚫 NÃO GERA ALERTA' : '🚨 GERA ALERTA'}`);
  console.log('');
});

console.log('=' .repeat(80));
console.log(`📊 RESULTADO: ${passed} passou, ${failed} falhou`);

if (failed === 0) {
  console.log('🎉 TODOS OS TESTES PASSARAM!');
  console.log('✅ Filtro de conversas internas funcionando corretamente');
} else {
  console.log('⚠️ Alguns testes falharam - revisar lógica de filtro');
}

console.log('\n📋 RESUMO DAS REGRAS:');
console.log('🚫 Conversas que NÃO geram alerta:');
INTERNAL_TAGS.forEach(tag => console.log(`   - ${tag}`));
console.log('🚫 Emojis que indicam grupos internos:');
INTERNAL_EMOJIS.forEach(emoji => console.log(`   - ${emoji}`));

module.exports = { isInternalConversation, testCases };