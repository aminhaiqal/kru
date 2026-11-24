import { api, post } from './api.js';
import { $, escape } from './dom.js';
import { check, field, openForm, showInfo } from './forms.js';
import {
  browserAddIcon,
  browserBackIcon,
  browserCloseIcon,
  browserCollapseIcon,
  browserExpandIcon,
  browserForwardIcon,
  browserReloadIcon,
  browserStopIcon,
  chatGlobeIcon,
  chatUploadIcon,
} from './icons.js';
import { S } from './state.js';

('use strict');
const BP = {
  open: false,
  expanded: false,
  agent: null,
  status: null,
  states: new Map(),
  observed: new Map(),
  starting: false,
  busy: false,
  tabSignature: '',
  layoutSignature: '',
  layoutFrame: null,
  resize: null,
};
const browserButton = (action, label, icon) =>
  `<button type="button" data-browser-action="${action}" aria-label="${label}" title="${label}">${icon}</button>`;
function browserPanelLayout() {
  const visible = BP.open && S.view === 'chat' && BP.agent === S.agent;
  $('#browser-panel').hidden = !visible;
  $('.workspace-body').classList.toggle('browser-panel-open', visible);
  $('.workspace-body').classList.toggle('browser-panel-expanded', visible && BP.expanded);
  $('.conversation-browser')?.setAttribute('aria-pressed', String(visible));
  if (!BP.layoutFrame)
    BP.layoutFrame = requestAnimationFrame(() => {
      BP.layoutFrame = null;
      const surface = $('#browser-native-surface'),
        box = surface?.getBoundingClientRect(),
        covered = !!$(
          'dialog[open], .workspace.menu-open, .conversation-sidebar.open, .chat-attach-menu, #theme-menu:popover-open',
        );
      const input = {
        agentId: BP.agent,
        visible: !!(
          visible &&
          !covered &&
          BP.status?.running &&
          BP.status.url &&
          BP.status.url !== 'about:blank' &&
          box?.width &&
          box?.height
        ),
        bounds: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
      };
      const signature = JSON.stringify(input);
      if (signature !== BP.layoutSignature) {
        BP.layoutSignature = signature;
        window.kruBrowser?.layout(input);
      }
    });
}
function browserPanelMount() {
  BP.tabSignature = '';
  BP.resize?.disconnect();
  $('#browser-panel').innerHTML =
    `<header class="browser-panel-heading"><span>${chatGlobeIcon}<strong>Browser</strong><small>Chromium</small></span><div>${browserButton('import', 'Import browser data', chatUploadIcon)}${browserButton('expand', 'Expand browser', browserExpandIcon)}${browserButton('close', 'Close browser panel', browserCloseIcon)}</div></header><div id="browser-tabs" class="browser-panel-tabs" role="tablist" aria-label="Browser tabs"></div><form id="browser-navigate" class="browser-address-bar"><div>${browserButton('back', 'Go back', browserBackIcon)}${browserButton('forward', 'Go forward', browserForwardIcon)}${browserButton('reload', 'Reload page', browserReloadIcon)}</div><input id="browser-url" type="text" aria-label="Browser address" placeholder="Search or enter a URL" autocomplete="off" spellcheck="false"><button type="submit" aria-label="Navigate" title="Navigate">${browserForwardIcon}</button></form><div id="browser-challenge" class="browser-panel-challenge" hidden><span>This site needs your verification. Complete it below, then ask the assistant to continue.</span><button data-browser-action="read">Recheck</button></div><div id="browser-native-surface" class="browser-native-surface"><div id="browser-panel-empty" class="browser-panel-empty">${chatGlobeIcon}<strong>Your browser, alongside the conversation</strong><p>${window.kruBrowser ? 'Search or open a page. Click, type and browse directly.' : 'Open KRU desktop to use its native browser.'}</p>${browserButton('import', 'Import browser data', chatUploadIcon)}</div></div><p id="browser-panel-error" class="browser-panel-error" role="status" hidden></p><footer class="browser-panel-footer"><span id="browser-panel-activity" role="status">Browser ready</span><div>${browserButton('retry', 'Start browser', browserReloadIcon)}${browserButton('stop', 'Stop browser', browserStopIcon)}</div></footer>`;
  BP.resize = new ResizeObserver(browserPanelLayout);
  BP.resize.observe($('#browser-native-surface'));
}
function browserPanelClose() {
  BP.open = false;
  BP.expanded = false;
  browserPanelLayout();
  BP.resize?.disconnect();
  $('#browser-panel').innerHTML = '';
  $('.conversation-browser')?.focus();
}
async function browserPanelOpen(agentId, start = true) {
  if (!agentId) return;
  if (!BP.open || BP.agent !== agentId) {
    BP.agent = agentId;
    BP.open = true;
    BP.status = BP.states.get(agentId) || S.state?.browsers?.[agentId] || null;
    browserPanelMount();
  }
  browserPanelLayout();
  if (!start || BP.starting || !window.kruBrowser) return;
  BP.starting = true;
  browserPanelError('');
  try {
    const state = await post('/agents/' + agentId + '/browser/start');
    if (BP.agent === agentId) browserPanelUpdate(state);
  } catch (error) {
    browserPanelError(error.message);
  } finally {
    BP.starting = false;
  }
}
function browserPanelError(message) {
  const el = $('#browser-panel-error');
  if (el) {
    el.textContent = message;
    el.hidden = !message;
  }
}
function browserPanelUpdate(state) {
  BP.status = state;
  const activity = $('#browser-panel-activity');
  if (!activity) return;
  activity.textContent = state.activity;
  activity.classList.toggle('working', state.busy);
  const address = $('#browser-url');
  if (document.activeElement !== address)
    address.value = state.url === 'about:blank' ? '' : state.url || '';
  const signature = JSON.stringify(state.tabs);
  if (signature !== BP.tabSignature) {
    $('#browser-tabs').innerHTML =
      state.tabs
        .map(
          (tab) =>
            `<div class="browser-panel-tab ${tab.active ? 'active' : ''}"><button type="button" role="tab" aria-selected="${tab.active}" data-browser-action="switch_tab" data-tab="${tab.id}" title="${escape(tab.title)}">${chatGlobeIcon}<span>${escape(tab.title)}</span></button><button type="button" data-browser-action="close_tab" data-tab="${tab.id}" aria-label="Close ${escape(tab.title)} tab">${browserCloseIcon}</button></div>`,
        )
        .join('') + browserButton('new_tab', 'New browser tab', browserAddIcon);
    BP.tabSignature = signature;
  }
  $('#browser-challenge').hidden = !state.challenge;
  $('#browser-panel-empty').hidden = !!(state.running && state.url && state.url !== 'about:blank');
  browserPanelLayout();
}
function browserPanelInit() {
  $('#theme-menu')?.addEventListener('toggle', browserPanelLayout);
  window.kruBrowser?.onState(({ agentId, state }) => {
    BP.states.set(agentId, state);
    const previous = BP.observed.get(agentId) || 0;
    BP.observed.set(agentId, state.activityId);
    if (S.view === 'chat' && S.agent === agentId) {
      if ((!BP.open || BP.agent !== agentId) && state.running && state.activityId > previous)
        void browserPanelOpen(agentId, false);
      if (BP.open && BP.agent === agentId) browserPanelUpdate(state);
    }
  });
  new MutationObserver(() => {
    if (BP.open) browserPanelLayout();
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['open', 'class'],
  });
}
async function browserPanelAction(action, tabId) {
  if (BP.busy || !BP.agent) return;
  BP.busy = true;
  browserPanelError('');
  try {
    if (action === 'stop') await post('/agents/' + BP.agent + '/browser/stop');
    else
      await post('/agents/' + BP.agent + '/browser/action', {
        action,
        ...(tabId ? { tabId } : {}),
      });
  } catch (error) {
    browserPanelError(error.message);
  } finally {
    BP.busy = false;
  }
}
function browserImportResult(result) {
  if (result.cancelled) return;
  showInfo(
    result.imported || result.cacheBytes ? 'Browser data imported' : 'Browser import result',
    `<p>${result.imported} cookies imported${result.skipped ? ' · ' + result.skipped + ' skipped' : ''}.</p>${result.cacheBytes ? `<p>${(result.cacheBytes / 1024 / 1024).toFixed(1)} MB of cache staged.</p>` : ''}${result.restartRequired ? '<p>Restart KRU to activate the imported cache.</p>' : ''}${(result.notes || []).map((note) => `<p class="help">${escape(note)}</p>`).join('')}<p class="help">Your source browser was left unchanged. Imported sign-ins stay in this KRU browser profile.</p>`,
  );
}
async function browserPanelImport() {
  showInfo(
    'Import browser data',
    '<p class="help">Looking for browser profiles on this computer…</p>',
  );
  try {
    const sources = await api('/agents/' + BP.agent + '/browser/import');
    BP.importSources = sources;
    const intro =
      '<p class="help">Choose a profile to import. Cookies are private account data. Encrypted cookies are read by the source browser and may require an OS permission prompt. Cache activates after restarting KRU.</p>';
    if (!sources.length) {
      showInfo(
        'Import browser data',
        intro +
          '<p>No supported profiles found. You can import an exported JSON cookies array or Netscape cookies.txt.</p><button data-browser-action="import-file">Choose cookies file…</button>',
      );
      return;
    }
    openForm(
      'Import browser data',
      intro +
        field('Browser profile', 'sourceId', sources[0].id, {
          options: sources.map((source) => [source.id, source.name]),
        }) +
        check('Import cookies and sign-ins', 'importCookies', true) +
        check('Import compatible Chromium cache', 'importCache', sources[0].cache) +
        '<p id="browser-import-note" class="help">' +
        escape(sources[0].note) +
        '</p><button type="button" class="quiet" data-browser-action="import-file">Choose cookies file instead…</button>',
      async (form) => {
        const result = await post('/agents/' + BP.agent + '/browser/import', {
          sourceId: form.get('sourceId'),
          cookies: form.has('importCookies'),
          cache: form.has('importCache'),
        });
        setTimeout(() => browserImportResult(result), 0);
      },
      'Import',
    );
    const cache = $('[name="importCache"]');
    cache.disabled = !sources[0].cache;
  } catch (error) {
    showInfo('Import browser data', `<p class="form-error">${escape(error.message)}</p>`);
  }
}
document.addEventListener('change', (event) => {
  if (event.target.name === 'sourceId') {
    const source = BP.importSources?.find((source) => source.id === event.target.value);
    if (source) {
      $('[name="importCache"]').disabled = !source.cache;
      $('[name="importCache"]').checked = source.cache;
      $('#browser-import-note').textContent = source.note;
    }
  }
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-browser-action]');
  if (!button) return;
  const action = button.dataset.browserAction;
  if (action === 'close') {
    browserPanelClose();
    return;
  }
  if (action === 'expand') {
    BP.expanded = !BP.expanded;
    browserPanelLayout();
    button.innerHTML = BP.expanded ? browserCollapseIcon : browserExpandIcon;
    button.setAttribute('aria-label', BP.expanded ? 'Restore browser panel' : 'Expand browser');
    button.title = button.getAttribute('aria-label');
    return;
  }
  if (action === 'import') {
    await browserPanelImport();
    return;
  }
  if (action === 'import-file') {
    try {
      const result = await post('/agents/' + BP.agent + '/browser/import-file');
      browserImportResult(result);
    } catch (error) {
      browserPanelError(error.message);
    }
    return;
  }
  if (action === 'retry') {
    await browserPanelOpen(BP.agent);
    return;
  }
  await browserPanelAction(action, button.dataset.tab);
});
document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'browser-navigate') return;
  event.preventDefault();
  const raw = $('#browser-url').value.trim();
  if (!raw || BP.busy) return;
  let action;
  if (
    !/\s/.test(raw) &&
    (/^https?:\/\//i.test(raw) || raw.includes('.') || /^localhost(?::\d+)?(?:\/|$)/i.test(raw))
  )
    action = { action: 'navigate', url: /^https?:\/\//i.test(raw) ? raw : 'https://' + raw };
  else action = { action: 'search', query: raw };
  BP.busy = true;
  browserPanelError('');
  try {
    await post('/agents/' + BP.agent + '/browser/action', action);
  } catch (error) {
    browserPanelError(error.message);
  } finally {
    BP.busy = false;
  }
});

export { browserPanelInit, browserPanelLayout, browserPanelOpen };
