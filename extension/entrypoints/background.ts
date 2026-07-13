import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/sandbox';
import { clearState, getState, setState } from '~/utils/storage';
import { checkPairing, getMe, keapApi, startPairing } from '~/utils/keap';

const MENU_SEARCH = 'keap-search-selection';
const MENU_CAPTURE_PAGE = 'keap-capture-page';
const MENU_CAPTURE_SELECTION = 'keap-capture-selection';
const MENU_CAPTURE_LINK = 'keap-capture-link';

export default defineBackground(() => {
  browser.contextMenus.removeAll().catch(() => null);
  browser.contextMenus.create({ id: MENU_SEARCH, title: 'KEAP: Search selection', contexts: ['selection'] });
  browser.contextMenus.create({ id: MENU_CAPTURE_PAGE, title: 'KEAP: Capture page', contexts: ['page'] });
  browser.contextMenus.create({ id: MENU_CAPTURE_SELECTION, title: 'KEAP: Capture selection', contexts: ['selection'] });
  browser.contextMenus.create({ id: MENU_CAPTURE_LINK, title: 'KEAP: Capture link', contexts: ['link'] });

  const actionApi = browser.action ?? browser.browserAction;
  actionApi.onClicked.addListener(async (tab) => {
    if (!tab?.id) return;
    try {
      await browser.tabs.sendMessage(tab.id, { type: 'TOGGLE' });
    } catch {
      // Tab may not have the content script running
    }
  });

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab?.id) return;
    let payload: Record<string, unknown> = { type: 'ACTION' };
    switch (info.menuItemId) {
      case MENU_SEARCH:
        payload = { type: 'SEARCH', query: info.selectionText };
        break;
      case MENU_CAPTURE_PAGE:
        payload = { type: 'CAPTURE_PAGE' };
        break;
      case MENU_CAPTURE_SELECTION:
        payload = { type: 'CAPTURE_SELECTION', query: info.selectionText };
        break;
      case MENU_CAPTURE_LINK:
        payload = { type: 'CAPTURE_LINK', url: info.linkUrl, linkText: info.linkText };
        break;
    }
    try {
      await browser.tabs.sendMessage(tab.id, payload);
    } catch {
      // Tab may not have the content script running
    }
  });

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && typeof message === 'object') {
      handleMessage(message as Record<string, unknown>)
        .then((data) => sendResponse({ success: true, data }))
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true;
    }
    return undefined;
  });
});

async function handleMessage(msg: Record<string, unknown>) {
  switch (msg.type) {
    case 'GET_STATE':
      return await getState();
    case 'SET_STATE': {
      const state = (msg.state as Record<string, unknown>) ?? {};
      return await setState(state as Partial<import('~/utils/storage').ExtensionState>);
    }
    case 'CLEAR_STATE':
      await clearState();
      return null;
    case 'API':
      return await keapApi(msg.method as string, msg.path as string, msg.body);
    case 'PAIRING_START':
      return await startPairing(msg.instanceUrl as string, (msg.clientName as string) ?? 'KEAP Companion');
    case 'PAIRING_CHECK': {
      const credential = await checkPairing(
        msg.instanceUrl as string,
        msg.pairingId as string,
        msg.deviceSecret as string,
      );
      try {
        await getMe();
      } catch {
        // ignore, user may not be available yet
      }
      return credential;
    }
    case 'OPEN_TAB': {
      await browser.tabs.create({ url: msg.url as string });
      return null;
    }
    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}
