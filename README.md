# Samuel Frutas — Coletor de Pedidos

Projeto independente para validar duas coisas antes do sistema completo:

1. identificar chats arquivados/desarquivados pelo Baileys;
2. depois, em uma segunda etapa, ler as mensagens dos chats desarquivados.

## Teste 1 atual

O servidor mantém os chats recebidos pelo WhatsApp e expõe somente os chats com `archived !== true` em `/api/chats`.

A interface mostra apenas as conversas desarquivadas.

## Rodar localmente

Requer Node.js 20+.

```bash
npm install
npm start
```

Abra http://localhost:3000.

Na primeira execução, o QR será exibido no terminal. Conecte o WhatsApp em Dispositivos conectados.

## Teste manual obrigatório

1. Deixe 2 ou 3 conversas desarquivadas.
2. Deixe outra conversa arquivada.
3. Abra a interface.
4. Confirme que somente as desarquivadas aparecem.
5. Arquive uma conversa no WhatsApp e clique em Atualizar.
6. Desarquive a mesma conversa e clique em Atualizar.
7. Confirme se ela some e volta.

Não avançar para interpretação de pedidos antes de este teste passar na conta real.
