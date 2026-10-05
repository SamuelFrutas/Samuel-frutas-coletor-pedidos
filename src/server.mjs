import express from 'express'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} from 'baileys'
import P from 'pino'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import QRCode from 'qrcode'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const port = Number(process.env.PORT || 3000)
const logger = P({ level: process.env.LOG_LEVEL || 'info' })

const chats = new Map()
const messagesByChat = new Map()
const lidToPn = new Map()
const contactNames = new Map()
const MAX_MESSAGES_PER_CHAT = 100

let sock = null
let connection = 'close'
let latestQr = null
let reconnecting = false
let connectionError = null
let lastConnectedAt = null

function upsertChats(items = []) {
  for (const chat of items) {
    if (!chat?.id) continue
    const previous = chats.get(chat.id) || {}
    chats.set(chat.id, { ...previous, ...chat })
  }
}

function updateChats(items = []) {
  for (const update of items) {
    if (!update?.id) continue
    const previous = chats.get(update.id) || { id: update.id }
    chats.set(update.id, { ...previous, ...update })
  }
}

function upsertMessages(items = []) {
  for (const message of items) {
    const key = message?.key?.remoteJid
    if (!key || !message?.key?.id) continue
    const list = messagesByChat.get(key) || []
    if (list.some(item => item.key?.id === message.key.id)) continue
    list.push(message)
    list.sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0))
    messagesByChat.set(key, list.slice(-MAX_MESSAGES_PER_CHAT))
  }
}

function isArchived(chat) {
  return chat?.archived === true || chat?.archived === 1
}

function canonicalJid(jid) {
  return lidToPn.get(jid) || jid
}

function rememberContactName(contact = {}) {
  const name = String(contact?.name || '').trim()
  if (!name) return
  for (const id of [contact?.id, contact?.phoneNumber, contact?.lid].filter(Boolean)) {
    contactNames.set(id, name)
    contactNames.set(canonicalJid(id), name)
  }
}

function chatDisplayName(chat) {
  const saved = contactNames.get(chat?.id) || contactNames.get(canonicalJid(chat?.id))
  return saved || chat?.name || chat?.pushName || chat?.notify || chat?.verifiedName || chat?.username || chat?.id || null
}

function mergeChatIdentity(lid, pn) {
  if (!lid || !pn || lid === pn) return
  lidToPn.set(lid, pn)
  const lidChat = chats.get(lid)
  const pnChat = chats.get(pn)
  if (lidChat) {
    chats.set(pn, { ...lidChat, ...pnChat, id: pn })
    chats.delete(lid)
  }
  const lidMessages = messagesByChat.get(lid)
  if (lidMessages?.length) {
    const pnMessages = messagesByChat.get(pn) || []
    const merged = new Map()
    for (const message of [...pnMessages, ...lidMessages]) {
      const id = message?.key?.id
      if (id) merged.set(id, message)
    }
    messagesByChat.set(pn, [...merged.values()].sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0)).slice(-MAX_MESSAGES_PER_CHAT))
    messagesByChat.delete(lid)
  }
}

function applyHistoryMappings(mappings = []) {
  for (const mapping of mappings) {
    if (mapping?.lid && mapping?.pn) mergeChatIdentity(mapping.lid, mapping.pn)
  }
}

function canonicalChats() {
  const groups = new Map()
  for (const chat of chats.values()) {
    const key = canonicalJid(chat.id)
    const previous = groups.get(key)
    if (!previous) {
      groups.set(key, { ...chat, id: key })
      continue
    }
    groups.set(key, {
      ...previous,
      ...chat,
      id: key,
      conversationTimestamp: Math.max(Number(previous.conversationTimestamp || 0), Number(chat.conversationTimestamp || 0))
    })
  }
  return [...groups.values()]
}

function publicChat(chat) {
  return {
    id: chat.id,
    name: chatDisplayName(chat),
    jid: chat.id,
    archived: isArchived(chat),
    unreadCount: chat.unreadCount || 0,
    conversationTimestamp: chat.conversationTimestamp || null,
    lastMessageRecvTimestamp: chat.lastMessageRecvTimestamp || null,
    pinned: Boolean(chat.pinned),
    muteEndTime: chat.muteEndTime || null,
    readOnly: Boolean(chat.readOnly)
  }
}

async function startWhatsApp() {
  if (reconnecting) return
  reconnecting = true
  try {
    const { state, saveCreds } = await useMultiFileAuthState('.baileys_auth')
    const { version } = await fetchLatestBaileysVersion()
    sock = makeWASocket({
      version,
      logger,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      shouldSyncHistoryMessage: () => true
    })
    sock.ev.on('creds.update', saveCreds)
    sock.ev.process(async events => {
      if (events['connection.update']) {
        const { connection: nextConnection, lastDisconnect, qr } = events['connection.update']
        connection = nextConnection
        if (lastDisconnect?.error) connectionError = lastDisconnect.error?.message || String(lastDisconnect.error)
        if (qr) {
          latestQr = qr
          qrcode.generate(qr, { small: true })
        }
        if (nextConnection === 'open') {
          latestQr = null
          connectionError = null
          lastConnectedAt = new Date().toISOString()
        }
        if (nextConnection === 'close') {
          latestQr = null
          const loggedOut = lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output?.statusCode === DisconnectReason.loggedOut
            : false
          if (!loggedOut) setTimeout(() => {
            reconnecting = false
            startWhatsApp().catch(err => logger.error(err))
          }, 3000)
        }
      }

      if (events['messaging-history.set']) {
        const { chats: historyChats, messages: historyMessages, contacts: historyContacts, lidPnMappings, isLatest, syncType, progress } = events['messaging-history.set']
        applyHistoryMappings(lidPnMappings)
        for (const contact of historyContacts || []) {
          rememberContactName(contact)
          if (contact?.lid && contact?.id?.endsWith('@s.whatsapp.net')) mergeChatIdentity(contact.lid, contact.id)
        }
        if (isLatest || (chats.size === 0 && syncType === 0 && historyChats?.length)) upsertChats(historyChats)
        upsertMessages(historyMessages)
        logger.info({ chats: historyChats?.length || 0, messages: historyMessages?.length || 0, mappings: lidPnMappings?.length || 0, contacts: historyContacts?.length || 0, isLatest, syncType, progress, storedChats: chats.size, canonicalChats: canonicalChats().length }, 'histórico recebido')
      }
      if (!events['messaging-history.set'] && events['chats.upsert']) upsertChats(events['chats.upsert'])
      if (events['chats.update']) updateChats(events['chats.update'])
      if (events['chats.delete']) for (const id of events['chats.delete']) chats.delete(id)
      if (events['messages.upsert']) upsertMessages(events['messages.upsert'].messages)
      if (events['lid-mapping.update']) mergeChatIdentity(events['lid-mapping.update'].lid, events['lid-mapping.update'].pn)
      if (events['contacts.upsert']) for (const contact of events['contacts.upsert']) {
        rememberContactName(contact)
        if (contact?.lid && contact?.id?.endsWith('@s.whatsapp.net')) mergeChatIdentity(contact.lid, contact.id)
      }
    })
    logger.info('etapa 4 iniciada: aguardando captura de mensagens')
  } finally {
    reconnecting = false
  }
}

app.use(express.static(path.join(__dirname, '..', 'public')))
app.get('/api/whatsapp/status', (_req, res) => res.json({ connection, connected: connection === 'open', qrPending: Boolean(latestQr), lastConnectedAt, error: connectionError }))
app.post('/api/whatsapp/connect', async (_req, res) => {
  if (connection === 'open') return res.json({ ok: true, connected: true, message: 'WhatsApp já está conectado.' })
  latestQr = null
  connectionError = null
  startWhatsApp().catch(err => logger.error(err))
  res.json({ ok: true, connected: false, message: 'Solicitação de conexão iniciada. Aguarde o QR Code.' })
})
app.get('/api/whatsapp/qr', async (_req, res) => {
  if (!latestQr) return res.status(404).json({ qrPending: false, message: 'QR não disponível.' })
  res.json({ qrPending: true, dataUrl: await QRCode.toDataURL(latestQr, { margin: 2, width: 320 }) })
})
app.get('/api/status', (_req, res) => {
  const all = canonicalChats(), active = all.filter(c => !isArchived(c)), archived = all.filter(c => isArchived(c))
  res.json({ connection, totalChats: all.length, activeChats: active.length, archivedChats: archived.length, qrPending: Boolean(latestQr) })
})
app.get('/api/chats', (_req, res) => res.json(canonicalChats().filter(c => !isArchived(c)).sort((a, b) => Number(b.conversationTimestamp || 0) - Number(a.conversationTimestamp || 0)).map(publicChat)))
app.get('/api/chats/all', (_req, res) => res.json(canonicalChats().sort((a, b) => Number(isArchived(a)) - Number(isArchived(b))).map(publicChat)))

function toPublicMessage(message) {
  return {
    id: message.key?.id || null,
    fromMe: Boolean(message.key?.fromMe),
    sender: message.pushName || message.key?.participant || message.key?.remoteJid || null,
    timestamp: message.messageTimestamp || null,
    text: message.message?.conversation || message.message?.extendedTextMessage?.text || message.message?.imageMessage?.caption || message.message?.videoMessage?.caption || message.message?.documentMessage?.caption || null
  }
}

function latestConversationMessages(chat) {
  return (messagesByChat.get(canonicalJid(chat.id)) || [])
    .map(toPublicMessage)
    .filter(message => message.text)
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
    .slice(-10)
}

app.get('/api/chats/:jid/messages', (req, res) => {
  const requestedJid = canonicalJid(req.params.jid), chat = chats.get(requestedJid) || chats.get(req.params.jid)
  if (!chat) return res.status(404).json({ error: 'Chat não encontrado.' })
  if (isArchived(chat)) return res.status(403).json({ error: 'Chat arquivado. Esta etapa lê somente conversas desarquivadas.' })
  const messages = (messagesByChat.get(requestedJid) || messagesByChat.get(req.params.jid) || []).map(toPublicMessage)
  res.json({ jid: requestedJid, count: messages.length, messages })
})

app.get('/api/pedidos/contexto', (_req, res) => {
  const active = canonicalChats().filter(c => !isArchived(c)).sort((a, b) => Number(b.conversationTimestamp || 0) - Number(a.conversationTimestamp || 0))
  const conversas = active.map(chat => {
    const mensagensContexto = latestConversationMessages(chat)
    return { jid: canonicalJid(chat.id), nomeWhatsApp: chatDisplayName(chat), arquivada: false, mensagensContexto, quantidadeContexto: mensagensContexto.length }
  })
  res.json({ regra: 'somente conversas desarquivadas; as 10 mensagens mais recentes da conversa inteira, incluindo cliente e empresa', totalConversas: conversas.length, conversas })
})

app.get('/api/pedidos/coleta', (_req, res) => {
  const active = canonicalChats().filter(c => !isArchived(c)).sort((a, b) => Number(b.conversationTimestamp || 0) - Number(a.conversationTimestamp || 0))
  const conversations = active.map(chat => {
    const messages = latestConversationMessages(chat)
    return { jid: canonicalJid(chat.id), nomeWhatsApp: chatDisplayName(chat), arquivada: false, mensagensCapturadas: messages.length, mensagens }
  })
  res.json({ totalConversas: conversations.length, conversas: conversations })
})

const UNIT_ALIASES = { cx: 'Cx', caixa: 'Cx', caixas: 'Cx', tl: 'Tl', tal: 'Tl', talo: 'Tl', talos: 'Tl', un: 'Un', unidade: 'Un', unidades: 'Un', sc: 'Sc', saco: 'Sc', sacos: 'Sc', dz: 'DZ', duzia: 'DZ', 'dúzia': 'DZ', bdj: 'BDJ', bandeja: 'BDJ', pote: 'Pote', gf: 'Gf', garrafa: 'Gf', pc: 'Pc', pacote: 'Pc' }
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'

function normalizeAiItems(items) {
  if (!Array.isArray(items)) return []
  return items.map(item => {
    const produto = String(item?.produto || '').trim()
    const quantidade = Number(item?.quantidade)
    const unidadeRaw = String(item?.unidade || '').trim().toLowerCase()
    if (!produto || !Number.isFinite(quantidade) || quantidade <= 0) return null
    return { produto, quantidade, unidade: UNIT_ALIASES[unidadeRaw] || String(item?.unidade || '').trim() || null }
  }).filter(Boolean)
}

async function interpretarPedidoComIA(nomeCliente, mensagens) {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('GROQ_API_KEY não configurada no Render.')

  const contexto = mensagens.map((m, index) => ({ ordem: index + 1, quem: m.fromMe ? 'EMPRESA' : 'CLIENTE', texto: m.text }))
  const systemPrompt = `Você é o interpretador de pedidos do Samuel Frutas. Receberá as 10 mensagens mais recentes de UMA conversa do WhatsApp, na ordem cronológica, incluindo CLIENTE e EMPRESA.

Sua tarefa é montar SOMENTE o último pedido que está sendo tratado nessa conversa.

Regras:
- Use CLIENTE e EMPRESA juntos como contexto.
- Mensagens da EMPRESA podem confirmar, corrigir ou ajustar quantidades do pedido.
- Nunca invente produto, quantidade ou unidade.
- Se a empresa corrigiu claramente uma quantidade, use a quantidade corrigida.
- Ignore conversa casual.
- Se não houver pedido identificável, tem_pedido=false.
- Se houver pedido, retorne somente os itens do último pedido.
- Quando houver pedidos antigos, ignore os antigos e fique no último.
- Normalize o nome para o produto do Samuel Frutas quando for claro.
- Unidades comuns: Un, DZ, Cx, Tl, Sc, BDJ, Pote, Gf, Pc.
- Se a unidade não estiver informada, use null.
- Não faça preços, totais ou taxas.
- Responda APENAS JSON válido: {"tem_pedido":true,"itens":[{"produto":"banana","quantidade":12,"unidade":"Un"}]} ou {"tem_pedido":false,"itens":[]}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify({ cliente: nomeCliente, mensagens: contexto }) }
        ]
      })
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data?.error?.message || `Groq respondeu HTTP ${response.status}`)
    const content = data?.choices?.[0]?.message?.content
    if (!content) throw new Error('Groq não retornou uma interpretação.')
    let parsed
    try { parsed = JSON.parse(content) } catch { throw new Error('Groq retornou JSON inválido.') }
    return { temPedido: Boolean(parsed?.tem_pedido), itens: normalizeAiItems(parsed?.itens) }
  } finally {
    clearTimeout(timeout)
  }
}

app.get('/api/pedidos/interpretar', async (_req, res) => {
  const active = canonicalChats().filter(c => !isArchived(c)).sort((a, b) => Number(b.conversationTimestamp || 0) - Number(a.conversationTimestamp || 0))
  const resultados = []

  for (const chat of active) {
    const nomeWhatsApp = chatDisplayName(chat)
    const mensagens = latestConversationMessages(chat)
    try {
      const interpretacao = await interpretarPedidoComIA(nomeWhatsApp, mensagens)
      resultados.push({
        jid: canonicalJid(chat.id),
        nomeWhatsApp,
        contextoMensagens: mensagens.length,
        mensagensContexto: mensagens,
        pedido: interpretacao.itens,
        pedidoStatus: interpretacao.temPedido && interpretacao.itens.length ? 'identificado' : 'nao_identificado',
        erro: null
      })
    } catch (error) {
      logger.error({ error: error?.message || String(error), jid: canonicalJid(chat.id) }, 'erro ao interpretar pedido')
      resultados.push({
        jid: canonicalJid(chat.id),
        nomeWhatsApp,
        contextoMensagens: mensagens.length,
        mensagensContexto: mensagens,
        pedido: [],
        pedidoStatus: 'erro',
        erro: error?.message || String(error)
      })
    }
  }

  res.json({ regra: 'somente conversas desarquivadas; últimas 10 mensagens da conversa inteira; interpretação feita pela IA Groq', totalConversas: resultados.length, resultados })
})

app.get('/api/chats/stats', (_req, res) => {
  const all = canonicalChats(), active = all.filter(c => !isArchived(c)), archived = all.filter(c => isArchived(c))
  res.json({ total: all.length, active: active.length, archived: archived.length, capturedAt: new Date().toISOString() })
})

app.get('/health', (_req, res) => res.json({ ok: true, connection, chats: canonicalChats().length }))
app.listen(port, () => {
  startWhatsApp().catch(err => logger.error(err))
  console.log('Servidor do coletor rodando na porta ' + port)
})
