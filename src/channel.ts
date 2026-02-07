import { Agent } from './agent.js';
import { watchCommands } from './container.js';

export abstract class Channel {
  agent: Agent;

  constructor(agent: Agent) {
    this.agent = agent;
  }

  abstract connect(onReady: () => void): Promise<void>;
  abstract send(jid: string, text: string): Promise<void>;
  abstract typing(jid: string): Promise<void>;
  abstract close(): Promise<void>;

  start(onLoop: () => void): void {
    this.connect(() => {
      this.agent.startScheduler(this);
      watchCommands(this.agent, this);
      this.agent.queue.setProcessMessagesFn((jid) => this.agent.process(this, jid));
      this.agent.recover();
      onLoop();
    });
  }

  async shutdown(): Promise<void> {
    await this.close();
    await this.agent.queue.shutdown(10000);
  }
}
