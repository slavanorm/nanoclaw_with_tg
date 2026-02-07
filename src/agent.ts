import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  MAIN_GROUP_FOLDER,
  TRIGGER_PATTERN,
} from './config.js';
import {
  AgentResponse,
  AvailableGroup,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getRouterState,
  setRegisteredGroup,
  setRouterState,
  setSession,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import type { Channel } from './channel.js';

export class Agent {
  queue = new GroupQueue();
  sessions: Record<string, string> = {};
  groups: Record<string, RegisteredGroup> = {};
  lastTs: Record<string, string> = {};

  loadState(): void {
    const ts = getRouterState('last_agent_timestamp');
    try {
      this.lastTs = ts ? JSON.parse(ts) : {};
    } catch {
      this.lastTs = {};
    }
    this.sessions = getAllSessions();
    this.groups = getAllRegisteredGroups();
    logger.info({ count: Object.keys(this.groups).length }, 'State loaded');
  }

  saveTs(): void {
    setRouterState('last_agent_timestamp', JSON.stringify(this.lastTs));
  }

  register(jid: string, group: RegisteredGroup): void {
    this.groups[jid] = group;
    setRegisteredGroup(jid, group);
    const dir = path.join(DATA_DIR, '..', 'groups', group.folder);
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    logger.info({ jid, name: group.name }, 'Group registered');
  }

  available(): AvailableGroup[] {
    const chats = getAllChats();
    const registered = new Set(Object.keys(this.groups));
    return chats
      .filter((c) => c.jid !== '__group_sync__')
      .map((c) => ({
        jid: c.jid,
        name: c.name,
        lastActivity: c.last_message_time,
        isRegistered: registered.has(c.jid),
      }));
  }

  async process(channel: Channel, jid: string): Promise<boolean> {
    const group = this.groups[jid];
    if (!group) return true;

    const isMain = group.folder === MAIN_GROUP_FOLDER;
    const since = this.lastTs[jid] || '';
    const msgs = getMessagesSince(jid, since, ASSISTANT_NAME);
    if (msgs.length === 0) return true;

    if (!isMain && group.requiresTrigger !== false) {
      if (!msgs.some((m) => TRIGGER_PATTERN.test(m.content.trim()))) return true;
    }

    const xml = msgs.map((m) => {
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      return `<message sender="${esc(m.sender_name)}" time="${m.timestamp}">${esc(m.content)}</message>`;
    });
    const prompt = `<messages>\n${xml.join('\n')}\n</messages>`;

    logger.info({ group: group.name, count: msgs.length }, 'Processing');
    await channel.typing(jid);

    const res = await this.run(group, prompt, jid);
    if (res === 'error') return false;

    this.lastTs[jid] = msgs[msgs.length - 1].timestamp;
    this.saveTs();

    if (res.outputType === 'message' && res.userMessage) {
      await channel.send(jid, `${ASSISTANT_NAME}: ${res.userMessage}`);
    }
    return true;
  }

  async run(group: RegisteredGroup, prompt: string, jid: string): Promise<AgentResponse | 'error'> {
    const isMain = group.folder === MAIN_GROUP_FOLDER;
    const sessionId = this.sessions[group.folder];

    writeTasksSnapshot(group.folder, isMain, getAllTasks().map((t) => ({
      id: t.id, groupFolder: t.group_folder, prompt: t.prompt,
      schedule_type: t.schedule_type, schedule_value: t.schedule_value,
      status: t.status, next_run: t.next_run,
    })));

    writeGroupsSnapshot(group.folder, isMain, this.available(), new Set(Object.keys(this.groups)));

    try {
      const out = await runContainerAgent(
        group,
        { prompt, sessionId, groupFolder: group.folder, chatJid: jid, isMain },
        (proc, name) => this.queue.registerProcess(jid, proc, name),
      );
      if (out.newSessionId) {
        this.sessions[group.folder] = out.newSessionId;
        setSession(group.folder, out.newSessionId);
      }
      if (out.status === 'error') {
        logger.error({ group: group.name, error: out.error }, 'Agent error');
        return 'error';
      }
      return out.result ?? { outputType: 'log' };
    } catch (err) {
      logger.error({ group: group.name, err }, 'Agent error');
      return 'error';
    }
  }

  startScheduler(channel: Channel): void {
    startSchedulerLoop({
      sendMessage: (jid, text) => channel.send(jid, text),
      registeredGroups: () => this.groups,
      getSessions: () => this.sessions,
      queue: this.queue,
      onProcess: (jid, proc, name) => this.queue.registerProcess(jid, proc, name),
    });
  }

  recover(): void {
    for (const [jid, g] of Object.entries(this.groups)) {
      const since = this.lastTs[jid] || '';
      const pending = getMessagesSince(jid, since, ASSISTANT_NAME);
      if (pending.length > 0) {
        logger.info({ group: g.name, count: pending.length }, 'Recovering');
        this.queue.enqueueMessageCheck(jid);
      }
    }
  }
}
