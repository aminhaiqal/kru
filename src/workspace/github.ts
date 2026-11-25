import type { RecordEntry } from './records';

import { isGitHubConnector } from '../shared/github';

let savedToken: string | undefined;
export function setGitHubToken(token: string | undefined): () => void {
  const previous = savedToken;
  savedToken = token;
  return () => {
    savedToken = previous;
  };
}

export function githubAuthorization(entry: RecordEntry<'connector'>): string {
  if (!isGitHubConnector(entry))
    throw new Error('GitHub credentials require the official GitHub connector.');
  const token = savedToken || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token || !/^[A-Za-z0-9_]+$/.test(token) || token.length > 512)
    throw new Error('Connect GitHub and save a personal access token first.');
  return 'Bearer ' + token;
}
