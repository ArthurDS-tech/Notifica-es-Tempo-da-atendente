# Deployment no Vercel - UTalk WhatsApp Bot

## 🚀 Deploy Rápido

1. **Fork/Clone este repositório**
2. **Conecte ao Vercel:**
   - Acesse [vercel.com](https://vercel.com)
   - Importe o projeto do GitHub
   - Configure as variáveis de ambiente

3. **Variáveis de Ambiente Obrigatórias:**
```env
UTALK_API_TOKEN=seu_token_bearer_aqui
UTALK_BASE_URL=https://app-utalk.umbler.com/api
ORGANIZATION_ID=seu_organization_id
CHANNEL_ID=seu_channel_id
BUSINESS_PHONE=seu_numero_whatsapp_business

# Configuração de Alertas
MANAGER_PHONE=5511999999999
IDLE_MS=900000
ADMIN_TOKEN=seu_token_admin_secreto

# Gestoras (opcional)
MANAGER1_ID=ZUpCF58LSKZvBvJr
MANAGER1_PHONE=5548988112957
MANAGER2_ID=ZZRSipl_JmIQx5qg  
MANAGER2_PHONE=5548996222357
```

## 🔧 Configuração do Webhook no UTalk

1. **Acesse o painel do UTalk:**
   - Vá para: `https://app-utalk.umbler.com/`
   - Navegue até configurações de webhook

2. **Configure o endpoint:**
   ```
   URL: https://seu-app.vercel.app/api/webhook/utalk
   Método: POST
   ```

## 🧪 Testando o Sistema

### 1. Verificar Status
```bash
GET https://seu-app.vercel.app/api/webhook/utalk/debug
Headers: X-Admin-Token: seu_token_admin
```

### 2. Simular Mensagem de Cliente
```bash
POST https://seu-app.vercel.app/api/test/simulate-client-message
{
  "conversationId": "TEST_123",
  "clientPhone": "5511999999999", 
  "clientName": "Cliente Teste",
  "sector": "Geral"
}
```

### 3. Forçar Verificação de Alertas
```bash
POST https://seu-app.vercel.app/api/webhook/utalk/sweep
Headers: X-Admin-Token: seu_token_admin
```

### 4. Teste Completo
```bash
POST https://seu-app.vercel.app/api/test/complete-flow
```

## 📊 Monitoramento

### Admin Dashboard
- Acesse: `https://seu-app.vercel.app/admin.html`
- Use o token admin para ver estatísticas e conversas

### Logs do Vercel
- Acesse o painel do Vercel
- Vá em "Functions" > "View Function Logs"
- Monitore os webhooks em tempo real

## 🔍 Troubleshooting

### Webhooks não chegam
1. Verifique se a URL está correta no UTalk
2. Confirme que o endpoint responde: `GET /api/webhook/utalk/debug`
3. Verifique logs no Vercel

### Alertas não são enviados
1. Confirme `MANAGER_PHONE` configurado
2. Verifique se está em horário comercial
3. Use `/api/test/complete-flow` para testar

### Erro de autenticação
1. Verifique `UTALK_API_TOKEN`
2. Confirme `ORGANIZATION_ID` e `CHANNEL_ID`
3. Teste com `/api/info`

## 📱 Fluxo de Funcionamento

1. **Cliente envia mensagem** → Webhook recebido → Timer de 15min iniciado
2. **Atendente responde** → Timer cancelado
3. **15min sem resposta** → Alerta enviado para gestor
4. **Apenas em horário comercial** (9h-17h, Seg-Sex)

## 🔐 Segurança

- Use `ADMIN_TOKEN` forte para endpoints administrativos
- Mantenha `UTALK_API_TOKEN` seguro
- Configure CORS se necessário
- Monitore logs regularmente

## 📞 Suporte

- Verifique logs no Vercel Dashboard
- Use endpoints de debug para troubleshooting
- Teste com simuladores antes de usar em produção