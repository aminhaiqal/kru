if (document.querySelector('meta[name="kru-desktop"]')?.content === 'true')
  document.documentElement.classList.add('is-desktop');
const token = document.querySelector('meta[name="kru-token"]').content;
const S = {
  state: null,
  agent: localStorage.getItem('kru-agent') || '',
  view: document.documentElement.classList.contains('is-desktop') ? 'chat' : 'work',
  lane: localStorage.getItem('kru-lane') || null,
  scope: '',
  connectorChecks: new Set(),
  messages: null,
  draft: '',
  sending: false,
  refreshing: false,
  refreshAgain: false,
};
const current = () =>
  S.state?.agents.find((a) => a.id === S.agent) ||
  (S.state?.personal?.id === S.agent ? S.state.personal : null);
const connection = (id) => S.state?.providers?.find((p) => p.id === id);
const providerConnected = (id) => id === 'fake' || connection(id)?.status === 'connected';
const connectionLabel = (id) =>
  id === 'fake'
    ? 'Demo'
    : {
        connected: 'Connected',
        not_connected: 'Not connected',
        not_installed: 'Not installed',
        checking: 'Checking',
        error: 'Needs attention',
      }[connection(id)?.status] || 'Checking';
const name = (id) =>
  S.state?.agents.find((a) => a.id === id)?.name ||
  (S.state?.personal?.id === id ? 'Personal chat' : 'Unknown teammate');
const records = (kind) => S.state?.records[kind] || [];
const approvalPending = (entry) =>
  entry.data.status === 'pending' && Date.parse(entry.data.expiresAt) > Date.now();
const pendingApprovals = () => records('approval').filter(approvalPending);

export {
  S,
  approvalPending,
  connection,
  connectionLabel,
  current,
  name,
  pendingApprovals,
  providerConnected,
  records,
  token,
};
