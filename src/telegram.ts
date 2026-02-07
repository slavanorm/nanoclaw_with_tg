import { Bot } from 'grammy';
import { TELEGRAM_BOT_TOKEN } from './config.js';
import { storeChatMetadata, storeMessage } from './db.js';
import { logger } from './logger.js';
import { Channel } from './channel.js';
import { Agent } from './agent.js';

export class TelegramChannel extends Channel {
  bot!: Bot;

  constructor(agent: Agent) {
    super(agent);
  }

  async connect(onReady: () => void): Promise<void> {
    if (!TELEGRAM_BOT_TOKEN) {
      logger.error('TELEGRAM_BOT_TOKEN not set');
      process.exit(1);
    }
    this.bot = new Bot(TELEGRAM_BOT_TOKEN);

    this.bot.on('message', (ctx) => {
      const msg = ctx.message;
      if (!msg) return;
      const jid = String(msg.chat.id);
      const ts = new Date(msg.date * 1000).toISOString();
      const text = msg.text || msg.caption || '';
      const name = msg.from?.first_name || msg.from?.username || 'Unknown';
      storeChatMetadata(jid, ts);
      if (this.agent.groups[jid]) {
        const fake = {
          key: { remoteJid: jid, id: String(msg.message_id), fromMe: false },
          messageTimestamp: msg.date,
          message: { conversation: text },
          pushName: name,
        };
        storeMessage(fake as any, jid, false, name);
      }
    });

    this.bot.catch((err) => logger.error({ err }, 'Telegram bot error'));
    const me = await this.bot.api.getMe();
    logger.info({ username: me.username }, 'Connected to Telegram');
    this.bot.start({ onStart: onReady });
  }

  async send(jid: string, text: string): Promise<void> {
    await this.bot.api.sendMessage(jid, text);
  }

  async typing(jid: string): Promise<void> {
    await this.bot.api.sendChatAction(jid, 'typing').catch(() => {});
  }

  async close(): Promise<void> {
    await this.bot.stop();
  }
}
