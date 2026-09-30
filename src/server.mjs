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
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const port = Number(process.env.PORT || 3000)
const logger = P({ level: process.env.LOG_LEVEL || 'info' })

const chats = new Map()
let sock = null
let connection = 'close'
let latestQr = null
let reconnecting = false

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

function isArchived(chat) {
  return chat?.archived === true
}

function publicChat(chat) {
  return {
    id: chat.id,
    name: chat.name || chat.pushName || chat.id,
    archived: isArchived(chat),
    unreadCount: chat.unreadCount || 0,
    conversationTimestamp: chat.conversationTimestamp || null,
    lastMessageRecvTimestamp: chat.lastMessageRecvTimestamp || null
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
      if (qr) {
        latestQr = qr
        console.log('\n=== QR CODE — TESTE COLETOR DE PEDIDOS ===')
        qrcode.generate(qr, { small: true })
        console.log('Abra o WhatsApp > Dispositivos conectados > Conectar dispositivo.\n')
      }
      if (nextConnection === 'open') {
        latestQr = null
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

    sock.ev.on('messaging-history.set', ({ chats: historyChats }) => {
      upsertChats(historyChats)
      logger.info({ count: historyChats?.length || 0 }, 'histórico de chats recebido')
    })

    sock.ev.on('chats.upsert', upsertChats)
    sock.ev.on('chats.update', updateChats)
    sock.ev.on('chats.delete', ids => ids.forEach(id => chats.delete(id)))

    logger.info('teste iniciado: aguardando sincronização de chats')
  } finally {
    reconnecting = false
  }
}

app.use(express.static(path.join(__dirname, '..', 'public')))

app.get('/api/status', (_req, res) => {
  const all = [...chats.values()]
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
  const all = [...chats.values()]
  const active = all
    .filter(chat => !isArchived(chat))
    .sort((a, b) => (b.conversationTimestamp || 0) - (a.conversationTimestamp || 0))
  res.json(active.map(publicChat))
})

app.get('/api/chats/all', (_req, res) => {
  const all = [...chats.values()]
    .sort((a, b) => Number(isArchived(a)) - Number(isArchived(b)))
  res.json(all.map(publicChat))
})

app.get('/health', (_req, res) => {
  res.json({ ok: true, connection, chats: chats.size })
})

app.listen(port, () => {
  console.log(`Teste disponível em http://localhost:${port}`)
  startWhatsApp().catch(err => logger.error(err))
})
