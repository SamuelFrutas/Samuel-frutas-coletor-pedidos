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
    const exists = list.some(item => item.key?.id === message.key.id)
    if (exists) continue
    list.push(message)
    list.sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0))
    messagesByChat.set(key, list.slice(-MAX_MESSAGES_PER_CHAT))
  }
}

function isArchived(chat) {
  // O Baileys pode entregar o campo archived como boolean ou número.
  return chat?.archived === true || chat?.archived === 1
}

function canonicalJid(jid) {
  return lidToPn.get(jid) || jid
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
    // Quando o mesmo contato chega como @lid e @s.whatsapp.net,
    // preferimos a entrada PN, mas preservamos o estado conhecido.
    const preferred = key.endsWith('@s.whatsapp.net') ? chat : previous
    groups.set(key, {
      ...previous,
      ...chat,
      ...preferred,
      id: key,
      archived: isArchived(preferred) || isArchived(previous),
      conversationTimestamp: Math.max(
        Number(previous.conversationTimestamp || 0),
        Number(chat.conversationTimestamp || 0)
      )
    })
  }
  return [...groups.values()]
}

function publicChat(chat) {
  return {
    id: chat.id,
    name: chat.name || chat.pushName || chat.notify || chat.id,
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
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      shouldSyncHistoryMessage: () => true
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', ({ connection: nextConnection, lastDisconnect, qr }) => {
      connection = nextConnection
      if (lastDisconnect?.error) connectionError = lastDisconnect.error?.message || String(lastDisconnect.error)
      if (qr) {
        latestQr = qr
        console.log('\n=== QR CODE — TESTE COLETOR DE PEDIDOS ===')
        qrcode.generate(qr, { small: true })
        console.log('Abra o WhatsApp > Dispositivos conectados > Conectar dispositivo.\n')
      }
      if (nextConnection === 'open') {
        latestQr = null
        connectionError = null
        lastConnectedAt = new Date().toISOString()
        console.log('WhatsApp conectado.')
      }
      if (nextConnection === 'close') {
        latestQr = null
        const loggedOut = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode === DisconnectReason.loggedOut
          : false
        if (!loggedOut) {
          setTimeout(() => {
            reconnecting = false
            startWhatsApp().catch(err => logger.error(err))
          }, 3000)
        }
      }
    })

    sock.ev.on('messaging-history.set', ({ chats: historyChats, messages: historyMessages }) => {
      upsertChats(historyChats)
      upsertMessages(historyMessages)
      logger.info({
        chats: historyChats?.length || 0,
        messages: historyMessages?.length || 0
      }, 'histórico recebido')
    })

    sock.ev.on('messages.upsert', ({ messages }) => {
      upsertMessages(messages)
      logger.info({ count: messages?.length || 0 }, 'mensagens recebidas')
    })

    sock.ev.on('chats.upsert', upsertChats)
    sock.ev.on('chats.update', updateChats)
    sock.ev.on('chats.delete', ids => ids.forEach(id => chats.delete(id)))
    sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
      if (lid && pn) lidToPn.set(lid, pn)
    })
    sock.ev.on('contacts.upsert', contacts => {
      for (const contact of contacts || []) {
        if (contact?.lid && contact?.id?.endsWith('@s.whatsapp.net')) {
          lidToPn.set(contact.lid, contact.id)
        }
      }
    })

    logger.info('etapa 4 iniciada: aguardando captura de mensagens')
  } finally {
    reconnecting = false
  }
}

app.use(express.static(path.join(__dirname, '..', 'public')))

app.get('/api/whatsapp/status', (_req, res) => {
  res.json({
    connection,
    connected: connection === 'open',
    qrPending: Boolean(latestQr),
    lastConnectedAt,
    error: connectionError
  })
})

app.get('/api/whatsapp/qr', async (_req, res) => {
  if (!latestQr) return res.status(404).json({ qrPending: false, message: 'QR não disponível.' })
  const dataUrl = await QRCode.toDataURL(latestQr, { margin: 2, width: 320 })
  res.json({ qrPending: true, dataUrl })
})

app.get('/api/status', (_req, res) => {
  const all = canonicalChats()
  const active = all.filter(chat => !isArchived(chat))
  const archived = all.filter(chat => isArchived(chat))
  res.json({
    connection,
    totalChats: all.length,
    activeChats: active.length,
    archivedChats: archived.length,
    qrPending: Boolean(latestQr)
  })
})

app.get('/api/chats', (_req, res) => {
  const all = canonicalChats()
  const active = all
    .filter(chat => !isArchived(chat))
    .sort((a, b) => (b.conversationTimestamp || 0) - (a.conversationTimestamp || 0))
  res.json(active.map(publicChat))
})

app.get('/api/chats/all', (_req, res) => {
  const all = canonicalChats()
    .sort((a, b) => Number(isArchived(a)) - Number(isArchived(b)))
  res.json(all.map(publicChat))
})

app.get('/api/chats/:jid/messages', (req, res) => {
  const requestedJid = canonicalJid(req.params.jid)
  const chat = chats.get(requestedJid) || chats.get(req.params.jid)
  if (!chat) return res.status(404).json({ error: 'Chat não encontrado.' })
  if (isArchived(chat)) return res.status(403).json({ error: 'Chat arquivado. Esta etapa lê somente conversas desarquivadas.' })
  const messages = (messagesByChat.get(requestedJid) || messagesByChat.get(req.params.jid) || []).map(message => ({
    id: message.key?.id || null,
    fromMe: Boolean(message.key?.fromMe),
    sender: message.pushName || message.key?.participant || message.key?.remoteJid || null,
    timestamp: message.messageTimestamp || null,
    text: message.message?.conversation
      || message.message?.extendedTextMessage?.text
      || message.message?.imageMessage?.caption
      || message.message?.videoMessage?.caption
      || message.message?.documentMessage?.caption
      || null
  }))
  res.json({ jid: requestedJid, count: messages.length, messages })
})

app.get('/api/chats/stats', (_req, res) => {
  const all = canonicalChats()
  const active = all.filter(chat => !isArchived(chat))
  const archived = all.filter(chat => isArchived(chat))
  res.json({ total: all.length, active: active.length, archived: archived.length, capturedAt: new Date().toISOString() })
})

app.get('/health', (_req, res) => {
  res.json({ ok: true, connection, chats: chats.size })
})

app.listen(port, () => {
  console.log(`Teste disponível em http://localhost:${port}`)
  startWhatsApp().catch(err => logger.error(err))
})
