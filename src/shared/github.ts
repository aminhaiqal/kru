export const githubUrl = 'https://api.githubcopilot.com/mcp/';
export const githubTokenReference = 'KRU_GITHUB_TOKEN';
export function connectorNeedsApproval(
  entry: Parameters<typeof isGitHubConnector>[0] & { data: { permission: string } },
): boolean {
  return !isGitHubConnector(entry) && entry.data.permission !== 'allow';
}
export function connectorAvailable(
  entry: {
    agentId: string | null;
    data: { enabled: boolean; transport: string; url: string; headers: Record<string, string> };
  },
  agentId: string,
): boolean {
  return entry.data.enabled && (isGitHubConnector(entry) || entry.agentId === agentId);
}
export function isGitHubConnector(entry: {
  data: { transport: string; url: string; headers: Record<string, string> };
}): boolean {
  return (
    entry.data.transport === 'http' &&
    entry.data.url === githubUrl &&
    entry.data.headers.Authorization === githubTokenReference
  );
}
