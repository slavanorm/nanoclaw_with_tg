import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import makeWASocket, {
  DisconnectReason,
  WASocket,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { STORE_DIR } from './config.js';
import { storeChatMetadata, storeMessage, updateChatName, getLastGroupSync, setLastGroupSync } from './db.js';
import { logger } from './logger.js';
import { Channel } from './channel.js';
import { Agent } from './agent.js';

const SYNC_INTERVAL = 24 * 60 * 60 * 1000;

export class WhatsAppChannel extends Channel {
  sock!: WASocket;
  lidMap: Record<string, string> = {};
  ready: () => void = () => {};

  constructor(agent: Agent) {
    super(agent);
  }

  translateJid(jid: string): string {
    if (!jid.endsWith('@lid')) return jid;
    return this.lidMap[jid.split('@')[0].split(':')[0]] || jid;
  }

  async syncGroups(): Promise<void> {
    const last = getLastGroupSync();
    if (last && Date.now() - new Date(last).getTime() < SYNC_INTERVAL) return;
    const all = await this.sock.groupFetchAllParticipating().catch(() => ({}));
    for (const [jid, m] of Object.entries(all)) if (m.subject) updateChatName(jid, m.subject);
    setLastGroupSync();
  }

  async connect(onReady: () => void): Promise<void> {
    this.ready = onReady;
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    this.sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: false, logger, browser: ['NanoClaw', 'Chrome', '1.0.0'],
    });

    this.sock.ev.on('creds.update', saveCreds);
    this.sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        exec(`osascript -e 'display notification "WhatsApp auth required" with title "NanoClaw"'`);
        setTimeout(() => process.exit(1), 1000);
      }
      if (connection === 'close') {
        const code = (lastDisconnect?.error as any)?.output?.statusCode;
        code === DisconnectReason.loggedOut ? process.exit(0) : this.connect(this.ready);
      }
      if (connection === 'open') {
        logger.info('Connected to WhatsApp');
        if (this.sock.user?.lid) {
          this.lidMap[this.sock.user.lid.split(':')[0]] = `${this.sock.user.id.split(':')[0]}@s.whatsapp.net`;
        }
        this.syncGroups();
        setInterval(() => this.syncGroups(), SYNC_INTERVAL);
        this.ready();
      }
    });

    this.sock.ev.on('messages.upsert', ({ messages }) => {
      for (const m of messages) {
        if (!m.message || !m.key.remoteJid || m.key.remoteJid === 'status@broadcast') continue;
        const jid = this.translateJid(m.key.remoteJid);
        const ts = new Date(Number(m.messageTimestamp) * 1000).toISOString();
        storeChatMetadata(jid, ts);
        if (this.agent.groups[jid]) storeMessage(m, jid, m.key.fromMe || false, m.pushName);
      }
    });
  }

  async send(jid: string, text: string): Promise<void> {
    await this.sock.sendMessage(jid, { text });
  }

  async typing(jid: string): Promise<void> {
    await this.sock.sendPresenceUpdate('composing', jid).catch(() => {});
  }

  async close(): Promise<void> {}
}
