import { execSync } from 'child_process';

import { ASSISTANT_NAME, CHANNEL, POLL_INTERVAL } from './config.js';
import { getNewMessages, initDatabase } from './db.js';
import { Agent } from './agent.js';
import { TelegramChannel } from './telegram.js';
import { WhatsAppChannel } from './whatsapp.js';
import { logger } from './logger.js';

const agent = new Agent();
const channel = CHANNEL === 'telegram'
  ? new TelegramChannel(agent)
  : new WhatsAppChannel(agent);

function ensureContainer(): void {
  try {
    execSync('container system status', { stdio: 'pipe' });
  } catch {
    logger.info('Starting Apple Container system...');
    try {
      execSync('container system start', { stdio: 'pipe', timeout: 30000 });
    } catch (err) {
      logger.error({ err }, 'Failed to start container system');
      console.error('FATAL: Apple Container system failed to start');
      console.error('Install from: https://github.com/apple/container/releases');
      process.exit(1);
    }
  }
  try {
    const out = execSync('container ls -a --format {{.Names}}', { encoding: 'utf-8' });
    const stale = out.split('\n').map((n) => n.trim()).filter((n) => n.startsWith('nanoclaw-'));
    if (stale.length > 0) execSync(`container rm ${stale.join(' ')}`, { stdio: 'pipe' });
  } catch {}
}

async function loop(): Promise<void> {
  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);
  let lastTs = '';

  while (true) {
    try {
      const jids = Object.keys(agent.groups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTs, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');
        lastTs = newTimestamp;

        const seen = new Set<string>();
        for (const m of messages) seen.add(m.chat_jid);
        for (const jid of seen) agent.queue.enqueueMessageCheck(jid);
      }
    } catch (err) {
      logger.error({ err }, 'Loop error');
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

async function main(): Promise<void> {
  ensureContainer();
  initDatabase();
  agent.loadState();

  const stop = async (sig: string) => {
    logger.info({ sig }, 'Shutdown');
    await channel.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  channel.start(loop);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start');
  process.exit(1);
});
