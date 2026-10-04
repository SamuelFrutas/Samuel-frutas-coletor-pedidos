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
    const exists = list.some(item => item.key?.id === message.key.id)
    if (exists) continue
    list.push(message)
    list.sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0))
    messagesByChat.set(key, list.slice(-MAX_MESSAGES_PER_CHAT))
  }
}

function isArchived(chat) {
  return chat?.archived === true || chat?.archived === 1
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
    chats.set(pn, {
      ...lidChat,
      ...pnChat,
      id: pn
    })
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
    messagesByChat.set(
      pn,
      [...merged.values()]
        .sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0))
        .slice(-MAX_MESSAGES_PER_CHAT)
    )
    messagesByChat.delete(lid)
  }
}

function applyHistoryMappings(mappings = []) {
  for (const mapping of mappings) {
    if (mapping?.lid && mapping?.pn) {
      mergeChatIdentity(mapping.lid, mapping.pn)
    }
  }
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

    groups.set(key, {
      ...previous,
      ...chat,
      id: key,
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
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      shouldSyncHistoryMessage: () => true
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.process(async events => {
      if (events['connection.update']) {
        const { connection: nextConnection, lastDisconnect, qr } = events['connection.update']

        connection = nextConnection

        if (lastDisconnect?.error) {
          connectionError = lastDisconnect.error?.message || String(lastDisconnect.error)
        }

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
      }

      // Baileys buffers history, chat upserts and chat updates together.
      // When a history batch is present, its chats.upsert entries are the
      // same history records. We must not treat the later FULL/RECENT
      // history dump as a new live chat list.
      if (events['messaging-history.set']) {
        const {
          chats: historyChats,
          messages: historyMessages,
          contacts: historyContacts,
          lidPnMappings,
          isLatest,
          syncType,
          progress
        } = events['messaging-history.set']

        applyHistoryMappings(lidPnMappings)

        for (const contact of historyContacts || []) {
          rememberContactName(contact)
          if (contact?.lid && contact?.id?.endsWith('@s.whatsapp.net')) {
            mergeChatIdentity(contact.lid, contact.id)
          }
        }

        // Only the latest bootstrap establishes the current chat list.
        // Older RECENT/FULL/ON_DEMAND history is message backfill, not
        // permission to add dozens of old chats to the current inbox.
        if (isLatest || (chats.size === 0 && syncType === 0 && historyChats?.length)) {
          upsertChats(historyChats)
        }

        upsertMessages(historyMessages)

        logger.info({
          chats: historyChats?.length || 0,
          messages: historyMessages?.length || 0,
          mappings: lidPnMappings?.length || 0,
          contacts: historyContacts?.length || 0,
          isLatest,
          syncType,
          progress,
          storedChats: chats.size,
          canonicalChats: canonicalChats().length
        }, 'histórico recebido')
      }

      // If there is a history event in this buffered batch, ignore chats.upsert:
      // event-buffer already absorbed the history chat into this upsert list.
      if (!events['messaging-history.set'] && events['chats.upsert']) {
        upsertChats(events['chats.upsert'])
      }

      if (events['chats.update']) {
        updateChats(events['chats.update'])
      }

      if (events['chats.delete']) {
        for (const id of events['chats.delete']) {
          chats.delete(id)
        }
      }

      if (events['messages.upsert']) {
        upsertMessages(events['messages.upsert'].messages)
        logger.info({
          count: events['messages.upsert'].messages?.length || 0,
          type: events['messages.upsert'].type
        }, 'mensagens recebidas')
      }

      if (events['lid-mapping.update']) {
        const { lid, pn } = events['lid-mapping.update']
        mergeChatIdentity(lid, pn)
      }

      if (events['contacts.upsert']) {
        for (const contact of events['contacts.upsert']) {
          rememberContactName(contact)
          if (contact?.lid && contact?.id?.endsWith('@s.whatsapp.net')) {
            mergeChatIdentity(contact.lid, contact.id)
          }
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

app.post('/api/whatsapp/connect', async (_req, res) => {
  try {
    if (connection === 'open') {
      return res.json({ ok: true, connected: true, message: 'WhatsApp já está conectado.' })
    }
    latestQr = null
    connectionError = null
    startWhatsApp().catch(err => logger.error(err))
    res.json({ ok: true, connected: false, message: 'Solicitação de conexão iniciada. Aguarde o QR Code.' })
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
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
  const active = canonicalChats()
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
  if (isArchived(chat)) {
    return res.status(403).json({
      error: 'Chat arquivado. Esta etapa lê somente conversas desarquivadas.'
    })
  }

  const messages = (
    messagesByChat.get(requestedJid) ||
    messagesByChat.get(req.params.jid) ||
    []
  ).map(message => ({
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


app.get('/api/pedidos/contexto', (_req, res) => {
  // O pedido normalmente está nas mensagens mais recentes.
  // Enviamos somente as 10 últimas mensagens de cada conversa desarquivada.
  const active = canonicalChats()
    .filter(chat => !isArchived(chat))
    .sort((a, b) => Number(b.conversationTimestamp || 0) - Number(a.conversationTimestamp || 0))

  const conversas = active.map(chat => {
    const jid = canonicalJid(chat.id)
    const todas = messagesByChat.get(jid) || []
    const mensagens = todas
      .slice(-10)
      .map(message => ({
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

    return {
      jid,
      nomeWhatsApp: chatDisplayName(chat),
      arquivada: false,
      mensagensContexto: mensagens,
      quantidadeContexto: mensagens.length
    }
  })

  res.json({
    regra: 'somente conversas desarquivadas; somente as 10 mensagens mais recentes por conversa',
    totalConversas: conversas.length,
    conversas
  })
})

app.get('/api/pedidos/coleta', (_req, res) => {
  // Esta etapa trabalha EXCLUSIVAMENTE com conversas desarquivadas.
  // Nenhuma conversa arquivada entra na coleta.
  const active = canonicalChats()
    .filter(chat => !isArchived(chat))
    .sort((a, b) => Number(b.conversationTimestamp || 0) - Number(a.conversationTimestamp || 0))

  const conversations = active.map(chat => {
    const jid = canonicalJid(chat.id)
    const messages = (messagesByChat.get(jid) || []).map(message => ({
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

    return {
      jid,
      nomeWhatsApp: chat.name || chat.pushName || chat.notify || null,
      arquivada: false,
      mensagensCapturadas: messages.length,
      mensagens: messages
    }
  })

  res.json({
    totalConversas: conversations.length,
    conversas: conversations
  })
})

const ORDER_PRODUCTS = [
  ['banana', ['banana']],
  ['mamão papaya', ['mamão', 'mamao', 'mamão papaya', 'mamao papaya']],
  ['tangerina', ['tangerina', 'mexerica', 'mixiriquinha']],
  ['abacaxi', ['abacaxi']],
  ['abacate', ['abacate']],
  ['goiaba', ['goiaba']],
  ['laranja pera', ['laranja pera', 'laranja']],
  ['maçã', ['maçã', 'maca']],
  ['manga palmer', ['manga palmer', 'manga']],
  ['melancia', ['melancia']],
  ['melão', ['melão', 'melao']],
  ['morango', ['morango']],
  ['pera macia', ['pera macia', 'pera']],
  ['uva preta', ['uva preta']],
  ['uva verde', ['uva verde']],
  ['limão', ['limão', 'limao']],
  ['caju', ['caju']],
  ['tâmara', ['tâmara', 'tamara']],
  ['coco', ['coco']],
  ['garrafa', ['garrafa']],
  ['ovos caipira', ['ovos', 'ovo', 'ovos caipira']],
  ['mel', ['mel']]
]

const UNIT_ALIASES = {
  cx: 'Cx', caixa: 'Cx', caixas: 'Cx',
  tl: 'Tl', tal: 'Tl', talo: 'Tl', unidade: 'Un', unidades: 'Un',
  un: 'Un', sc: 'Sc', saco: 'Sc', sacos: 'Sc',
  dz: 'DZ', duzia: 'DZ', dúzia: 'DZ', bandeja: 'BDJ', bdj: 'BDJ',
  pote: 'Pote', gf: 'Gf', garrafa: 'Gf', pc: 'Pc', pacote: 'Pc'
}

function normalizeText(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function extractQuantityAndUnit(text, index, alias = '') {
  const normalized = normalizeText(text)
  const aliasNorm = normalizeText(alias)
  const before = normalized.slice(Math.max(0, index - 80), index)
  const after = normalized.slice(index + aliasNorm.length, index + aliasNorm.length + 80)

  const unitPattern = '(?:cx|caixas?|tl|tal(?:o)?s?|un(?:idade|idades)?|sc|sacos?|dz|duzia|dúzia|bdj|bandeja|pote|gf|garrafa|pc|pacote)'
  const numberPattern = '(\\d+(?:[,.]\\d+)?)'

  const read = match => {
    if (!match) return null
    const quantity = Number(String(match[1]).replace(',', '.'))
    if (!Number.isFinite(quantity)) return null
    const rawUnit = normalizeText(match[2] || '')
    return { quantity, unit: UNIT_ALIASES[rawUnit] || null }
  }

  const beforeMatch = before.match(new RegExp('(?:^|\\s)' + numberPattern + '\\s*(?:x\\s*)?(' + unitPattern + ')?\\s*$', 'i'))
  const beforeValue = read(beforeMatch)
  if (beforeValue) return beforeValue

  const afterMatch = after.match(new RegExp('^\\s*[:=-]?\\s*' + numberPattern + '\\s*(' + unitPattern + ')?\\b', 'i'))
  const afterValue = read(afterMatch)
  if (afterValue) return afterValue

  return { quantity: null, unit: null }
}

function extractOrderFromMessages(messages) {
  const candidates = []
  const seen = new Set()

  for (const message of messages) {
    if (!message?.text || message.fromMe) continue
    const original = String(message.text)
    const parts = original.split(/\r?\n|[;|]/).map(value => value.trim()).filter(Boolean)

    for (const part of parts) {
      const normalized = normalizeText(part)

      for (const [product, aliases] of ORDER_PRODUCTS) {
        for (const alias of aliases.slice().sort((a, b) => b.length - a.length)) {
          const aliasNorm = normalizeText(alias)
          const escaped = aliasNorm.replace(/[.*+?^()|[\\]\\]/g, '\\$&')
          const match = normalized.match(new RegExp('(^|\\s|[:=-])' + escaped + '(?=\\s|$|[:=,-])', 'i'))
          if (!match) continue

          const index = match.index + match[1].length
          const { quantity, unit } = extractQuantityAndUnit(normalized, index, alias)
          if (quantity === null || !Number.isFinite(quantity)) continue

          const key = product + '|' + quantity + '|' + (unit || '')
          if (seen.has(key)) continue
          seen.add(key)
          candidates.push({ produto: product, quantidade: quantity, unidade: unit, mensagemId: message.id, textoOrigem: original })
          break
        }
      }
    }
  }
  return candidates
}

function extractLastOrderFromMessages(messages) {
  const customerMessages = messages
    .filter(message => message?.text && !message.fromMe)
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
  const selected = []
  const seenProducts = new Set()
  let orderStarted = false

  for (let i = customerMessages.length - 1; i >= 0; i--) {
    const message = customerMessages[i]
    const items = extractOrderFromMessages([message])
    if (!items.length) {
      if (orderStarted) break
      continue
    }
    orderStarted = true
    for (const item of items) {
      if (seenProducts.has(item.produto)) continue
      seenProducts.add(item.produto)
      selected.push(item)
    }
  }
  return selected.reverse()
}
function extractIdentityReference(identity = '') {
  const raw = String(identity || '').trim()
  if (!raw) return null
  const normalized = normalizeText(raw)
  const refs = [...normalized.matchAll(/\b\d+(?:\s*[\/-]\s*\d+)+\b/g)]
    .map(match => match[0].replace(/\s+/g, ''))
  const standalone = [...normalized.matchAll(/\b\d{2,}\b/g)]
    .map(match => match[0])
  const identificadores = [...new Set([
    ...refs.flatMap(value => value.split(/[\/-]/)),
    ...standalone
  ])]
  const nome = raw
    .replace(/\b\d+(?:\s*[\/-]\s*\d+)+\b/g, ' ')
    .replace(/\b\d{2,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { nome: nome || raw, referenciaOriginal: raw, identificadores }
}

function interpretConversation(chat, messages) {
  const textMessages = messages.filter(message => message.text)
  const customerMessages = textMessages.filter(message => !message.fromMe)
  const order = extractLastOrderFromMessages(messages)
  const identity = chatDisplayName(chat)
  const identityReference = extractIdentityReference(identity)

  return {
    jid: canonicalJid(chat.id),
    nomeWhatsApp: identity,
    cadastro: null,
    enderecoCadastro: null,
    referenciaWhatsApp: identityReference,
    identificacaoStatus: identityReference
      ? 'referencia_encontrada_no_whatsapp'
      : 'cadastro_nao_consultado',
    pedido: order,
    pedidoStatus: order.length ? 'identificado' : 'nao_identificado',
    precisaConferencia: !order.length || !identityReference,
    contextoMensagens: textMessages.length,
    ultimaMensagemCliente: customerMessages.at(-1)?.text || null
  }
}

app.get('/api/pedidos/interpretar', (_req, res) => {
  const active = canonicalChats()
    .filter(chat => !isArchived(chat))
    .sort((a, b) => Number(b.conversationTimestamp || 0) - Number(a.conversationTimestamp || 0))

  const resultados = active.map(chat => {
    const jid = canonicalJid(chat.id)
    // Usamos as mensagens capturadas disponíveis para localizar o ÚLTIMO pedido.
    // O resultado exibido ao usuário mostra somente esse pedido.
    const messages = (messagesByChat.get(jid) || []).map(message => ({
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

    return interpretConversation(chat, messages)
  })

  res.json({
    regra: 'somente conversas desarquivadas; mostrar somente o último pedido identificado de cada pessoa',
    totalConversas: resultados.length,
    resultados
  })
})

app.get('/api/chats/stats', (_req, res) => {
  const all = canonicalChats()
  const active = all.filter(chat => !isArchived(chat))
  const archived = all.filter(chat => isArchived(chat))

  res.json({
    total: all.length,
    active: active.length,
    archived: archived.length,
    capturedAt: new Date().toISOString()
  })
})

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    connection,
    chats: canonicalChats().length
  })
})

app.listen(port, () => {
  console.log(`Teste disponível em http://localhost:${port}`)
  startWhatsApp().catch(err => logger.error(err))
})
