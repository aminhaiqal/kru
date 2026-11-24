import { Store, resolveDatabasePath } from '../store';
import { WorkspaceRecords, ApprovalBroker } from '../workspace';

export function approvalCommand(args: string[]): number {
  let path: string | undefined,
    json = false;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db') {
      path = args[++i];
      if (!path || path.startsWith('--')) throw new Error('Expected database path');
    } else if (args[i] === '--json') json = true;
    else words.push(args[i]!);
  }
  if (words.includes('--help') || words.includes('-h')) {
    console.log(
      'Usage: kru approval list [--json] [--db <path>]\n       kru approval accept|decline <id> [--db <path>]',
    );
    return 0;
  }
  if (
    !['list', 'accept', 'decline'].includes(words[0] ?? 'list') ||
    words.length > (words[0] === 'list' ? 1 : 2)
  )
    throw new Error('Expected approval list or approval accept|decline <id>');
  const store = new Store(resolveDatabasePath(path));
  try {
    const records = new WorkspaceRecords(store);
    if (!words.length || words[0] === 'list') {
      const entries = records
        .list('approval')
        .filter(
          (entry) =>
            entry.data.status === 'pending' && Date.parse(entry.data.expiresAt) > Date.now(),
        );
      if (json) console.log(JSON.stringify(entries));
      else if (!entries.length) console.log('No pending approvals');
      else
        for (const entry of entries)
          console.log(
            `${entry.id} ${entry.data.kind} agent=${entry.agentId} expires=${entry.data.expiresAt}\n${JSON.stringify(entry.data.input, null, 2)}`,
          );
    } else {
      if (!words[1]) throw new Error('Expected approval id');
      const result = new ApprovalBroker(records).decide(
        words[1],
        words[0] === 'accept' ? 'accept' : 'decline',
      );
      console.log(`${result.id} ${result.data.status}`);
    }
    return 0;
  } finally {
    store.close();
  }
}
