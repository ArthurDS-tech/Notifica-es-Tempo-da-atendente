# Sistema de Análise de Webhooks - Detecção de Atendimento Humano

## Visão Geral

Este sistema foi desenvolvido para analisar webhooks de conversas e determinar se um cliente já foi atendido por um humano ou apenas por mensagens automáticas (bot). Quando detecta que um cliente não foi atendido por humano após o tempo limite, envia notificação direta para a gestora.

## Como Funciona

### 1. Recepção de Webhooks
- Todos os webhooks são recebidos no endpoint `/api/webhook/utalk`
- Cada webhook é analisado e adicionado ao histórico da conversa
- O sistema mantém um histórico dos últimos 50 eventos por conversa

### 2. Análise de Mensagens
O sistema classifica mensagens em duas categorias:

#### Mensagens Automáticas (Bot)
- "Olá! Bem-vindo ao nosso atendimento"
- "Digite 1 para vendas, 2 para suporte"
- "Como posso ajudar você?"
- "Menu principal: selecione uma opção"
- Mensagens com padrões numerados (1-, 2-, etc.)

#### Mensagens Humanas
- Qualquer mensagem que não corresponda aos padrões de bot
- Mensagens de atendentes com ID válido (exceto gestora)
- Respostas personalizadas e contextuais

### 3. Detecção de Atendimento
Para cada conversa, o sistema:
1. Monitora mensagens de entrada do cliente
2. Analisa todas as respostas subsequentes
3. Determina se houve atendimento humano real
4. Ignora mensagens automáticas na análise

### 4. Sistema de Alertas
Quando um cliente não é atendido por humano:
- Aguarda o tempo configurado (IDLE_MS)
- Verifica se está no horário comercial
- Envia notificação para a gestora (ID: aGevxChnIrrCytFy)
- Também envia backup para o chat de alertas

## Configuração

### Variáveis de Ambiente
```env
# ID da gestora para notificações
MANAGER_ID=aGevxChnIrrCytFy

# Tempo limite para considerar cliente não atendido (em ms)
IDLE_MS=900000  # 15 minutos

# Horário comercial
BUSINESS_START_HOUR=9
BUSINESS_END_HOUR=17

# Chat de backup para alertas
ALERT_CHAT_ID=aLrR-GU3ZQBaslwU
```

### Lista de Atendentes
O sistema reconhece os seguintes atendentes (definidos em `config/attendants.js`):

- Adrielli Saturnino (ZrzsX_BLm_zYqujY)
- Amanda Arruda (ZuGqFp5N9i3HAKOn)
- Ana Paula Gomes Lopes (ZqOw4cIS50M0IyW4)
- [... lista completa no arquivo attendants.js]

## Endpoints da API

### Webhook Principal
```
POST /api/webhook/utalk
```
Recebe todos os webhooks do UTalk e processa automaticamente.

### Debug e Monitoramento
```
GET /api/webhook/utalk/debug
```
Mostra estado atual de todas as conversas monitoradas.

### Forçar Verificação
```
POST /api/webhook/utalk/sweep
```
Força verificação imediata de alertas pendentes.

### Testes
```
POST /api/test/simulate-client-message
POST /api/test/simulate-attendant-reply
POST /api/test/notify-manager
```

## Scripts de Teste

### Executar Todos os Testes
```bash
npm run test:webhook:analyzer
```

### Testes Específicos
```bash
# Testar fluxo completo
npm run test:webhook:analyzer:flow

# Testar notificação da gestora
npm run test:webhook:analyzer:manager

# Testar detecção de bot
npm run test:webhook:analyzer:bot
```

## Fluxo de Funcionamento

### Cenário 1: Cliente Atendido por Bot Apenas
1. Cliente envia mensagem → Sistema inicia monitoramento
2. Bot responde automaticamente → Sistema identifica como automático
3. Cliente aguarda → Após tempo limite, gestora é notificada
4. Gestora recebe: "🚨 CLIENTE NÃO ATENDIDO"

### Cenário 2: Cliente Atendido por Humano
1. Cliente envia mensagem → Sistema inicia monitoramento
2. Bot responde automaticamente → Sistema identifica como automático
3. Atendente humano responde → Sistema identifica como humano
4. Monitoramento é cancelado → Nenhum alerta enviado

### Cenário 3: Gestora se Comunica
1. Gestora envia/recebe mensagens → Sistema ignora (ID especial)
2. Permite comunicação interna sem interferir no monitoramento
3. Foco apenas em atendimento real ao cliente

## Estrutura de Dados

### Estado da Conversa
```javascript
{
  lastInboundAt: timestamp,      // Última mensagem do cliente
  lastOutboundAt: timestamp,     // Última resposta humana
  alertedAt: timestamp,          // Quando foi enviado alerta
  meta: {
    conversationId: string,
    clientName: string,
    attendantId: string,
    attendantName: string,
    sector: string,
    link: string
  },
  webhookHistory: [              // Histórico de eventos
    {
      timestamp: number,
      direction: 'in'|'out',
      attendantId: string,
      attendantName: string,
      messageText: string,
      isBot: boolean
    }
  ]
}
```

### Formato da Notificação
```
🚨 CLIENTE NÃO ATENDIDO

👤 Cliente: João Silva
💬 Chat ID: CONV_123456
🧑💼 Último atendente: Sistema Automático
📍 Setor: Vendas
⏱️ Tempo aguardando: 20 minutos
🔗 Link: https://app-utalk.umbler.com/chats/CONV_123456
📅 Data/Hora: 15/01/2024 14:30:00

⚠️ Cliente ainda não recebeu atendimento humano após mensagens automáticas

_Notificação automática do sistema UTalk Bot_
```

## Monitoramento e Debug

### Verificar Estado das Conversas
```bash
curl -H "x-admin-token: YOUR_TOKEN" \
  http://localhost:3000/api/webhook/utalk/debug
```

### Forçar Verificação de Alertas
```bash
curl -X POST -H "x-admin-token: YOUR_TOKEN" \
  http://localhost:3000/api/webhook/utalk/sweep
```

### Logs Importantes
- `[CONV_ID] 📨 MENSAGEM DO CLIENTE - Analisando atendimento`
- `[CONV_ID] 🤖 MENSAGEM AUTOMÁTICA - Continua monitoramento`
- `[CONV_ID] 👤 RESPOSTA HUMANA - Cancelando timer`
- `[CONV_ID] ✅ Gestora notificada sobre cliente não atendido`

## Considerações Técnicas

### Performance
- Histórico limitado a 50 eventos por conversa
- Verificação automática a cada minuto
- Apenas durante horário comercial

### Confiabilidade
- Sistema de fallback para chat de alertas
- Múltiplas tentativas de envio de notificação
- Logs detalhados para debug

### Segurança
- Token de admin obrigatório para endpoints sensíveis
- Validação de dados de entrada
- Rate limiting implícito via UTalk API

## Troubleshooting

### Gestora Não Recebe Notificações
1. Verificar se MANAGER_ID está correto
2. Verificar se está no horário comercial
3. Verificar logs de erro na API
4. Testar com endpoint `/api/test/notify-manager`

### Detecção de Bot Incorreta
1. Verificar padrões em `isAutomaticMessage()`
2. Adicionar novos padrões se necessário
3. Testar com `/api/test/simulate-attendant-reply`

### Alertas Não Disparados
1. Verificar se IDLE_MS está configurado
2. Verificar horário comercial
3. Usar `/api/webhook/utalk/sweep` para forçar
4. Verificar estado com `/api/webhook/utalk/debug`