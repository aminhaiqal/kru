import { resolve } from 'node:path';
import { Store, initializeDatabasePath, resolveDatabasePath } from '../store';
import { AgentRegistry } from '../agents';
import { SqliteMailbox } from '../mailbox';

export const mailboxUsage = `Usage: kru init [--db <path>]
       kru agent create <name> --provider fake|codex|claude [--cwd <path>]
       kru agent list
       kru send <agent[,agent...]> <text> [--lane <id>] [--reply-to <message>] [--expects-reply] [--idempotency-key <key>]
       kru queue <agent> [--lane <id> | --main]
       kru cancel <delivery>
       kru retry <delivery>
Mailbox commands accept --db <path> or KRU_DB; otherwise find the nearest ancestor .kru/.
Run kru init once in your project to create the mailbox.
Use -- before literal text beginning with a dash.`;

export function mailboxCommand(args: string[]): number {
  const separator = args.indexOf('--');
  const optionArgs = separator < 0 ? args : args.slice(0, separator);
  if (optionArgs.includes('--help') || optionArgs.includes('-h')) { console.log(mailboxUsage); return 0; }
  const words: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const command = args[0];
  const valid = new Set(command === 'agent' ? ['--db', '--provider', '--cwd']
    : command === 'send' ? ['--db', '--lane', '--reply-to', '--idempotency-key']
    : command === 'queue' ? ['--db', '--lane'] : ['--db']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { words.push(...args.slice(i + 1)); break; }
    if ((command === 'send' && arg === '--expects-reply') || (command === 'queue' && arg === '--main')) {
      if (flags.has(arg)) throw new Error(`Repeated option: ${arg}`);
      flags.add(arg);
    } else if (arg.startsWith('--')) {
      if (!valid.has(arg)) throw new Error(`Unknown option: ${arg}`);
      if (options.has(arg)) throw new Error(`Repeated option: ${arg}`);
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options.set(arg, value);
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else words.push(arg);
  }
  if (flags.has('--main') && options.has('--lane')) throw new Error('Choose --main or --lane');
  if (command === 'init') {
    if (words.length !== 1) throw new Error(mailboxUsage);
  } else if (command === 'agent') {
    if (words[1] === 'create' && words.length === 3) {
      if (!['fake', 'codex', 'claude'].includes(options.get('--provider') ?? '')) throw new Error('Expected --provider fake|codex|claude');
    } else if (words[1] !== 'list' || words.length !== 2 || options.has('--provider') || options.has('--cwd')) throw new Error(mailboxUsage);
  } else if (command === 'send' ? words.length < 3 : words.length !== 2) throw new Error(mailboxUsage);

  const path = command === 'init' ? initializeDatabasePath(options.get('--db')) : resolveDatabasePath(options.get('--db'));
  const store = new Store(path);
  try {
    if (command === 'init') { console.log(`initialized Kru mailbox ${path}`); return 0; }
    const agents = new AgentRegistry(store);
    const mailbox = new SqliteMailbox(store);
    const agentId = (name: string) => {
      const agent = agents.resolve(name);
      if (!agent) throw new Error(`Unknown agent: ${name}`);
      return agent.id;
    };
    if (command === 'agent') {
      if (words[1] === 'create') {
        const agent = agents.create({ name: words[2]!, provider: options.get('--provider')!,
          config: { cwd: resolve(options.get('--cwd') ?? process.cwd()) } });
        console.log(`created agent ${agent.name} ${agent.id} provider=${agent.provider}`);
      } else {
        for (const agent of agents.list()) console.log(`${agent.id} ${JSON.stringify(agent.name)} ${agent.provider}`);
      }
    } else if (command === 'send') {
      const receipt = mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: words[1]!.split(',').map(agentId),
        text: words.slice(2).join(' '), laneId: options.get('--lane') ?? null, replyTo: options.get('--reply-to') ?? null,
        expectsReply: flags.has('--expects-reply'),
        ...(options.has('--idempotency-key') ? { idempotencyKey: options.get('--idempotency-key')! } : {}) });
      console.log(`${receipt.duplicate ? 'duplicate' : 'queued'} message ${receipt.messageId} delivery ${receipt.deliveryIds.join(',')}`);
    } else if (command === 'queue') {
      const lane = flags.has('--main') ? null : options.get('--lane');
      for (const delivery of mailbox.listQueue(agentId(words[1]!), lane)) {
        console.log(`${delivery.id} ${delivery.status} ${delivery.sender.kind} ${JSON.stringify(delivery.text)}`);
      }
    } else if (command === 'cancel') {
      mailbox.cancel(words[1]!);
      console.log(`cancelled delivery ${words[1]}`);
    } else if (command === 'retry') {
      const receipt = mailbox.retry(words[1]!);
      console.log(`queued message ${receipt.messageId} delivery ${receipt.deliveryIds.join(',')}`);
    } else throw new Error(mailboxUsage);
    return 0;
  } finally { store.close(); }
}
