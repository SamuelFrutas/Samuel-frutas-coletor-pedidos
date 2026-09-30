# Samuel Frutas — Coletor de Pedidos

## Etapa 2 — Conexão do WhatsApp

A segunda etapa adiciona conexão real via Baileys, QR Code exibido na interface, estado de conexão, reconexão automática e persistência local da sessão em `.baileys_auth/`.

Projeto independente para validar duas coisas antes do sistema completo:

1. identificar chats arquivados/desarquivados pelo Baileys;
2. depois, em uma segunda etapa, ler as mensagens dos chats desarquivados.

## Etapa 4 — Leitura de mensagens

O servidor agora também recebe `messages.upsert` e mensagens do histórico. As mensagens são mantidas por conversa, com limite de 100 por chat. A API de mensagens só libera leitura para conversas desarquivadas.

Endpoints principais:

- `/api/chats` — conversas desarquivadas.
- `/api/chats/all` — todas as conversas capturadas.
- `/api/chats/stats` — quantidade total, desarquivadas e arquivadas.
- `/api/chats/:jid/messages` — últimas mensagens capturadas da conversa desarquivada.
- `/api/whatsapp/status` — estado da conexão.

A interface mostra as conversas desarquivadas com nome, JID e quantidade de mensagens não lidas.

## Rodar localmente

Requer Node.js 20+.

```bash
npm install
npm start
```

Abra http://localhost:3000.

Na primeira execução, o QR será exibido no terminal. Conecte o WhatsApp em Dispositivos conectados.

## Teste manual obrigatório — Etapa 4

1. Deixe 2 ou 3 conversas desarquivadas.
2. Deixe outra conversa arquivada.
3. Abra a interface.
4. Confirme que somente as desarquivadas aparecem.
5. Arquive uma conversa no WhatsApp e clique em Atualizar.
6. Desarquive a mesma conversa e clique em Atualizar.
7. Confirme se ela some e volta.

Não avançar para interpretação de pedidos antes de este teste passar na conta real.


### Validação da Etapa 4

Não avançar para interpretação de pedidos. Primeiro confirmar que uma conversa desarquivada mostra mensagens reais e que uma conversa arquivada não permite leitura pela API.
