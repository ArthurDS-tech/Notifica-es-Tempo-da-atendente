# 🚀 Deploy no Vercel - Guia Completo

## 📋 Pré-requisitos

1. **Conta no Vercel**: https://vercel.com
2. **Vercel CLI** (opcional): `npm i -g vercel`
3. **Repositório Git** com o código

## 🔧 Configuração no Vercel

### 1. **Variáveis de Ambiente**
No painel do Vercel, adicione estas variáveis:

```env
UTALK_API_TOKEN=Paola-2025-09-04-2093-09-22--863E9A388D8D4E39BF70412BF55805A36647192A1CA9604329A7BED17DA9E620
UTALK_BASE_URL=https://app-utalk.umbler.com/api
ORGANIZATION_ID=ZQG4wFMHGHuTs59F
CHANNEL_ID=ZUpCF58LSKZvBvJr
BUSINESS_PHONE=5548988112957
MANAGER_PHONE=5548988112957
MANAGER_ID=aLrR-GU3ZQBaslwU
IDLE_MS=900000
BUSINESS_START_HOUR=8
BUSINESS_END_HOUR=18
ADMIN_TOKEN=DESP102030
WEBHOOK_DEBUG=false
NODE_ENV=production
```

### 2. **Configurações do Projeto**
- **Framework Preset**: Other
- **Build Command**: `echo "No build needed"`
- **Output Directory**: (deixe vazio)
- **Install Command**: `npm install`

## 📡 Endpoints Disponíveis

Após o deploy, você terá:

### **Webhook Principal**
```
POST https://seu-projeto.vercel.app/api/webhook/utalk
```
- Recebe webhooks do Umbler Talk
- Processa automaticamente
- Resposta < 5 segundos

### **Debug**
```
GET https://seu-projeto.vercel.app/api/debug?token=DESP102030
```
- Mostra conversas monitoradas
- Status do sistema

### **Teste de Alerta**
```
POST https://seu-projeto.vercel.app/api/test/send-alert
Content-Type: application/json

{
  "clientName": "João Silva",
  "attendantName": "Adrielli Saturnino",
  "sector": "Vendas",
  "idleMinutes": 20
}
```

## 🔄 Processo de Deploy

### **Opção 1: Via Interface Web**
1. Acesse https://vercel.com/dashboard
2. Clique em "New Project"
3. Conecte seu repositório GitHub
4. Configure as variáveis de ambiente
5. Deploy!

### **Opção 2: Via CLI**
```bash
# Instalar Vercel CLI
npm i -g vercel

# Fazer login
vercel login

# Deploy
vercel --prod
```

## ⚙️ Configuração no Umbler Talk

Após o deploy, configure o webhook no Umbler:

1. **URL do Webhook**: `https://seu-projeto.vercel.app/api/webhook/utalk`
2. **Eventos**: Marque "Message"
3. **Método**: POST
4. **Headers**: Content-Type: application/json

## 🧪 Testando o Deploy

### **1. Teste Básico**
```bash
curl https://seu-projeto.vercel.app/api/debug?token=DESP102030
```

### **2. Teste de Alerta**
```bash
curl -X POST https://seu-projeto.vercel.app/api/test/send-alert \
  -H "Content-Type: application/json" \
  -d '{"clientName":"Teste Vercel","sector":"Deploy"}'
```

### **3. Teste de Webhook**
```bash
curl -X POST https://seu-projeto.vercel.app/api/webhook/utalk \
  -H "Content-Type: application/json" \
  -d '{
    "Type": "Message",
    "EventId": "TEST123",
    "EventDate": "2024-01-15T14:30:00Z",
    "Payload": {
      "Type": "Chat",
      "Content": {
        "Id": "test-chat",
        "Contact": {
          "Name": "Cliente Teste",
          "PhoneNumber": "5548999887766"
        },
        "LastMessage": {
          "Source": "Contact",
          "Content": "Olá, preciso de ajuda!"
        }
      }
    }
  }'
```

## 📊 Monitoramento

### **Logs do Vercel**
- Acesse o painel do Vercel
- Vá em "Functions" > "View Function Logs"
- Monitore execuções em tempo real

### **Métricas**
- **Invocations**: Quantas vezes foi chamado
- **Duration**: Tempo de execução
- **Errors**: Erros ocorridos

## ⚠️ Limitações do Vercel

### **Serverless Functions**
- **Timeout**: 10 segundos máximo
- **Memória**: Limitada por plano
- **Storage**: Não persistente entre execuções
- **Cold Start**: Primeira execução pode ser mais lenta

### **Workarounds Implementados**
- ✅ **Storage Global**: Usa `global.conversations`
- ✅ **Resposta Rápida**: < 5 segundos sempre
- ✅ **Processamento Assíncrono**: Não bloqueia resposta
- ✅ **Retry Automático**: Para webhooks terceiros

## 🔧 Troubleshooting

### **Erro 500**
- Verifique variáveis de ambiente
- Veja logs no painel Vercel

### **Webhook não recebe**
- Confirme URL no Umbler
- Teste com curl manual

### **Alertas não enviam**
- Verifique MANAGER_PHONE
- Teste endpoint /api/test/send-alert

### **Timeout**
- Função executa em < 10s
- Resposta sempre < 5s

## 📱 URLs Finais

Substitua `seu-projeto` pelo nome real:

- **Webhook**: `https://seu-projeto.vercel.app/api/webhook/utalk`
- **Debug**: `https://seu-projeto.vercel.app/api/debug?token=DESP102030`
- **Teste**: `https://seu-projeto.vercel.app/api/test/send-alert`

## ✅ Checklist de Deploy

- [ ] Variáveis de ambiente configuradas
- [ ] Webhook URL configurada no Umbler
- [ ] Teste de alerta funcionando
- [ ] Debug endpoint acessível
- [ ] Logs sem erros
- [ ] WhatsApp recebendo mensagens

🎉 **Sistema pronto para produção no Vercel!**