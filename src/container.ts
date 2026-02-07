import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { writeGroupsSnapshot } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getTaskById,
  updateTask,
} from './db.js';
import { Agent } from './agent.js';
import type { Channel } from './channel.js';
import { logger } from './logger.js';

export function watchCommands(agent: Agent, channel: Channel): void {
  const base = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(base, { recursive: true });

  const poll = async () => {
    let folders: string[];
    try {
      folders = fs.readdirSync(base).filter((f) => {
        const s = fs.statSync(path.join(base, f));
        return s.isDirectory() && f !== 'errors';
      });
    } catch {
      setTimeout(poll, IPC_POLL_INTERVAL);
      return;
    }

    for (const src of folders) {
      const isMain = src === MAIN_GROUP_FOLDER;
      const msgDir = path.join(base, src, 'messages');
      const taskDir = path.join(base, src, 'tasks');

      if (fs.existsSync(msgDir)) {
        for (const f of fs.readdirSync(msgDir).filter((x) => x.endsWith('.json'))) {
          const fp = path.join(msgDir, f);
          try {
            const d = JSON.parse(fs.readFileSync(fp, 'utf-8'));
            if (d.type === 'message' && d.chatJid && d.text) {
              const tgt = agent.groups[d.chatJid];
              if (isMain || (tgt && tgt.folder === src)) {
                await channel.send(d.chatJid, `${ASSISTANT_NAME}: ${d.text}`);
              }
            }
            fs.unlinkSync(fp);
          } catch {
            fs.mkdirSync(path.join(base, 'errors'), { recursive: true });
            fs.renameSync(fp, path.join(base, 'errors', `${src}-${f}`));
          }
        }
      }

      if (fs.existsSync(taskDir)) {
        for (const f of fs.readdirSync(taskDir).filter((x) => x.endsWith('.json'))) {
          const fp = path.join(taskDir, f);
          try {
            const d = JSON.parse(fs.readFileSync(fp, 'utf-8'));
            handleCommand(d, src, isMain, agent);
            fs.unlinkSync(fp);
          } catch {
            fs.mkdirSync(path.join(base, 'errors'), { recursive: true });
            fs.renameSync(fp, path.join(base, 'errors', `${src}-${f}`));
          }
        }
      }
    }
    setTimeout(poll, IPC_POLL_INTERVAL);
  };

  poll();
  logger.info('Container command watcher started');
}

function handleCommand(d: any, src: string, isMain: boolean, agent: Agent): void {
  switch (d.type) {
    case 'schedule_task': {
      if (!d.prompt || !d.schedule_type || !d.schedule_value || !d.targetJid) break;
      const tgt = agent.groups[d.targetJid];
      if (!tgt) break;
      if (!isMain && tgt.folder !== src) break;
      let next: string | null = null;
      if (d.schedule_type === 'cron') {
        try {
          next = CronExpressionParser.parse(d.schedule_value, { tz: TIMEZONE }).next().toISOString();
        } catch { break; }
      } else if (d.schedule_type === 'interval') {
        const ms = parseInt(d.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) break;
        next = new Date(Date.now() + ms).toISOString();
      } else if (d.schedule_type === 'once') {
        const dt = new Date(d.schedule_value);
        if (isNaN(dt.getTime())) break;
        next = dt.toISOString();
      }
      const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createTask({
        id, group_folder: tgt.folder, chat_jid: d.targetJid, prompt: d.prompt,
        schedule_type: d.schedule_type, schedule_value: d.schedule_value,
        context_mode: d.context_mode === 'group' ? 'group' : 'isolated',
        next_run: next, status: 'active', created_at: new Date().toISOString(),
      });
      break;
    }
    case 'pause_task': {
      const t = d.taskId && getTaskById(d.taskId);
      if (t && (isMain || t.group_folder === src)) updateTask(d.taskId, { status: 'paused' });
      break;
    }
    case 'resume_task': {
      const t = d.taskId && getTaskById(d.taskId);
      if (t && (isMain || t.group_folder === src)) updateTask(d.taskId, { status: 'active' });
      break;
    }
    case 'cancel_task': {
      const t = d.taskId && getTaskById(d.taskId);
      if (t && (isMain || t.group_folder === src)) deleteTask(d.taskId);
      break;
    }
    case 'refresh_groups': {
      if (isMain) writeGroupsSnapshot(src, true, agent.available(), new Set(Object.keys(agent.groups)));
      break;
    }
    case 'register_group': {
      if (isMain && d.jid && d.name && d.folder && d.trigger) {
        agent.register(d.jid, {
          name: d.name, folder: d.folder, trigger: d.trigger,
          added_at: new Date().toISOString(), containerConfig: d.containerConfig,
        });
      }
      break;
    }
  }
}
