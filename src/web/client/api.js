import { token } from './state.js';
async function api(path, options = {}) {
  const response = await fetch('/api' + path, {
    ...options,
    headers: {
      'x-kru-token': token,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body });
const patch = (path, body) => api(path, { method: 'PATCH', body });

export { api, post, patch };
