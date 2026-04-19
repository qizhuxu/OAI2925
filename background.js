// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts('data/names.js');
importScripts('lib/hotmail-manager.js');
importScripts('lib/apple-api.js');

const LOG_PREFIX = '[MultiPage:bg]';
const LOCAL_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const LOCAL_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';

// ============================================================
// State Management (chrome.storage.session)
// ============================================================

const DEFAULT_STATE = {
  currentStep: 0,
  stepStatuses: {
    1: 'pending', 2: 'pending', 3: 'pending', 4: 'pending', 5: 'pending',
    6: 'pending', 7: 'pending', 8: 'pending', 9: 'pending',
  },
  oauthUrl: null,
  email: null,
  password: null,
  accounts: [], // { email, password, createdAt }
  lastEmailTimestamp: null,
  signupVerificationCode: null,
  localhostUrl: null,
  flowStartTime: null,
  incognitoWindowId: null,
  tabRegistry: {},
  logs: [],
  vpsUrl: '',
  emailPrefix: '', // 2925 邮箱前缀
  defaultPassword: '', // 默认密码（留空则随机生成）
  oauthCodeVerifier: null,
  oauthState: null,
  manualIntervention: null,
  saveToLocal: false,
  localSavePath: '',
  incognitoMode: false,
  localMode: false,
  cpaManagementKey: '', // CPA 管理密钥
  signupEntry: 'oauth', // 注册入口：oauth 或 chatgpt
};

async function getState() {
  console.log(LOG_PREFIX, 'getState 被调用');
  const state = await chrome.storage.session.get(null);
  console.log(LOG_PREFIX, 'getState 从 storage 获取:', Object.keys(state));
  const result = { ...DEFAULT_STATE, ...state };
  console.log(LOG_PREFIX, 'getState 返回:', Object.keys(result));
  return result;
}

async function setState(updates) {
  console.log(LOG_PREFIX, 'storage.set:', JSON.stringify(updates).slice(0, 200));
  await chrome.storage.session.set(updates);
}

async function resetState() {
  console.log(LOG_PREFIX, 'Resetting all state');
  // Close incognito window if still open
  await closeIncognitoWindow();
  
  // Preserve settings and persistent data across resets
  const prev = await chrome.storage.session.get(['seenCodes', 'accounts', 'tabRegistry', 'vpsUrl', 'emailPrefix', 'defaultPassword', 'cpaManagementKey', 'signupEntry']);
  await chrome.storage.session.clear();
  await chrome.storage.session.set({
    ...DEFAULT_STATE,
    seenCodes: prev.seenCodes || [],
    accounts: prev.accounts || [],
    tabRegistry: prev.tabRegistry || {},
    vpsUrl: prev.vpsUrl || '',
    emailPrefix: prev.emailPrefix || '',
    defaultPassword: prev.defaultPassword || '',
    cpaManagementKey: prev.cpaManagementKey || '',
    signupEntry: prev.signupEntry || 'oauth',
  });
}

/**
 * Generate a random password: 14 chars, mix of uppercase, lowercase, digits, symbols.
 */
function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*?';
  const all = upper + lower + digits + symbols;

  // Ensure at least one of each type
  let pw = '';
  pw += upper[Math.floor(Math.random() * upper.length)];
  pw += lower[Math.floor(Math.random() * lower.length)];
  pw += digits[Math.floor(Math.random() * digits.length)];
  pw += symbols[Math.floor(Math.random() * symbols.length)];

  // Fill remaining 10 chars
  for (let i = 0; i < 10; i++) {
    pw += all[Math.floor(Math.random() * all.length)];
  }

  // Shuffle
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

/**
 * Get password: use default password if set, otherwise generate random
 */
async function getPassword() {
  const state = await getState();
  
  // 如果设置了默认密码，使用默认密码
  if (state.defaultPassword && state.defaultPassword.trim()) {
    await addLog('Using default password', 'info');
    return state.defaultPassword.trim();
  }
  
  // 否则生成随机密码
  await addLog('Generating random password', 'info');
  return generatePassword();
}

function base64UrlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function buildLocalOAuthUrl() {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const codeVerifier = base64UrlEncode(verifierBytes);

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64UrlEncode(new Uint8Array(digest));
  const state = randomHex(16);

  const params = new URLSearchParams({
    client_id: LOCAL_OAUTH_CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    codex_cli_simplified_flow: 'true',
    id_token_add_organizations: 'true',
    prompt: 'login',
    redirect_uri: LOCAL_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile offline_access',
    state,
  });

  return {
    oauthUrl: `https://auth.openai.com/oauth/authorize?${params.toString()}`,
    codeVerifier,
    state,
  };
}

function parseCallbackFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return {
      code: u.searchParams.get('code') || '',
      state: u.searchParams.get('state') || '',
      error: u.searchParams.get('error') || '',
    };
  } catch {
    return null;
  }
}

function getExpectedRedirectFromOAuthUrl(oauthUrl) {
  try {
    const u = new URL(oauthUrl || '');
    const redirectUri = u.searchParams.get('redirect_uri');
    if (!redirectUri) return null;
    const r = new URL(redirectUri);
    return {
      protocol: r.protocol,
      hostname: (r.hostname || '').toLowerCase(),
      port: r.port || '',
      pathname: r.pathname || '/',
      href: r.href,
    };
  } catch {
    return null;
  }
}

function isIpv4Host(hostname) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname || '');
}

function isIpv6Host(hostname) {
  return (hostname || '').includes(':');
}

function isLikelyLocalOrIpHost(hostname) {
  const h = (hostname || '').toLowerCase();
  return h === 'localhost' || h === '0.0.0.0' || isIpv4Host(h) || isIpv6Host(h);
}

function isExpectedOAuthCallbackUrl(rawUrl, expectedRedirect) {
  let u;
  try {
    u = new URL(rawUrl || '');
  } catch {
    return false;
  }

  const hasAuthSignal = u.searchParams.has('code') || u.searchParams.has('error');
  if (!hasAuthSignal) return false;

  // Prefer exact redirect_uri host/path from step 1 OAuth URL.
  if (expectedRedirect && expectedRedirect.hostname) {
    if (u.hostname.toLowerCase() !== expectedRedirect.hostname.toLowerCase()) return false;
    if ((expectedRedirect.pathname || '/') !== (u.pathname || '/')) return false;
    if (expectedRedirect.port && u.port !== expectedRedirect.port) return false;
    return true;
  }

  // Fallback for historical flows: localhost / any IP host + callback-like path.
  if (!isLikelyLocalOrIpHost(u.hostname)) return false;
  return /callback/i.test(u.pathname || '/');
}

async function exchangeTokenWithOpenAI(code, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: LOCAL_OAUTH_REDIRECT_URI,
    client_id: LOCAL_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
  }).toString();

  const resp = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Token exchange failed ${resp.status}: ${txt}`);
  }

  return resp.json();
}

function parseJwtPayload(token) {
  if (!token || token.split('.').length < 2) return {};
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return {};
  }
}

function toPseudoPlus8ISOString(date) {
  // Keep backward compatibility with existing token file format expectations.
  return date.toISOString().replace(/\.\d{3}Z$/, '+08:00');
}

function buildCodexTokenFile(tokens) {
  const accessPayload = parseJwtPayload(tokens.access_token || '');
  const idPayload = parseJwtPayload(tokens.id_token || '');
  const apiAuth = accessPayload['https://api.openai.com/auth'] || {};
  const accountId = apiAuth.chatgpt_account_id || '';
  const email = idPayload.email || '';

  const now = new Date();
  const expiredAt = new Date(now.getTime() + (tokens.expires_in || 3600) * 1000);

  return {
    access_token: tokens.access_token || '',
    account_id: accountId,
    disabled: false,
    email,
    expired: toPseudoPlus8ISOString(expiredAt),
    id_token: tokens.id_token || '',
    last_refresh: toPseudoPlus8ISOString(now),
    refresh_token: tokens.refresh_token || '',
    type: 'codex',
  };
}

// ============================================================
// Incognito Window Management
// ============================================================

async function createIncognitoTab(source, url) {
  // Check if extension is allowed in incognito mode
  const allowed = await chrome.extension.isAllowedIncognitoAccess();
  if (!allowed) {
    throw new Error('Extension not allowed in incognito mode. Please enable it in chrome://extensions → Details → "Allow in Incognito".');
  }

  // Close existing incognito window if any
  await closeIncognitoWindow();

  // Create new incognito window
  const win = await chrome.windows.create({ url, incognito: true });
  const tab = win.tabs[0];

  await setState({ incognitoWindowId: win.id });

  // Register the tab under the given source
  const registry = await getTabRegistry();
  registry[source] = { tabId: tab.id, ready: false };
  await setState({ tabRegistry: registry });

  console.log(LOG_PREFIX, `Created incognito window ${win.id}, tab ${source} (${tab.id})`);

  // Wait for page load
  await new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });

  await new Promise(r => setTimeout(r, 500));
  return tab.id;
}

async function closeIncognitoWindow() {
  const state = await getState();
  if (state.incognitoWindowId) {
    try {
      await chrome.windows.remove(state.incognitoWindowId);
      console.log(LOG_PREFIX, `Closed incognito window ${state.incognitoWindowId}`);
    } catch {
      // Window already closed — ignore
    }
    await setState({ incognitoWindowId: null });
  }
}

// ============================================================
// Tab Registry
// ============================================================

async function getTabRegistry() {
  const state = await getState();
  return state.tabRegistry || {};
}

async function registerTab(source, tabId) {
  const registry = await getTabRegistry();
  registry[source] = { tabId, ready: true };
  await setState({ tabRegistry: registry });
  console.log(LOG_PREFIX, `Tab registered: ${source} -> ${tabId}`);
  
  // 检查是否需要重新执行 Step 3（页面重新加载后）
  if (source === 'signup-page') {
    const state = await getState();
    if (state.step3NeedsRetry && state.currentStep === 3) {
      await addLog('Page reloaded, retrying Step 3...', 'info');
      await setState({ step3NeedsRetry: false });
      
      // 等待一下让页面完全加载
      await sleepRandom(1000, 1500);
      
      // 重新执行 Step 3
      try {
        await sendToContentScript('signup-page', {
          type: 'EXECUTE_STEP',
          step: 3,
          source: 'background',
          payload: { email: state.email, password: state.password },
        });
      } catch (err) {
        await addLog(`Failed to retry Step 3: ${err.message}`, 'error');
        await setStepStatus(3, 'failed');
        notifyStepError(3, err.message);
      }
    }
  }
}

async function isTabAlive(source) {
  const registry = await getTabRegistry();
  const entry = registry[source];
  if (!entry) return false;
  try {
    await chrome.tabs.get(entry.tabId);
    return true;
  } catch {
    // Tab no longer exists — clean up registry
    registry[source] = null;
    await setState({ tabRegistry: registry });
    return false;
  }
}

async function getTabId(source) {
  const registry = await getTabRegistry();
  return registry[source]?.tabId || null;
}

// ============================================================
// Command Queue (for content scripts not yet ready)
// ============================================================

const pendingCommands = new Map(); // source -> { message, resolve, reject, timer }

function clearPendingCommands() {
  for (const [source, pending] of pendingCommands.entries()) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Command cancelled - new flow starting'));
  }
  pendingCommands.clear();
  console.log(LOG_PREFIX, 'Cleared all pending commands');
}

function queueCommand(source, message, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(source);
      const err = `Content script on ${source} did not respond in ${timeout / 1000}s. Try refreshing the tab and retry.`;
      console.error(LOG_PREFIX, err);
      reject(new Error(err));
    }, timeout);
    pendingCommands.set(source, { message, resolve, reject, timer });
    console.log(LOG_PREFIX, `Command queued for ${source} (waiting for ready)`);
  });
}

function flushCommand(source, tabId) {
  const pending = pendingCommands.get(source);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCommands.delete(source);
    chrome.tabs.sendMessage(tabId, pending.message).then(pending.resolve).catch(pending.reject);
    console.log(LOG_PREFIX, `Flushed queued command to ${source} (tab ${tabId})`);
  }
}

// ============================================================
// Reuse or create tab
// ============================================================

async function reuseOrCreateTab(source, url, options = {}) {
  const alive = await isTabAlive(source);
  if (alive) {
    const tabId = await getTabId(source);
    const currentTab = await chrome.tabs.get(tabId);
    const sameUrl = currentTab.url === url;
    const shouldReloadOnReuse = sameUrl && options.reloadIfSameUrl;

    const registry = await getTabRegistry();
    
    if (sameUrl) {
      await chrome.tabs.update(tabId, { active: true });
      console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}) on same URL`);

      // 如果需要强制刷新（用于 CPA 面板获取最新 OAuth 链接）
      if (shouldReloadOnReuse) {
        if (registry[source]) registry[source].ready = false;
        await setState({ tabRegistry: registry });
        await chrome.tabs.reload(tabId);
        console.log(LOG_PREFIX, `Force reloaded tab ${source} (${tabId})`);

        // 等待页面重新加载完成
        await new Promise((resolve) => {
          const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
          const listener = (tid, info) => {
            if (tid === tabId && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              clearTimeout(timer);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
        });
      }

      // 对于动态注入的页面（如 VPS 面板），立即重新注入
      if (options.inject) {
        if (registry[source]) registry[source].ready = false;
        await setState({ tabRegistry: registry });
        await chrome.scripting.executeScript({
          target: { tabId },
          files: options.inject,
        });
        await new Promise(r => setTimeout(r, 500));
      }

      return tabId;
    }

    // Mark as not ready BEFORE navigating — so READY signal from new page is captured correctly
    if (registry[source]) registry[source].ready = false;
    await setState({ tabRegistry: registry });

    // Navigate existing tab to new URL
    await chrome.tabs.update(tabId, { url, active: true });
    console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}), navigated to ${url.slice(0, 60)}`);

    // Wait for page load complete (with 30s timeout)
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    // If dynamic injection needed (VPS panel), re-inject after navigation
    if (options.inject) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: options.inject,
      });
    }

    // Wait a bit for content script to inject and send READY
    await sleepRandom(1200, 2200);

    return tabId;
  }

  // Create new tab in a normal (non-incognito) window
  // Get all normal windows
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const normalWindows = windows.filter(w => !w.incognito);
  
  let windowId;
  if (normalWindows.length > 0) {
    // Use the first normal window
    windowId = normalWindows[0].id;
  } else {
    // No normal window exists, create one
    const newWindow = await chrome.windows.create({ url, focused: true });
    console.log(LOG_PREFIX, `Created new normal window ${newWindow.id} with tab ${source} (${newWindow.tabs[0].id})`);
    const tab = newWindow.tabs[0];
    
    // Wait for page load
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    
    if (options.inject) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: options.inject,
      });
    }
    
    await sleepRandom(1200, 2200);
    return tab.id;
  }
  
  // Create tab in the normal window
  const tab = await chrome.tabs.create({ url, active: true, windowId });
  console.log(LOG_PREFIX, `Created new tab ${source} (${tab.id}) in normal window ${windowId}`);

  // Wait for page load complete (with 30s timeout)
  await new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });

  // If dynamic injection needed (VPS panel), inject scripts after load
  if (options.inject) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: options.inject,
    });
  }
  
  // Wait a bit for content script to inject and send READY
  await sleepRandom(1200, 2200);

  return tab.id;
}

// ============================================================
// Send command to content script (with readiness check)
// ============================================================

async function sendToContentScript(source, message) {
  const registry = await getTabRegistry();
  const entry = registry[source];

  if (!entry || !entry.ready) {
    console.log(LOG_PREFIX, `${source} not ready, queuing command`);
    return queueCommand(source, message);
  }

  // Verify tab is still alive
  const alive = await isTabAlive(source);
  if (!alive) {
    // Tab was closed — queue the command, it will be sent when tab is reopened
    console.log(LOG_PREFIX, `${source} tab was closed, queuing command`);
    return queueCommand(source, message);
  }

  console.log(LOG_PREFIX, `Sending to ${source} (tab ${entry.tabId}):`, message.type);
  return chrome.tabs.sendMessage(entry.tabId, message);
}

async function clickWithDebugger(tabId, rect) {
  if (!tabId) {
    throw new Error('No auth tab found for debugger click.');
  }
  
  // 添加详细的调试日志
  console.log(LOG_PREFIX, 'clickWithDebugger called with:', { tabId, rect });
  
  if (!rect) {
    throw new Error('Step 8 debugger fallback: rect is null or undefined.');
  }
  
  if (!Number.isFinite(rect.centerX) || !Number.isFinite(rect.centerY)) {
    throw new Error(
      `Step 8 debugger fallback needs a valid button position. ` +
      `Received: centerX=${rect.centerX}, centerY=${rect.centerY}, ` +
      `rect=${JSON.stringify(rect)}`
    );
  }

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
    await addLog(`Step 8: Debugger attached to tab ${tabId}`);
  } catch (err) {
    throw new Error(
      `Debugger attach failed during step 8 fallback: ${err.message}. ` +
      'If DevTools is open on the auth tab, close it and retry.'
    );
  }

  try {
    const x = Math.round(rect.centerX);
    const y = Math.round(rect.centerY);
    
    await addLog(`Step 8: Clicking at coordinates (${x}, ${y})`);

    await chrome.debugger.sendCommand(target, 'Page.bringToFront');
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    
    await addLog(`Step 8: Debugger click completed at (${x}, ${y})`);
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

// ============================================================
// Logging
// ============================================================

async function addLog(message, level = 'info') {
  const state = await getState();
  const logs = state.logs || [];
  const entry = { message, level, timestamp: Date.now() };
  logs.push(entry);
  // Keep last 500 logs
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await setState({ logs });
  // Broadcast to side panel
  chrome.runtime.sendMessage({ type: 'LOG_ENTRY', payload: entry }).catch(() => {});
}

// ============================================================
// Step Status Management
// ============================================================

async function setStepStatus(step, status) {
  const state = await getState();
  const statuses = { ...state.stepStatuses };
  statuses[step] = status;
  await setState({ stepStatuses: statuses, currentStep: step });
  // Broadcast to side panel
  chrome.runtime.sendMessage({
    type: 'STEP_STATUS_CHANGED',
    payload: { step, status },
  }).catch(() => {});
}

function getRandomDelay(minMs, maxMs = minMs) {
  const lower = Math.max(0, Math.min(minMs, maxMs));
  const upper = Math.max(minMs, maxMs);
  return lower + Math.floor(Math.random() * (upper - lower + 1));
}

function sleepRandom(minMs, maxMs = minMs) {
  return new Promise(resolve => setTimeout(resolve, getRandomDelay(minMs, maxMs)));
}

// ============================================================
// Message Handler (central router)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG_PREFIX, `Received: ${message.type} from ${message.source || 'sidepanel'}`, message);

  handleMessage(message, sender).then(response => {
    sendResponse(response);
  }).catch(err => {
    console.error(LOG_PREFIX, 'Handler error:', err);
    sendResponse({ error: err.message });
  });

  return true; // async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'CONTENT_SCRIPT_READY': {
      const tabId = sender.tab?.id;
      if (tabId && message.source) {
        await registerTab(message.source, tabId);
        flushCommand(message.source, tabId);
        await addLog(`Content script ready: ${message.source} (tab ${tabId})`);
      }
      return { ok: true };
    }

    case 'CONTENT_SCRIPT_UNLOADING': {
      // Content script is about to unload (page navigation)
      const source = message.source;
      if (source) {
        const registry = await getTabRegistry();
        if (registry[source]) {
          registry[source].ready = false;
          await setState({ tabRegistry: registry });
          await addLog(`Content script unloading: ${source}`, 'info');
          console.log(LOG_PREFIX, `Marked ${source} as not ready (page unloading)`);
        }
      }
      return { ok: true };
    }

    case 'PAGE_RELOADING': {
      // 页面即将重新加载（由全局错误监测器触发）
      await addLog(`[${message.source}] Page is reloading due to error retry`, 'warn');
      
      // 标记 tab 为 not ready，等待页面重新加载后重新注册
      const registry = await getTabRegistry();
      if (registry[message.source]) {
        registry[message.source].ready = false;
        await setState({ tabRegistry: registry });
      }
      
      // 设置一个标志，表示需要在页面重新加载后重新执行当前步骤
      const state = await getState();
      if (state.currentStep === 3) {
        await setState({ step3NeedsRetry: true });
        await addLog('Step 3 will be retried after page reload', 'info');
      }
      
      return { ok: true };
    }

    case 'LOG': {
      const { message: msg, level } = message.payload;
      await addLog(`[${message.source}] ${msg}`, level);
      return { ok: true };
    }

    case 'STEP_COMPLETE': {
      await setStepStatus(message.step, 'completed');
      await addLog(`Step ${message.step} completed`, 'ok');
      await handleStepData(message.step, message.payload);
      notifyStepComplete(message.step, message.payload);
      
      // 清除重试标志
      if (message.step === 3) {
        await setState({ step3NeedsRetry: false });
      }
      
      return { ok: true };
    }

    case 'STEP_ERROR': {
      const isMailPollTransient = (message.step === 4 || message.step === 7)
        && /^mail-/.test(message.source || '')
        && /No matching email found/i.test(message.error || '');

      if (isMailPollTransient) {
        await addLog(
          `Step ${message.step} transient poll timeout from ${message.source}: ${message.error} (will continue retry/resend cycle)`,
          'warn'
        );
        return { ok: true };
      }

      await setStepStatus(message.step, 'failed');
      await addLog(`Step ${message.step} failed: ${message.error}`, 'error');
      notifyStepError(message.step, message.error);
      return { ok: true };
    }

    case 'GET_STATE': {
      console.log(LOG_PREFIX, 'GET_STATE 消息收到');
      const state = await getState();
      console.log(LOG_PREFIX, 'GET_STATE 返回状态:', Object.keys(state));
      return state;
    }

    case 'RESET': {
      console.log(LOG_PREFIX, '!!! RESET MESSAGE RECEIVED !!!');
      
      // 立即记录日志
      await addLog('=== RESET BUTTON CLICKED - FORCE STOPPING ALL ===', 'warn');
      
      // 1. 立即设置所有停止标志
      resetRequested = true;
      stopRequested = true;
      pausedForResume = false;
      autoRunActive = false;
      isAnyStepExecuting = false;
      
      // 2. 立即关闭无痕窗口
      try {
        await closeIncognitoWindow();
        await addLog('Incognito window closed', 'info');
      } catch (err) {
        console.error(LOG_PREFIX, 'Error closing incognito window:', err);
      }
      
      // 3. 解除所有等待（让它们立即失败）
      if (manualInterventionResolver) {
        manualInterventionResolver();
        manualInterventionResolver = null;
      }
      
      if (resumeResolver) {
        resumeResolver();
        resumeResolver = null;
      }
      
      // 解除所有步骤等待
      for (const [step, waiter] of stepWaiters.entries()) {
        waiter.reject(new Error('Flow reset requested'));
      }
      stepWaiters.clear();
      
      await addLog('All waiters cancelled', 'info');
      
      // 4. 重置所有控制变量
      autoRunCurrentRun = 0;
      autoRunTotalRuns = 1;
      manualInterventionResolver = null;
      resumeResolver = null;
      
      // 5. 重置 state
      const prevState = await getState();
      await resetState();
      await setState({
        vpsUrl: prevState.vpsUrl,
        emailPrefix: prevState.emailPrefix,
        saveToLocal: prevState.saveToLocal,
        localSavePath: prevState.localSavePath,
        incognitoMode: prevState.incognitoMode,
        localMode: prevState.localMode,
      });
      
      // 6. 清除重置标志
      resetRequested = false;
      stopRequested = false;
      
      await addLog('=== RESET COMPLETE - Ready to start ===', 'info');
      
      // 7. 通知 UI 重置
      chrome.runtime.sendMessage({ 
        type: 'AUTO_RUN_STATUS', 
        payload: { phase: 'reset' } 
      }).catch(() => {});
      
      return { ok: true };
    }

    case 'EXECUTE_STEP': {
      const step = message.payload.step;
      
      // 检查是否有其他步骤正在执行
      if (isAnyStepExecuting) {
        await addLog(`Cannot execute step ${step}: another step is executing`, 'warn');
        return { error: 'Another step is executing' };
      }
      
      // 检查是否有重置请求
      if (resetRequested) {
        await addLog(`Cannot execute step ${step}: reset in progress`, 'warn');
        return { error: 'Reset in progress' };
      }
      
      // 检查是否有自动流程正在运行
      if (autoRunActive) {
        await addLog(`Cannot execute step ${step} manually: auto run is in progress`, 'warn');
        return { error: 'Auto run in progress' };
      }
      
      // Save email if provided (from side panel step 3)
      if (message.payload.email) {
        await setState({ email: message.payload.email });
      }
      if (message.payload.emailPrefix !== undefined) {
        await setState({ emailPrefix: message.payload.emailPrefix });
      }
      
      try {
        await executeStep(step);
        return { ok: true };
      } catch (err) {
        // 如果是重置导致的错误，返回特殊标记
        if (resetRequested || err.message.includes('reset requested')) {
          return { error: 'Aborted by reset', aborted: true };
        }
        throw err;
      }
    }

    case 'AUTO_RUN': {
      const totalRuns = message.payload?.totalRuns || 1;
      autoRunLoop(totalRuns);  // fire-and-forget
      return { ok: true };
    }

    case 'RESUME_AUTO_RUN': {
      if (message.payload && message.payload.email) {
        await setState({ email: message.payload.email });
      }
      const result = await resumeAutoRun();
      return result || { ok: true };
    }

    case 'RESUME_MANUAL_INTERVENTION': {
      await resumeManualIntervention();
      return { ok: true };
    }

    case 'STOP_AUTO_RUN': {
      stopAutoRun();
      return { ok: true };
    }

    case 'SAVE_SETTING': {
      const updates = {};
      if (message.payload.vpsUrl !== undefined) updates.vpsUrl = message.payload.vpsUrl;
      if (message.payload.emailPrefix !== undefined) updates.emailPrefix = message.payload.emailPrefix;
      if (message.payload.defaultPassword !== undefined) updates.defaultPassword = message.payload.defaultPassword;
      if (message.payload.saveToLocal !== undefined) updates.saveToLocal = message.payload.saveToLocal;
      if (message.payload.localSavePath !== undefined) updates.localSavePath = message.payload.localSavePath;
      if (message.payload.incognitoMode !== undefined) updates.incognitoMode = message.payload.incognitoMode;
      if (message.payload.localMode !== undefined) updates.localMode = message.payload.localMode;
      if (message.payload.cpaManagementKey !== undefined) updates.cpaManagementKey = message.payload.cpaManagementKey;
      if (message.payload.signupEntry !== undefined) updates.signupEntry = message.payload.signupEntry;
      await setState(updates);
      await addLog(`Settings saved: ${JSON.stringify(updates)}`, 'info');
      return { ok: true };
    }

    // Side panel data updates
    case 'SAVE_EMAIL': {
      await setState({ email: message.payload.email });
      return { ok: true };
    }

    default:
      console.warn(LOG_PREFIX, `Unknown message type: ${message.type}`);
      return { error: `Unknown message type: ${message.type}` };
  }
}

// ============================================================
// Step Data Handlers
// ============================================================

async function handleStepData(step, payload) {
  switch (step) {
    case 1:
      if (payload.oauthUrl) {
        await setState({ oauthUrl: payload.oauthUrl });
        // Broadcast OAuth URL to side panel
        chrome.runtime.sendMessage({
          type: 'DATA_UPDATED',
          payload: { oauthUrl: payload.oauthUrl },
        }).catch(() => {});
      }
      break;
    case 3:
      if (payload.email) await setState({ email: payload.email });
      break;
    case 4:
      if (payload.emailTimestamp) await setState({ lastEmailTimestamp: payload.emailTimestamp });
      break;
    case 8:
      if (payload.localhostUrl) {
        await setState({ localhostUrl: payload.localhostUrl });
        chrome.runtime.sendMessage({
          type: 'DATA_UPDATED',
          payload: { localhostUrl: payload.localhostUrl },
        }).catch(() => {});
      }
      break;
    case 9:
      // Step 9 完成后，尝试下载认证文件（如果启用了本地保存）
      // 注意：下载失败不应该阻塞流程，只记录警告
      await addLog('Step 9: VPS 验证完成，等待 1 秒后开始下载认证文件...', 'info');
      
      // 等待 1 秒，让服务器有时间生成文件
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      try {
        const state = await getState();
        await downloadAuthFile(state);
      } catch (err) {
        await addLog(`Step 9: 下载认证文件失败: ${err.message}`, 'warn');
        // 不抛出异常，允许流程继续
      }
      break;
  }
}

// ============================================================
// Step Completion Waiting
// ============================================================

// Map of step -> { resolve, reject } for waiting on step completion
const stepWaiters = new Map();

function waitForStepComplete(step, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stepWaiters.delete(step);
      reject(new Error(`Step ${step} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    stepWaiters.set(step, {
      resolve: (data) => { clearTimeout(timer); stepWaiters.delete(step); resolve(data); },
      reject: (err) => { clearTimeout(timer); stepWaiters.delete(step); reject(err); },
    });
  });
}

function notifyStepComplete(step, payload) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.resolve(payload);
}

function notifyStepError(step, error) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.reject(new Error(error));
}

// ============================================================
// Step Execution
// ============================================================

async function executeStep(step) {
  console.log(LOG_PREFIX, `Executing step ${step}`);
  
  // 检查是否有其他步骤正在执行
  if (isAnyStepExecuting) {
    throw new Error('Another step is already executing - please wait');
  }
  
  // 检查是否请求重置
  if (resetRequested) {
    throw new Error('Flow reset requested - aborting step execution');
  }
  
  // 设置执行锁
  isAnyStepExecuting = true;
  
  try {
    await setStepStatus(step, 'running');
    await addLog(`Step ${step} started`);

    const state = await getState();

    // Set flow start time on first step
    if (step === 1 && !state.flowStartTime) {
      await setState({ flowStartTime: Date.now() });
    }

    // 在执行前再次检查重置标志
    if (resetRequested) {
      throw new Error('Flow reset requested - aborting step execution');
    }
    
    switch (step) {
      case 1: await executeStep1(state); break;
      case 2: await executeStep2(state); break;
      case 3: await executeStep3(state); break;
      case 4: await executeStep4(state); break;
      case 5: await executeStep5(state); break;
      case 6: await executeStep6(state); break;
      case 7: await executeStep7(state); break;
      case 8: await executeStep8(state); break;
      case 9: await executeStep9(state); break;
      default:
        throw new Error(`Unknown step: ${step}`);
    }
  } catch (err) {
    // 如果是重置请求导致的错误，不标记为失败
    if (resetRequested || err.message.includes('reset requested')) {
      await addLog(`Step ${step} aborted due to reset`, 'warn');
      throw err;
    }
    
    await setStepStatus(step, 'failed');
    await addLog(`Step ${step} failed: ${err.message}`, 'error');
    throw err;
  } finally {
    // 无论成功还是失败，都释放执行锁
    isAnyStepExecuting = false;
  }
}

/**
 * Execute a step and wait for it to complete before returning.
 * @param {number} step
 * @param {number} minDelayAfter - min ms to wait after completion (for page transitions)
 * @param {number} maxDelayAfter - max ms to wait after completion (for page transitions)
 */
async function executeStepAndWait(step, minDelayAfter = 2000, maxDelayAfter = minDelayAfter, timeoutMs = 120000) {
  const promise = waitForStepComplete(step, timeoutMs);
  await executeStep(step);
  await promise;
  // Extra delay for page transitions / DOM updates
  if (maxDelayAfter > 0) {
    await sleepRandom(minDelayAfter, maxDelayAfter);
  }
}

async function isSignupProfilePageReady() {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) return false;

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: signupTabId },
    func: () => {
      const hasNameInput = !!document.querySelector(
        'input[name="name"], input[autocomplete="name"], input[placeholder*="全名"]'
      );
      const hasCodeInput = !!document.querySelector(
        'input[name="code"], input[name="otp"], input[maxlength="1"], input[inputmode="numeric"]'
      );
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const hasCodeError = /invalid|incorrect|wrong\s*code|验证码|无效|错误|try again|重新发送/.test(bodyText);
      return {
        hasNameInput,
        hasCodeInput,
        hasCodeError,
        href: location.href,
      };
    },
  });

  const info = result?.result;
  if (!info) return false;
  if (info.hasNameInput) return true;
  if (info.hasCodeInput || info.hasCodeError) return false;
  return false;
}

async function isOAuthConsentPageReady() {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) return false;

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: signupTabId },
    func: () => {
      const continueBtn = document.querySelector(
        'button[data-dd-action-name="Continue"][type="submit"], button._primary_3rdp0_107[type="submit"], button[type="submit"]'
      );
      const hasContinueText = /(^|\s)(继续|continue)(\s|$)/i.test(
        (continueBtn?.textContent || document.body?.innerText || '').replace(/\s+/g, ' ')
      );
      const hasCodeInput = !!document.querySelector(
        'input[name="code"], input[name="otp"], input[maxlength="1"], input[inputmode="numeric"]'
      );
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const hasCodeError = /invalid|incorrect|wrong\s*code|验证码|无效|错误|try again|重新发送/.test(bodyText);
      return {
        hasContinueButton: !!continueBtn,
        hasContinueText,
        hasCodeInput,
        hasCodeError,
        href: location.href,
      };
    },
  });

  const info = result?.result;
  if (!info) return false;
  if ((info.hasContinueButton && info.hasContinueText) || info.hasContinueButton) return true;
  if (info.hasCodeInput || info.hasCodeError) return false;
  return false;
}

async function waitForSignupProfilePageReady(timeoutMs = 20000, intervalMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isSignupProfilePageReady()) return true;
    await sleepRandom(intervalMs, intervalMs + 300);
  }
  return await isSignupProfilePageReady();
}

async function waitForOAuthConsentPageReady(timeoutMs = 20000, intervalMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isOAuthConsentPageReady()) return true;
    await sleepRandom(intervalMs, intervalMs + 300);
  }
  return await isOAuthConsentPageReady();
}

// ============================================================
// Auto Run Flow
// ============================================================

let autoRunActive = false;
let autoRunCurrentRun = 0;
let autoRunTotalRuns = 1;
let manualInterventionResolver = null;
let stopRequested = false;
let pausedForResume = false;
let resetRequested = false;
let isAnyStepExecuting = false; // 全局执行锁，防止手动和自动流程冲突

function stopAutoRun() {
  stopRequested = true;
  pausedForResume = true;
  
  // 如果正在等待人工介入，也解除它
  if (manualInterventionResolver) {
    addLog('Manual intervention cancelled by user stop', 'warn');
    manualInterventionResolver();
    manualInterventionResolver = null;
  }
  
  // 如果正在等待恢复，解除等待
  if (resumeResolver) {
    resumeResolver();
    resumeResolver = null;
  }
  
  addLog('Flow paused by user. Click "继续" to resume...', 'warn');
  
  // 通知 UI 流程已暂停
  chrome.runtime.sendMessage({ 
    type: 'AUTO_RUN_STATUS', 
    payload: { 
      phase: 'paused', 
      currentRun: autoRunCurrentRun, 
      totalRuns: autoRunTotalRuns 
    } 
  }).catch(() => {});
}

async function resumeAutoRun() {
  if (!pausedForResume) {
    await addLog('No paused flow to resume', 'warn');
    return { ok: false, error: 'No paused flow' };
  }
  
  stopRequested = false;
  pausedForResume = false;
  
  if (resumeResolver) {
    resumeResolver();
    resumeResolver = null;
  }
  
  await addLog('Flow resumed by user', 'info');
  
  // 通知 UI 流程已恢复
  chrome.runtime.sendMessage({ 
    type: 'AUTO_RUN_STATUS', 
    payload: { 
      phase: 'running', 
      currentRun: autoRunCurrentRun, 
      totalRuns: autoRunTotalRuns 
    } 
  }).catch(() => {});
  
  return { ok: true };
}

function waitForManualIntervention() {
  return new Promise((resolve) => {
    manualInterventionResolver = resolve;
  });
}

async function resumeManualIntervention() {
  if (manualInterventionResolver) {
    manualInterventionResolver();
    manualInterventionResolver = null;
  }
}

async function requestManualIntervention(step, message, currentRun, totalRuns) {
  const payload = { step, message, currentRun, totalRuns };
  await setState({ manualIntervention: payload });
  await addLog(`Step ${step}: 需要人工介入。${message}。处理完成后点击侧边栏“人工处理完成，继续下一步”。`, 'warn');
  chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'manual_intervention', ...payload } }).catch(() => {});

  await waitForManualIntervention();

  // 检查是否是用户停止导致的解除
  if (stopRequested) {
    await addLog(`Step ${step}: 人工介入被用户停止取消`, 'warn');
    await setState({ manualIntervention: null });
    // 不标记为 completed，让流程进入暂停状态
    return;
  }

  await setState({ manualIntervention: null });
  if (step >= 1 && step <= 9) {
    await setStepStatus(step, 'completed');
    await addLog(`Step ${step}: 人工处理后已继续下一步`, 'ok');
  }
  chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'running', currentRun, totalRuns } }).catch(() => {});
}

async function executeStepWithManualFallback(step, currentRun, totalRuns, minDelayAfter, maxDelayAfter, timeoutMs = 120000) {
  await addLog(`executeStepWithManualFallback: Starting step ${step}`, 'info');
  
  // 检查是否请求重置
  if (resetRequested) {
    throw new Error('Flow reset requested');
  }
  
  if (stopRequested) {
    // 暂停流程，等待用户点击继续
    await waitForResume();
    
    // 恢复后再次检查是否请求重置
    if (resetRequested) {
      throw new Error('Flow reset requested');
    }
  }
  
  try {
    await executeStepAndWait(step, minDelayAfter, maxDelayAfter, timeoutMs);
    await addLog(`executeStepWithManualFallback: Step ${step} completed successfully`, 'info');
  } catch (err) {
    await addLog(`executeStepWithManualFallback: Step ${step} error: ${err.message}`, 'warn');
    
    // 检查是否请求重置
    if (resetRequested) {
      throw new Error('Flow reset requested');
    }
    
    // 特殊处理：Step 3 邮箱已存在错误
    if (step === 3 && err.message.startsWith('EMAIL_EXISTS:')) {
      await addLog(`Step 3: 检测到邮箱已存在，将重新生成邮箱并重试 Step 2-3`, 'warn');
      
      // 设置最大重试次数，避免无限循环
      const maxRetries = 3;
      for (let retry = 1; retry <= maxRetries; retry++) {
        await addLog(`Step 3 邮箱重复恢复: 第 ${retry}/${maxRetries} 次重试...`, 'info');
        
        try {
          // 重新执行 Step 2（打开注册页面）
          await addLog(`Step 3 邮箱重复恢复: 正在重新执行 Step 2...`, 'info');
          await executeStepAndWait(2, 2600, 3800);
          
          // 重新执行 Step 3（会自动生成新的随机邮箱）
          await addLog(`Step 3 邮箱重复恢复: 正在重新执行 Step 3（将生成新邮箱）...`, 'info');
          await executeStepAndWait(3, 3200, 4800);
          
          await addLog(`Step 3 邮箱重复恢复: 成功完成 Step 2-3`, 'ok');
          return; // 成功恢复，直接返回
        } catch (retryErr) {
          // 如果再次遇到 EMAIL_EXISTS 错误，继续下一次重试
          if (retryErr.message.startsWith('EMAIL_EXISTS:')) {
            await addLog(`Step 3 邮箱重复恢复: 第 ${retry} 次重试仍然遇到邮箱重复`, 'warn');
            if (retry === maxRetries) {
              await addLog(`Step 3 邮箱重复恢复: 已达到最大重试次数 (${maxRetries})，转为人工介入`, 'error');
              await requestManualIntervention(3, `邮箱重复 ${maxRetries} 次，请人工检查`, currentRun, totalRuns);
              return;
            }
            // 继续下一次循环
            continue;
          } else {
            // 其他错误，停止重试
            await addLog(`Step 3 邮箱重复恢复: 重试失败（非邮箱重复错误）: ${retryErr.message}`, 'error');
            await requestManualIntervention(3, `邮箱重复恢复失败: ${retryErr.message}`, currentRun, totalRuns);
            return;
          }
        }
      }
    }
    
    // 特殊处理：Step 4 或 Step 7 验证码错误
    if ((step === 4 || step === 7) && err.message.startsWith('CODE_ERROR:')) {
      await addLog(`Step ${step}: 检测到验证码错误，将从邮件列表获取最新验证码并重试`, 'warn');
      
      // 设置最大重试次数
      const maxRetries = 2;
      for (let retry = 1; retry <= maxRetries; retry++) {
        await addLog(`Step ${step} 验证码错误恢复: 第 ${retry}/${maxRetries} 次重试...`, 'info');
        
        try {
          // 获取邮件配置
          const state = await getState();
          const mail = getMailConfig(state);
          const recipientEmail = state.email || '';
          
          // 切换到邮件标签页
          const mailTabId = await getTabId(mail.source);
          if (!mailTabId) {
            throw new Error('邮件标签页不存在，无法获取验证码');
          }
          
          await chrome.tabs.update(mailTabId, { active: true });
          await addLog(`Step ${step} 验证码错误恢复: 正在从邮件列表获取最新验证码...`, 'info');
          
          // 构建邮件轮询参数
          const pollPayload = step === 4 ? {
            filterAfterTimestamp: Date.now() - 300000, // 最近 5 分钟的邮件
            senderFilters: ['openai', 'noreply', 'verify', 'auth'],
            subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm'],
            recipientEmail: recipientEmail,
            excludeCodes: [],  // 不排除任何验证码
            maxAttempts: 3,
            intervalMs: 3000,
          } : {
            filterAfterTimestamp: Date.now() - 300000, // 最近 5 分钟的邮件
            strictChatGPTCodeOnly: true,
            excludeCodes: state.signupVerificationCode ? [state.signupVerificationCode] : [],
            senderFilters: ['openai', 'noreply', 'verify', 'auth', 'chatgpt'],
            subjectFilters: ['your chatgpt code is'],
            recipientEmail: recipientEmail,
            maxAttempts: 3,
            intervalMs: 3000,
          };
          
          // 从邮件列表获取最新验证码
          const result = await sendToContentScript(mail.source, {
            type: 'POLL_EMAIL',
            step: step,
            source: 'background',
            payload: pollPayload,
          });
          
          if (!result || !result.code || result.error) {
            throw new Error(`无法从邮件列表获取验证码: ${result?.error || '未找到验证码'}`);
          }
          
          await addLog(`Step ${step} 验证码错误恢复: 获取到新验证码: ${result.code}`, 'ok');
          
          // 切换回验证码输入页面
          const signupTabId = await getTabId('signup-page');
          if (!signupTabId) {
            throw new Error('验证码输入页面不存在');
          }
          
          await chrome.tabs.update(signupTabId, { active: true });
          await sleepRandom(500, 1000);
          
          // 填充新验证码
          await sendToContentScript('signup-page', {
            type: 'FILL_CODE',
            step: step,
            source: 'background',
            payload: { code: result.code },
          });
          
          await addLog(`Step ${step} 验证码错误恢复: 成功完成`, 'ok');
          return; // 成功恢复，直接返回
        } catch (retryErr) {
          // 如果再次遇到 CODE_ERROR，继续下一次重试
          if (retryErr.message.startsWith('CODE_ERROR:')) {
            await addLog(`Step ${step} 验证码错误恢复: 第 ${retry} 次重试仍然遇到验证码错误`, 'warn');
            if (retry === maxRetries) {
              await addLog(`Step ${step} 验证码错误恢复: 已达到最大重试次数 (${maxRetries})，转为人工介入`, 'error');
              await requestManualIntervention(step, `验证码错误 ${maxRetries} 次，请人工检查`, currentRun, totalRuns);
              return;
            }
            // 继续下一次循环
            continue;
          } else {
            // 其他错误，停止重试
            await addLog(`Step ${step} 验证码错误恢复: 重试失败: ${retryErr.message}`, 'error');
            await requestManualIntervention(step, `验证码错误恢复失败: ${retryErr.message}`, currentRun, totalRuns);
            return;
          }
        }
      }
    }
    
    // 特殊处理：Step 9 OAuth callback 超时
    if (step === 9 && /OAuth callback timeout/i.test(err.message)) {
      await addLog(`Step 9: 检测到 OAuth callback 超时，将刷新 OAuth 链接并重新执行 Step 6-9`, 'warn');
      
      // 1. 刷新 CPA 接口获取新的 OAuth 链接（重新执行 Step 1）
      await addLog(`Step 9 超时恢复: 正在刷新 OAuth 链接...`, 'info');
      try {
        await executeStepAndWait(1, 2600, 3800);
        await addLog(`Step 9 超时恢复: OAuth 链接已刷新`, 'ok');
      } catch (step1Err) {
        await addLog(`Step 9 超时恢复: 刷新 OAuth 链接失败: ${step1Err.message}`, 'error');
        throw new Error(`无法恢复 Step 9 超时: ${step1Err.message}`);
      }
      
      // 2. 重新执行 Step 6-9
      await addLog(`Step 9 超时恢复: 正在重新执行 Step 6-9...`, 'info');
      try {
        await executeStepAndWait(6, 3200, 4800);
        await executeStepAndWait(7, 3200, 4800, 600000);
        
        // Guard: 确保进入 OAuth 同意页
        let consentReady = await waitForOAuthConsentPageReady(20000, 1200);
        for (let retry = 1; !consentReady && retry <= 2; retry++) {
          await addLog(`Step 9 超时恢复: OAuth 同意页未就绪，重试 Step 7 (${retry}/2)...`, 'warn');
          await executeStepAndWait(7, 3200, 4800, 600000);
          consentReady = await waitForOAuthConsentPageReady(20000, 1200);
        }
        if (!consentReady) {
          throw new Error('Step 9 超时恢复失败: 无法进入 OAuth 同意页');
        }
        
        await executeStepAndWait(8, 2400, 3600);
        
        // 检查 Step 8 是否因为 add-phone 而失败
        const step8State = await getState();
        if (step8State.registrationFailed && step8State.failureReason === 'phone_verification_required') {
          throw new Error('Step 9 超时恢复失败: 需要手机验证');
        }
        
        await executeStepAndWait(9, 1600, 2600);
        
        await addLog(`Step 9 超时恢复: 成功完成 Step 6-9`, 'ok');
        return; // 成功恢复，直接返回
      } catch (retryErr) {
        await addLog(`Step 9 超时恢复: 重新执行失败: ${retryErr.message}`, 'error');
        // 如果重试失败，继续走人工介入流程
        await requestManualIntervention(9, `OAuth 超时且自动恢复失败: ${retryErr.message}`, currentRun, totalRuns);
        return;
      }
    }
    
    if (stopRequested) {
      // 暂停流程，等待用户点击继续
      await waitForResume();
      
      // 恢复后再次检查是否请求重置
      if (resetRequested) {
        throw new Error('Flow reset requested');
      }
      
      // 恢复后重试当前步骤
      return await executeStepWithManualFallback(step, currentRun, totalRuns, minDelayAfter, maxDelayAfter, timeoutMs);
    }
    
    await requestManualIntervention(step, err.message, currentRun, totalRuns);
    
    // 人工介入后检查是否请求重置
    if (resetRequested) {
      throw new Error('Flow reset requested');
    }
    
    if (stopRequested) {
      // 暂停流程，等待用户点击继续
      await waitForResume();
      
      // 恢复后再次检查是否请求重置
      if (resetRequested) {
        throw new Error('Flow reset requested');
      }
      
      // 恢复后重试当前步骤
      return await executeStepWithManualFallback(step, currentRun, totalRuns, minDelayAfter, maxDelayAfter, timeoutMs);
    }
  }
  
  await addLog(`executeStepWithManualFallback: Step ${step} finished`, 'info');
}

// Outer loop: runs the full flow N times
async function autoRunLoop(totalRuns) {
  if (autoRunActive) {
    await addLog('Auto run already in progress', 'warn');
    return;
  }

  autoRunActive = true;
  autoRunTotalRuns = totalRuns;
  await setState({ autoRunning: true });

  stopRequested = false;

  for (let run = 1; run <= totalRuns; run++) {
    autoRunCurrentRun = run;

    // 检查是否请求重置
    if (resetRequested) {
      await addLog(`=== Flow reset requested, stopping all runs ===`, 'warn');
      break;
    }

    if (stopRequested) {
      // 暂停流程，等待用户点击继续
      await waitForResume();
      
      // 恢复后再次检查是否请求重置
      if (resetRequested) {
        await addLog(`=== Flow reset requested after resume ===`, 'warn');
        break;
      }
    }

    // Reset everything at the start of each run (keep VPS/mail settings)
    const prevState = await getState();
    const keepSettings = {
      vpsUrl: prevState.vpsUrl,
      emailPrefix: prevState.emailPrefix || '',
      saveToLocal: prevState.saveToLocal,
      localSavePath: prevState.localSavePath,
      incognitoMode: prevState.incognitoMode,
      localMode: prevState.localMode,
      cpaManagementKey: prevState.cpaManagementKey || '',
      signupEntry: prevState.signupEntry || 'oauth',  // 保留注册入口设置
      defaultPassword: prevState.defaultPassword || '',  // 保留默认密码设置
      autoRunning: true,
    };
    await resetState();
    await setState(keepSettings);
    
    // 先发送 running 状态，确保 UI 显示停止按钮
    const status = (phase) => ({ type: 'AUTO_RUN_STATUS', payload: { phase, currentRun: run, totalRuns } });
    chrome.runtime.sendMessage(status('running')).catch(() => {});
    
    // 然后重置 UI 显示（但不影响按钮状态）
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_RESET' }).catch(() => {});
    await sleepRandom(400, 900);

    await addLog(`=== Auto Run ${run}/${totalRuns} — Phase 1: Get OAuth link & open signup ===`, 'info');

    try {
      await executeStepWithManualFallback(1, run, totalRuns, 2600, 3800);
      
      // ChatGPT 注册模式：Step 1 点击"免费注册"后页面会跳转，等待页面加载
      const currentState = await getState();
      if (currentState.signupEntry === 'chatgpt') {
        await addLog('等待页面跳转到 auth.openai.com...', 'info');
        await sleepRandom(2000, 3000);
      }
      
      await executeStepWithManualFallback(2, run, totalRuns, 2600, 3800);


      // 检查邮箱配置
      const runState = await getState();
      const { emailType } = await chrome.storage.local.get('emailType');
      
      // 2925 模式需要检查邮箱前缀
      if (emailType !== 'hotmail' && !runState.emailPrefix) {
        await addLog('Cannot continue: 2925 邮箱前缀未设置，请在侧边栏填写。', 'error');
        chrome.runtime.sendMessage(status('stopped')).catch(() => {});
        break;
      }
      
      // Hotmail 模式需要检查是否有可用邮箱
      if (emailType === 'hotmail') {
        // 这里暂时跳过检查，在 executeStep3 中会检查
        await addLog(`=== Run ${run}/${totalRuns} — 使用 Hotmail 邮箱模式 ===`, 'info');
      } else {
        await addLog(`=== Run ${run}/${totalRuns} — 将在步骤3自动生成 2925 邮箱 ===`, 'info');
      }

      await addLog(`=== Run ${run}/${totalRuns} — Phase 2: Register, verify, login, complete ===`, 'info');
      chrome.runtime.sendMessage(status('running')).catch(() => {});

      await executeStepWithManualFallback(3, run, totalRuns, 3200, 4800);
      await executeStepWithManualFallback(4, run, totalRuns, 3200, 4800, 600000);

      // Guard: if step 4 used an old/invalid code, the page may still be on verification input.
      // Retry step 4 instead of moving to step 5 and failing downstream.
      let profileReady = await waitForSignupProfilePageReady(20000, 1200);
      for (let retry = 1; !profileReady && retry <= 2; retry++) {
        await addLog(`Step 4 guard: still not on profile page after code submit, retrying step 4 (${retry}/2)...`, 'warn');
        await executeStepWithManualFallback(4, run, totalRuns, 3200, 4800, 600000);
        profileReady = await waitForSignupProfilePageReady(20000, 1200);
      }
      if (!profileReady) {
        await requestManualIntervention(4, '仍未进入姓名/生日页面，请人工确认注册验证码页面并处理，然后继续。', run, totalRuns);
      }

      await executeStepWithManualFallback(5, run, totalRuns, 3200, 4800);
      
      // Step 5 完成后立即更新 Hotmail 邮箱使用次数
      // 因为此时 OpenAI 账户已经创建成功，邮箱已被使用
      if (emailType === 'hotmail') {
        try {
          const { currentHotmailData } = await chrome.storage.session.get('currentHotmailData');
          
          if (currentHotmailData) {
            const hotmailManager = new HotmailManager();
            await hotmailManager.init();
            await hotmailManager.incrementUsage(currentHotmailData.email);
            
            const newCount = currentHotmailData.usageCount + 1;
            await addLog(`✅ 邮箱 ${currentHotmailData.email} 使用次数已更新: ${newCount}/6`, 'ok');
            
            if (newCount >= 6) {
              await addLog(`⚠️ 邮箱 ${currentHotmailData.email} 已达使用上限`, 'warn');
            }
          }
        } catch (error) {
          await addLog(`更新使用次数失败: ${error.message}`, 'error');
        }
      }
      
      await executeStepWithManualFallback(6, run, totalRuns, 3200, 4800);
      await executeStepWithManualFallback(7, run, totalRuns, 3200, 4800, 600000);

      // Guard: step 7 may submit a stale/invalid login code and still report completion.
      // Ensure we actually reached OAuth consent page before moving to step 8.
      let consentReady = await waitForOAuthConsentPageReady(20000, 1200);
      for (let retry = 1; !consentReady && retry <= 2; retry++) {
        await addLog(`Step 7 guard: consent page not ready after code submit, retrying step 7 (${retry}/2)...`, 'warn');
        await executeStepWithManualFallback(7, run, totalRuns, 3200, 4800, 600000);
        consentReady = await waitForOAuthConsentPageReady(20000, 1200);
      }
      if (!consentReady) {
        await requestManualIntervention(7, '仍未进入 OAuth 同意页，请人工确认登录验证码页面并处理，然后继续。', run, totalRuns);
      }

      await executeStepWithManualFallback(8, run, totalRuns, 2400, 3600);
      
      // 检查 Step 8 是否因为 add-phone 而失败（需要手机验证）
      const step8State = await getState();
      if (step8State.registrationFailed && step8State.failureReason === 'phone_verification_required') {
        await addLog(`=== Run ${run}/${totalRuns} FAILED: Phone verification required (add-phone detected) ===`, 'warn');
        await addLog(`Skipping Step 9 and moving to next run...`, 'info');
        continue; // 跳过 Step 9，继续下一次循环
      }
      
      await executeStepWithManualFallback(9, run, totalRuns, 1600, 2600);

      // 清理 Hotmail session 数据
      if (emailType === 'hotmail') {
        await chrome.storage.session.remove(['currentHotmailData', 'currentEmailAlias']);
      }

      await addLog(`=== Run ${run}/${totalRuns} COMPLETE! ===`, 'ok');

    } catch (err) {
      await addLog(`=== autoRunLoop catch block: ${err.message} ===`, 'error');
      
      // 检查是否是重置请求
      if (resetRequested) {
        await addLog(`=== Flow reset requested, stopping all runs ===`, 'warn');
        break;
      }
      
      if (stopRequested) {
        await addLog(`=== Run ${run}/${totalRuns} paused by user ===`, 'warn');
        chrome.runtime.sendMessage(status('paused')).catch(() => {});
        // 等待用户点击继续
        await waitForResume();
        
        // 恢复后再次检查是否请求重置
        if (resetRequested) {
          await addLog(`=== Flow reset requested after resume ===`, 'warn');
          break;
        }
        
        await addLog(`=== Run ${run}/${totalRuns} resumed ===`, 'info');
        // 恢复后重试当前 run（从头开始）
        run--;
        continue;
      }
      await addLog(`Run ${run}/${totalRuns} failed: ${err.message}`, 'error');
      chrome.runtime.sendMessage(status('stopped')).catch(() => {});
      break;
    }
  }

  const completedRuns = autoRunCurrentRun;
  if (resetRequested) {
    await addLog(`=== Flow was reset ===`, 'info');
    // Reset flag will be cleared by RESET message handler
  } else if (stopRequested && pausedForResume) {
    await addLog(`=== Flow paused after ${completedRuns}/${autoRunTotalRuns} runs. Click "继续" to resume ===`, 'warn');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'paused', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  } else if (completedRuns >= autoRunTotalRuns) {
    await addLog(`=== All ${autoRunTotalRuns} runs completed successfully ===`, 'ok');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'complete', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  } else {
    await addLog(`=== Stopped after ${completedRuns}/${autoRunTotalRuns} runs ===`, 'warn');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'stopped', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  }
  
  // 清理控制变量（除非是重置，重置会由 RESET handler 清理）
  if (!resetRequested) {
    autoRunActive = false;
    stopRequested = false;
    pausedForResume = false;
  }
  await setState({ autoRunning: false });
}

// Promise-based pause/resume mechanism
let resumeResolver = null;

function waitForResume() {
  return new Promise((resolve) => {
    resumeResolver = resolve;
  });
}

// ============================================================
// Step 1: Get OAuth Link (via vps-panel.js)
// ============================================================

async function executeStep1(state) {
  // Clear any pending commands from previous runs
  clearPendingCommands();
  
  // 清除 registry 中的旧数据，避免误判
  const registry = await getTabRegistry();
  delete registry['chatgpt'];
  delete registry['signup-page'];
  await setState({ tabRegistry: registry });
  await addLog('Step 1: 已清除旧的 tab registry 数据', 'info');
  
  // ChatGPT 注册入口：直接打开 chatgpt.com
  if (state.signupEntry === 'chatgpt') {
    await addLog('Step 1: ChatGPT 注册入口，清除 Cookie 并打开 chatgpt.com...');
    
    // 清除 chatgpt.com 和 openai.com 相关域名的 Cookie，确保是未登录状态
    try {
      // 检查是否有cookies权限
      if (!chrome.cookies) {
        await addLog('Step 1: 缺少 cookies 权限，无法清除 Cookie', 'error');
        return;
      }

      const domainsToClean = ['chatgpt.com', 'openai.com', 'auth.openai.com', 'auth0.openai.com'];
      let totalCookiesCleared = 0;
      
      for (const domain of domainsToClean) {
        try {
          const cookies = await chrome.cookies.getAll({ domain });
          await addLog(`Step 1: 找到 ${domain} 的 ${cookies.length} 个 Cookie`);
          
          for (const cookie of cookies) {
            await chrome.cookies.remove({
              url: `https://${domain}${cookie.path}`,
              name: cookie.name
            });
            totalCookiesCleared++;
          }
        } catch (domainErr) {
          await addLog(`Step 1: 清除 ${domain} Cookie 失败: ${domainErr.message}`, 'warn');
        }
      }
      
      await addLog(`Step 1: Cookie 清除完成，共清除 ${totalCookiesCleared} 个`, 'ok');
    } catch (err) {
      await addLog(`Step 1: 清除 Cookie 失败: ${err.message}`, 'warn');
      // 继续执行，不阻塞流程
    }
    
    // 如果启用无痕模式，在无痕窗口中打开
    if (state.incognitoMode) {
      await createIncognitoTab('chatgpt', 'https://chatgpt.com');
    } else {
      await reuseOrCreateTab('chatgpt', 'https://chatgpt.com');
    }
    
    // 通知 content script 执行 ChatGPT 注册流程的 Step 1
    await sendToContentScript('chatgpt', {
      type: 'EXECUTE_STEP',
      step: 1,
      source: 'background',
      payload: { signupEntry: 'chatgpt' },
    });
    
    return;
  }
  
  // OAuth 授权入口（原有逻辑）
  // 本地模式：使用本地生成的 OAuth 链接
  if (state.localMode) {
    const local = await buildLocalOAuthUrl();
    await setState({
      oauthUrl: local.oauthUrl,
      oauthCodeVerifier: local.codeVerifier,
      oauthState: local.state,
    });
    
    await addLog('Step 1: 本地模式，已本地生成 OAuth 链接。', 'ok');
    
    chrome.runtime.sendMessage({
      type: 'DATA_UPDATED',
      payload: { oauthUrl: local.oauthUrl },
    }).catch(() => {});
    await setStepStatus(1, 'completed');
    notifyStepComplete(1, { oauthUrl: local.oauthUrl, mode: 'local' });
    return;
  }

  // CPA 模式：使用 CPA 接口
  await addLog('Step 1: CPA 模式，正在打开 CPA 面板...');
  await reuseOrCreateTab('vps-panel', state.vpsUrl, { 
    inject: ['content/utils.js', 'content/vps-panel.js'],
    reloadIfSameUrl: true  // 强制刷新以获取最新的 OAuth 链接
  });

  await sendToContentScript('vps-panel', {
    type: 'EXECUTE_STEP',
    step: 1,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 2: Open Signup Page (Background opens tab, signup-page.js clicks Register)
// ============================================================

async function executeStep2(state) {
  // ChatGPT 注册入口：Step 2 填写邮箱
  if (state.signupEntry === 'chatgpt') {
    await addLog('Step 2: ChatGPT 注册入口，准备填写邮箱...');
    
    // 生成邮箱（如果还没有）
    let email = state.email;
    if (!email) {
      const { emailType } = await chrome.storage.local.get('emailType');
      
      if (emailType === 'hotmail') {
        const hotmailManager = new HotmailManager();
        await hotmailManager.init();
        const emailData = await hotmailManager.getNextAvailableEmail();
        const alias = hotmailManager.generateAlias(emailData.email, emailData.usageCount);
        
        email = alias;
        await setState({
          email: alias,
          currentHotmailData: emailData,
        });
        
        await addLog(`Step 2: 使用 Hotmail 邮箱: ${alias}`);
      } else {
        const prefix = state.emailPrefix || 'test';
        const suffix = generateRandomSuffix(6);
        email = `${prefix}_${suffix}@2925.com`;
        await setState({ email });
        
        await addLog(`Step 2: 使用 2925 邮箱: ${email}`);
      }
    }
    
    // 生成密码
    const password = await getPassword();
    await setState({ password });
    
    // 智能判断使用哪个 source：检查 registry 中的 ready 状态
    // 注意：Step 1 点击"免费注册"后页面会跳转，需要等待新页面加载
    const registry = await getTabRegistry();
    const chatgptReady = registry['chatgpt']?.ready;
    const signupPageReady = registry['signup-page']?.ready;
    
    let targetSource = 'chatgpt';
    
    // 如果 chatgpt 还在且 ready，说明还没跳转
    if (chatgptReady && !signupPageReady) {
      targetSource = 'chatgpt';
      await addLog('Step 2: Still on chatgpt.com, using chatgpt source');
    } 
    // 如果 signup-page ready 且 chatgpt 不 ready，说明已经跳转
    else if (signupPageReady && !chatgptReady) {
      targetSource = 'signup-page';
      await addLog('Step 2: Page has transitioned to auth.openai.com, using signup-page source');
    }
    // 如果两个都 ready（不太可能）或都不 ready（页面跳转中）
    else {
      // 默认等待 signup-page（因为 Step 1 点击后会跳转）
      targetSource = 'signup-page';
      await addLog('Step 2: Waiting for signup-page content script (page transitioning)');
    }
    
    // 通知 content script 填写邮箱
    await sendToContentScript(targetSource, {
      type: 'EXECUTE_STEP',
      step: 2,
      source: 'background',
      payload: { 
        signupEntry: 'chatgpt',
        email,
        password
      },
    });
    
    return;
  }
  
  // OAuth 授权入口（原有逻辑）
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }
  
  // 如果启用无痕模式，在无痕窗口中打开
  if (state.incognitoMode) {
    await addLog(`Step 2: Opening auth URL in incognito window...`);
    await createIncognitoTab('signup-page', state.oauthUrl);
  } else {
    await addLog(`Step 2: Opening auth URL...`);
    await reuseOrCreateTab('signup-page', state.oauthUrl);
  }

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 2,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 3: Fill Email & Password (via signup-page.js)
// ============================================================

function generateRandomSuffix(length = 6) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < length; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function executeStep3(state) {
  // ChatGPT 注册入口：Step 3 填写密码
  if (state.signupEntry === 'chatgpt') {
    await addLog('Step 3: ChatGPT 注册入口，准备填写密码...');
    
    // 密码应该在 Step 2 已经生成
    if (!state.password) {
      throw new Error('No password generated. This should not happen.');
    }
    
    // 智能判断使用哪个 source：检查 registry 中的 ready 状态
    // Step 2 点击"继续"后页面会跳转到 auth.openai.com，所以 Step 3 更可能在 signup-page 执行
    const registry = await getTabRegistry();
    const chatgptReady = registry['chatgpt']?.ready;
    const signupPageReady = registry['signup-page']?.ready;
    
    let targetSource = 'signup-page';
    if (signupPageReady) {
      // signup-page 已经准备好，说明已经跳转
      targetSource = 'signup-page';
      await addLog('Step 3: Page has transitioned to auth.openai.com, using signup-page source');
    } else if (chatgptReady) {
      // chatgpt 还在，说明还没跳转（不太可能，但以防万一）
      targetSource = 'chatgpt';
      await addLog('Step 3: Still on chatgpt.com, using chatgpt source');
    } else {
      // 都没准备好，等待 signup-page（因为 Step 3 更可能在跳转后执行）
      targetSource = 'signup-page';
      await addLog('Step 3: Waiting for signup-page content script to be ready');
    }
    
    // 通知 content script 填写密码
    await sendToContentScript(targetSource, {
      type: 'EXECUTE_STEP',
      step: 3,
      source: 'background',
      payload: { 
        signupEntry: 'chatgpt',
        password: state.password
      },
    });
    
    return;
  }
  
  // OAuth 授权入口（原有逻辑）
  let email = state.email;

  // 获取邮箱类型
  const { emailType } = await chrome.storage.local.get('emailType');
  
  if (emailType === 'hotmail') {
    // === Hotmail 模式 ===
    await addLog('Step 3: 使用 Hotmail 邮箱模式', 'info');
    
    try {
      // 初始化管理器
      const hotmailManager = new HotmailManager();
      await hotmailManager.init();
      
      // 获取下一个可用邮箱
      const emailData = await hotmailManager.getNextAvailableEmail();
      await addLog(`Step 3: 选择邮箱 ${emailData.email} (使用次数: ${emailData.usageCount}/6)`, 'info');
      
      // 生成别名
      const alias = hotmailManager.generateAlias(emailData.email, emailData.usageCount);
      await addLog(`Step 3: 生成别名 ${alias}`, 'info');
      
      // 保存当前使用的邮箱信息
      await chrome.storage.session.set({
        currentHotmailData: emailData,
        currentEmailAlias: alias
      });
      
      email = alias;
      await setState({ email });
      
      await addLog(`Step 3: Hotmail 邮箱已设置: ${email}`);
      chrome.runtime.sendMessage({
        type: 'DATA_UPDATED',
        payload: { generatedEmail: email },
      }).catch(() => {});
      
    } catch (error) {
      await addLog(`Step 3: Hotmail 邮箱获取失败: ${error.message}`, 'error');
      throw error;
    }
    
  } else {
    // === 2925 模式 ===
    // 自动生成 2925 邮箱：前缀 + _ + 随机4位 + @2925.com
    if (!state.emailPrefix) {
      throw new Error('2925 邮箱前缀未设置，请在侧边栏填写。');
    }
    email = `${state.emailPrefix}_${generateRandomSuffix(4)}@2925.com`;
    await setState({ email });
    await addLog(`Step 3: 2925 邮箱已生成: ${email}`);
    chrome.runtime.sendMessage({
      type: 'DATA_UPDATED',
      payload: { generatedEmail: email },
    }).catch(() => {});
  }

  // Generate a unique password for this account
  const password = await getPassword();
  await setState({ password });
  
  // 通知侧边栏显示密码
  chrome.runtime.sendMessage({
    type: 'DATA_UPDATED',
    payload: { generatedPassword: password },
  }).catch(() => {});

  // Save account record
  const accounts = state.accounts || [];
  accounts.push({ email, password, createdAt: new Date().toISOString() });
  await setState({ accounts });

  // 通知侧边栏更新账号列表
  chrome.runtime.sendMessage({
    type: 'ACCOUNT_SAVED',
    payload: { email, password },
  }).catch(() => {});

  await addLog(`Step 3: Filling email ${email}, password generated (${password.length} chars)`);
  
  // Step 3 不需要创建新标签页，直接发送消息到已存在的 signup-page
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 3,
    source: 'background',
    payload: { email, password },
  });
}

// ============================================================
// Step 4: Get Signup Verification Code (qq-mail.js polls, then fills in signup-page.js)
// ============================================================

function getMailConfig(state) {
  // 只支持 2925 邮箱
  return { source: 'mail-2925', url: 'https://2925.com/#/mailList', label: '2925 Mail' };
}

async function executeStep4(state) {
  // 获取邮箱类型
  const { emailType } = await chrome.storage.local.get('emailType');
  
  if (emailType === 'hotmail') {
    // === Hotmail 模式：使用小苹果 API ===
    await addLog('Step 4: 通过小苹果 API 获取注册验证码...');
    
    try {
      const { currentHotmailData } = await chrome.storage.session.get('currentHotmailData');
      
      if (!currentHotmailData) {
        throw new Error('未找到 Hotmail 邮箱信息');
      }
      
      const appleAPI = new AppleMailAPI();
      
      // 获取验证码（自动重试，检查收件箱和垃圾箱）
      await addLog('Step 4: 正在获取验证码（最多尝试 10 次）...');
      const result = await appleAPI.getVerificationCode({
        refreshToken: currentHotmailData.refreshToken,
        clientId: currentHotmailData.clientId,
        email: currentHotmailData.email
      }, 10, 3000);
      
      await addLog(`Step 4: ✅ 在 ${result.mailbox} 找到验证码: ${result.code}`, 'ok');
      
      // 清空邮箱（防止下次混淆）
      await addLog('Step 4: 清空邮箱...');
      await appleAPI.clearAllMailboxes({
        refreshToken: currentHotmailData.refreshToken,
        clientId: currentHotmailData.clientId,
        email: currentHotmailData.email
      });
      await addLog('Step 4: 邮箱已清空', 'ok');
      
      // 保存验证码
      await setState({ signupVerificationCode: result.code });
      
      // 填写验证码到注册页面
      const signupTabId = await getTabId('signup-page');
      if (!signupTabId) {
        throw new Error('注册页面已关闭，无法填写验证码');
      }
      
      await chrome.tabs.update(signupTabId, { active: true });
      await sendToContentScript('signup-page', {
        type: 'FILL_CODE',
        step: 4,
        source: 'background',
        payload: { code: result.code },
      });
      
      await addLog('Step 4: 验证码已填写', 'ok');
      return;
      
    } catch (error) {
      await addLog(`Step 4: 获取验证码失败: ${error.message}`, 'error');
      throw error;
    }
  }
  
  // === 2925 模式（原有逻辑）===
  const mail = getMailConfig(state);
  await addLog(`Step 4: Opening ${mail.label}...`);

  // For mail tabs, only create if not alive — don't navigate (preserves login session)
  const alive = await isTabAlive(mail.source);
  if (alive) {
    const tabId = await getTabId(mail.source);
    await chrome.tabs.update(tabId, { active: true });
    await addLog(`Step 4: Reused existing mail tab ${tabId}`, 'info');
  } else {
    // 邮箱操作不使用无痕模式，始终在普通窗口中打开
    await reuseOrCreateTab(mail.source, mail.url);
    await addLog(`Step 4: Created new mail tab in normal window`, 'info');
  }

  const MAX_RESEND_ATTEMPTS = 5; // 最多重新发送 5 次
  let cycle = 1;
  
  // 提取收件人邮箱用于过滤（2925 模式）
  const recipientEmail = state.email || '';
  
  while (cycle <= MAX_RESEND_ATTEMPTS) {
    // 检查是否请求重置
    if (resetRequested) {
      throw new Error('Flow reset requested - aborting email polling');
    }
    
    const cycleStartedAt = Date.now();
    
    if (cycle === 1) {
      await addLog(`Step 4: Polling signup verification code (first attempt)...`);
    } else {
      await addLog(`Step 4: Polling signup verification code, resend attempt ${cycle - 1}/${MAX_RESEND_ATTEMPTS - 1}...`);
    }

    const result = await sendToContentScript(mail.source, {
      type: 'POLL_EMAIL',
      step: 4,
      source: 'background',
      payload: {
        filterAfterTimestamp: cycleStartedAt,
        senderFilters: ['openai', 'noreply', 'verify', 'auth'],
        subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm'],
        recipientEmail: recipientEmail,  // 添加收件人过滤
        maxAttempts: 3,  // 3 次轮询
        intervalMs: 3000,  // 每次间隔 3 秒（总计 9 秒）
      },
    });

    // 检查是否成功获取到验证码
    if (result && result.code && !result.error) {
      await setState({
        lastEmailTimestamp: result.emailTimestamp,
        signupVerificationCode: result.code,
      });
      await addLog(`Step 4: Got verification code: ${result.code}`);

      const signupTabId = await getTabId('signup-page');
      if (!signupTabId) {
        throw new Error('Signup page tab was closed. Cannot fill verification code.');
      }

      await chrome.tabs.update(signupTabId, { active: true });
      await sendToContentScript('signup-page', {
        type: 'FILL_CODE',
        step: 4,
        source: 'background',
        payload: { code: result.code },
      });
      return;
    }

    // 未获取到验证码（result.error 存在或 result.code 不存在）
    if (result && result.error) {
      await addLog(`Step 4: Email polling failed: ${result.error}`, 'warn');
    }

    // 未获取到验证码
    if (cycle < MAX_RESEND_ATTEMPTS) {
      // 再次检查是否请求重置
      if (resetRequested) {
        throw new Error('Flow reset requested - aborting email polling');
      }
      
      await addLog(`Step 4: No signup code found in attempt ${cycle}, requesting resend email...`, 'warn');

      const signupTabId = await getTabId('signup-page');
      if (!signupTabId) {
        throw new Error('Signup page tab was closed. Cannot click resend verification email.');
      }

      // 切换到注册页面
      await chrome.tabs.update(signupTabId, { active: true });
      await addLog(`Step 4: Switched to signup page, waiting for page to be ready...`, 'info');
      await sleepRandom(1500, 2500); // 等待页面准备好
      
      // 再次检查是否请求重置
      if (resetRequested) {
        throw new Error('Flow reset requested - aborting email polling');
      }
      
      // 点击重新发送按钮
      await sendToContentScript('signup-page', {
        type: 'EXECUTE_STEP',
        step: 41,
        source: 'background',
        payload: {},
      });
      await addLog(`Step 4: Resend verification email clicked (attempt ${cycle})`, 'info');
      await sleepRandom(2500, 3500); // 等待邮件发送

      // 切换回邮箱页面
      const mailTabId = await getTabId(mail.source);
      if (mailTabId) {
        await chrome.tabs.update(mailTabId, { active: true });
        await addLog(`Step 4: Switched back to ${mail.label}, waiting for new email...`, 'info');
        await sleepRandom(1500, 2500); // 等待邮箱刷新
      }
      cycle += 1;
    } else {
      // 达到最大重试次数
      throw new Error(
        `Step 4: Failed to get signup verification code after ${MAX_RESEND_ATTEMPTS} attempts (1 initial + ${MAX_RESEND_ATTEMPTS - 1} resends). ` +
        'Please check email manually or try again later.'
      );
    }
  }
}

// ============================================================
// Step 5: Fill Name & Birthday (via signup-page.js)
// ============================================================

async function executeStep5(state) {
  const { firstName, lastName } = generateRandomName();
  const { year, month, day } = generateRandomBirthday();

  await addLog(`Step 5: Generated name: ${firstName} ${lastName}, Birthday: ${year}-${month}-${day}`);

  // Step 5 不需要创建新标签页，直接发送消息到已存在的 signup-page
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 5,
    source: 'background',
    payload: { 
      firstName, 
      lastName, 
      year, 
      month, 
      day,
      signupEntry: state.signupEntry  // 传递注册入口类型
    },
  });
}

// ============================================================
// Step 6: Login ChatGPT (Background opens tab, chatgpt.js handles login)
// ============================================================

async function executeStep6(state) {
  // ChatGPT 注册入口：需要先获取 OAuth URL
  if (state.signupEntry === 'chatgpt' && !state.oauthUrl) {
    await addLog('Step 6: ChatGPT 注册完成，现在获取 OAuth URL...');
    
    // 根据运行模式获取 OAuth URL
    if (state.localMode) {
      // 本地模式：生成本地 OAuth 链接
      const local = await buildLocalOAuthUrl();
      await setState({
        oauthUrl: local.oauthUrl,
        oauthCodeVerifier: local.codeVerifier,
        oauthState: local.state,
      });
      
      await addLog('Step 6: 本地模式，已生成 OAuth 链接', 'ok');
      
      chrome.runtime.sendMessage({
        type: 'DATA_UPDATED',
        payload: { oauthUrl: local.oauthUrl },
      }).catch(() => {});
    } else {
      // CPA 模式：从 CPA 面板获取 OAuth 链接
      await addLog('Step 6: CPA 模式，正在打开 CPA 面板获取 OAuth 链接...');
      await reuseOrCreateTab('vps-panel', state.vpsUrl, { 
        inject: ['content/utils.js', 'content/vps-panel.js'],
        reloadIfSameUrl: true
      });

      await sendToContentScript('vps-panel', {
        type: 'EXECUTE_STEP',
        step: 1,  // 使用 Step 1 的逻辑获取 OAuth URL
        source: 'background',
        payload: {},
      });
      
      // 等待 OAuth URL 获取完成
      await waitForStepComplete(1, 60000);
      
      // 重新获取 state（OAuth URL 应该已经设置）
      const newState = await getState();
      if (!newState.oauthUrl) {
        throw new Error('Failed to get OAuth URL from CPA panel');
      }
      
      await addLog('Step 6: OAuth URL 已获取', 'ok');
    }
    
    // 重新获取 state
    const updatedState = await getState();
    // 继续执行 Step 6 的登录逻辑
    return executeStep6Login(updatedState);
  }
  
  // OAuth 授权入口或已有 OAuth URL 的情况
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }
  
  return executeStep6Login(state);
}

async function executeStep6Login(state) {
  if (!state.email) {
    throw new Error('No email. Complete step 3 first.');
  }

  // 如果启用无痕模式，在无痕窗口中打开
  if (state.incognitoMode) {
    await addLog(`Step 6: Opening OAuth URL in incognito window for login...`);
    // Close old signup-page tab (registration is done) and open incognito for login
    const oldSignupTabId = await getTabId('signup-page');
    if (oldSignupTabId) {
      try { await chrome.tabs.remove(oldSignupTabId); } catch {}
    }
    await createIncognitoTab('signup-page', state.oauthUrl);
  } else {
    await addLog(`Step 6: Opening OAuth URL for login...`);
    // Reuse the signup-page tab — navigate it to the OAuth URL
    await reuseOrCreateTab('signup-page', state.oauthUrl);
  }

  // signup-page.js will inject (same auth.openai.com domain) and handle login
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 6,
    source: 'background',
    payload: { email: state.email, password: state.password },
  });
}

// ============================================================
// Step 7: Get Login Verification Code (qq-mail.js polls, then fills in chatgpt.js)
// ============================================================

async function executeStep7(state) {
  // 获取邮箱类型
  const { emailType } = await chrome.storage.local.get('emailType');
  
  if (emailType === 'hotmail') {
    // === Hotmail 模式：使用小苹果 API ===
    await addLog('Step 7: 通过小苹果 API 获取登录验证码...');
    
    try {
      const { currentHotmailData } = await chrome.storage.session.get('currentHotmailData');
      
      if (!currentHotmailData) {
        throw new Error('未找到 Hotmail 邮箱信息');
      }
      
      const appleAPI = new AppleMailAPI();
      
      // 获取验证码
      await addLog('Step 7: 正在获取验证码（最多尝试 10 次）...');
      const result = await appleAPI.getVerificationCode({
        refreshToken: currentHotmailData.refreshToken,
        clientId: currentHotmailData.clientId,
        email: currentHotmailData.email
      }, 10, 3000);
      
      await addLog(`Step 7: ✅ 在 ${result.mailbox} 找到验证码: ${result.code}`, 'ok');
      
      // 清空邮箱
      await addLog('Step 7: 清空邮箱...');
      await appleAPI.clearAllMailboxes({
        refreshToken: currentHotmailData.refreshToken,
        clientId: currentHotmailData.clientId,
        email: currentHotmailData.email
      });
      await addLog('Step 7: 邮箱已清空', 'ok');
      
      // 保存验证码
      await setState({ loginVerificationCode: result.code });
      
      // 填写验证码到登录页面
      const signupTabId = await getTabId('signup-page');
      if (!signupTabId) {
        throw new Error('登录页面已关闭，无法填写验证码');
      }
      
      await chrome.tabs.update(signupTabId, { active: true });
      await sendToContentScript('signup-page', {
        type: 'FILL_CODE',
        step: 7,
        source: 'background',
        payload: { code: result.code },
      });
      
      await addLog('Step 7: 验证码已填写', 'ok');
      return;
      
    } catch (error) {
      await addLog(`Step 7: 获取验证码失败: ${error.message}`, 'error');
      throw error;
    }
  }
  
  // === 2925 模式（原有逻辑）===
  const mail = getMailConfig(state);
  await addLog(`Step 7: Opening ${mail.label}...`);

  const alive = await isTabAlive(mail.source);
  if (alive) {
    const tabId = await getTabId(mail.source);
    await chrome.tabs.update(tabId, { active: true });
    await addLog(`Step 7: Reused existing mail tab ${tabId}`, 'info');
  } else {
    // 邮箱操作不使用无痕模式，始终在普通窗口中打开
    await reuseOrCreateTab(mail.source, mail.url);
    await addLog(`Step 7: Created new mail tab in normal window`, 'info');
  }

  const MAX_RESEND_ATTEMPTS = 5; // 最多重新发送 5 次
  let cycle = 1;
  
  // 提取收件人邮箱用于过滤（2925 模式）
  const recipientEmail = state.email || '';
  
  while (cycle <= MAX_RESEND_ATTEMPTS) {
    // 检查是否请求重置
    if (resetRequested) {
      throw new Error('Flow reset requested - aborting email polling');
    }
    
    const cycleStartedAt = Date.now();
    
    if (cycle === 1) {
      await addLog(`Step 7: Polling login verification code (first attempt)...`);
    } else {
      await addLog(`Step 7: Polling login verification code, resend attempt ${cycle - 1}/${MAX_RESEND_ATTEMPTS - 1}...`);
    }

    const result = await sendToContentScript(mail.source, {
      type: 'POLL_EMAIL',
      step: 7,
      source: 'background',
      payload: {
        filterAfterTimestamp: cycleStartedAt,
        strictChatGPTCodeOnly: true,
        excludeCodes: state.signupVerificationCode ? [state.signupVerificationCode] : [],
        senderFilters: ['openai', 'noreply', 'verify', 'auth', 'chatgpt'],
        subjectFilters: ['your chatgpt code is'],
        recipientEmail: recipientEmail,  // 添加收件人过滤
        maxAttempts: 3,  // 3 次轮询
        intervalMs: 3000,  // 每次间隔 3 秒（总计 9 秒）
      },
    });

    // 检查是否成功获取到验证码
    if (result && result.code && !result.error) {
      await addLog(`Step 7: Got login verification code: ${result.code}`);

      const signupTabId = await getTabId('signup-page');
      if (!signupTabId) {
        throw new Error('Auth page tab was closed. Cannot fill verification code.');
      }

      await chrome.tabs.update(signupTabId, { active: true });
      await sendToContentScript('signup-page', {
        type: 'FILL_CODE',
        step: 7,
        source: 'background',
        payload: { code: result.code },
      });
      return;
    }

    // 未获取到验证码（result.error 存在或 result.code 不存在）
    if (result && result.error) {
      await addLog(`Step 7: Email polling failed: ${result.error}`, 'warn');
    }

    // 未获取到验证码
    if (cycle < MAX_RESEND_ATTEMPTS) {
      // 再次检查是否请求重置
      if (resetRequested) {
        throw new Error('Flow reset requested - aborting email polling');
      }
      
      await addLog(`Step 7: No login code found in attempt ${cycle}, requesting resend email...`, 'warn');

      const signupTabId = await getTabId('signup-page');
      if (!signupTabId) {
        throw new Error('Auth page tab was closed. Cannot click resend verification email.');
      }

      // 切换到登录页面
      await chrome.tabs.update(signupTabId, { active: true });
      await addLog(`Step 7: Switched to login page, waiting for page to be ready...`, 'info');
      await sleepRandom(1500, 2500); // 等待页面准备好
      
      // 再次检查是否请求重置
      if (resetRequested) {
        throw new Error('Flow reset requested - aborting email polling');
      }
      
      // 点击重新发送按钮
      await sendToContentScript('signup-page', {
        type: 'EXECUTE_STEP',
        step: 71,
        source: 'background',
        payload: {},
      });
      await addLog(`Step 7: Resend verification email clicked (attempt ${cycle})`, 'info');
      await sleepRandom(2500, 3500); // 等待邮件发送

      // 再次检查是否请求重置
      if (resetRequested) {
        throw new Error('Flow reset requested - aborting email polling');
      }

      // 切换回邮箱页面
      const mailTabId = await getTabId(mail.source);
      if (mailTabId) {
        await chrome.tabs.update(mailTabId, { active: true });
        await addLog(`Step 7: Switched back to ${mail.label}, waiting for new email...`, 'info');
        await sleepRandom(1500, 2500); // 等待邮箱刷新
      }
      cycle += 1;
    } else {
      // 达到最大重试次数
      throw new Error(
        `Step 7: Failed to get login verification code after ${MAX_RESEND_ATTEMPTS} attempts (1 initial + ${MAX_RESEND_ATTEMPTS - 1} resends). ` +
        'Please check email manually or try again later.'
      );
    }
  }
}

// ============================================================
// Step 8: Complete OAuth (webNavigation listener + chatgpt.js navigates)
// ============================================================

let webNavListener = null;

async function executeStep8(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }

  await addLog('Step 8: Setting up OAuth callback redirect listener...');
  const expectedRedirect = getExpectedRedirectFromOAuthUrl(state.oauthUrl);
  if (expectedRedirect?.href) {
    await addLog(`Step 8: Expecting OAuth callback target: ${expectedRedirect.href}`);
  } else {
    await addLog('Step 8: Could not parse redirect_uri from OAuth URL, using host/path fallback matching.', 'warn');
  }

  // Register webNavigation listener (scoped to this step)
  return new Promise((resolve, reject) => {
    let resolved = false;
    
    const cleanupListener = () => {
      if (webNavListener) {
        chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
        webNavListener = null;
      }
    };

    const timeout = setTimeout(() => {
      cleanupListener();
      setStepStatus(8, 'failed');
      addLog('Step 8: OAuth callback redirect not captured after 120s. Check if OAuth authorization completed.', 'error');
      reject(new Error('OAuth callback redirect not captured after 120s. Check if OAuth authorization completed.'));
    }, 120000);  // 增加到 120 秒超时

    webNavListener = (details) => {
      // 检测是否跳转到 add-phone 页面（需要手机验证，注册失败）
      if (details.url.includes('/add-phone')) {
        console.log(LOG_PREFIX, `Detected add-phone redirect: ${details.url}`);
        resolved = true;
        cleanupListener();
        clearTimeout(timeout);

        // 使用 async IIFE 来正确处理 await
        (async () => {
          await setState({ registrationFailed: true, failureReason: 'phone_verification_required' });
          await addLog(`Step 8: Registration failed - phone verification required (add-phone page detected)`, 'warn');
          await addLog(`Step 8: Skipping Step 9, will restart registration flow...`, 'info');
          await setStepStatus(8, 'completed');
          notifyStepComplete(8, { skipStep9: true, reason: 'phone_verification_required' });
          chrome.runtime.sendMessage({
            type: 'DATA_UPDATED',
            payload: { registrationFailed: true, failureReason: 'phone_verification_required' },
          }).catch(() => {});
          resolve({ skipStep9: true, reason: 'phone_verification_required' });
        })();
        return;
      }
      
      if (isExpectedOAuthCallbackUrl(details.url, expectedRedirect)) {
        console.log(LOG_PREFIX, `Captured OAuth callback redirect: ${details.url}`);
        resolved = true;
        cleanupListener();
        clearTimeout(timeout);

        setState({ localhostUrl: details.url }).then(() => {
          addLog(`Step 8: Captured callback URL: ${details.url}`, 'ok');
          setStepStatus(8, 'completed');
          notifyStepComplete(8, { localhostUrl: details.url });
          chrome.runtime.sendMessage({
            type: 'DATA_UPDATED',
            payload: { localhostUrl: details.url },
          }).catch(() => {});
          resolve();
        });
      }
    };

    chrome.webNavigation.onBeforeNavigate.addListener(webNavListener);

    // After step 7, the auth page shows a consent screen ("使用 ChatGPT 登录到 Codex")
    // with a "继续" button. We locate the button in-page, then click it through
    // the debugger Input API directly.
    (async () => {
      try {
        let signupTabId = await getTabId('signup-page');
        if (signupTabId) {
          await chrome.tabs.update(signupTabId, { active: true });
          await addLog('Step 8: Switched to auth page. Preparing debugger click...');
        } else {
          // 如果启用无痕模式，在无痕窗口中打开
          if (state.incognitoMode) {
            await addLog(`Step 8: Reopening auth page in incognito window...`);
            signupTabId = await createIncognitoTab('signup-page', state.oauthUrl);
          } else {
            await addLog(`Step 8: Reopening auth page...`);
            signupTabId = await reuseOrCreateTab('signup-page', state.oauthUrl);
          }
          await addLog('Step 8: Auth tab reopened. Preparing debugger click...');
        }

        const MAX_CLICK_RETRIES = 5;
        let clickSuccess = false;
        
        for (let attempt = 1; attempt <= MAX_CLICK_RETRIES; attempt++) {
          // 检查是否已经跳转（可能上次点击延迟生效）
          if (resolved) {
            await addLog(`Step 8: 检测到页面已跳转，停止重试`, 'ok');
            clickSuccess = true;
            break;
          }
          
          // 在点击前检查当前页面 URL，如果已经是 add-phone 则停止
          try {
            const currentTab = await chrome.tabs.get(signupTabId);
            if (currentTab.url && currentTab.url.includes('/add-phone')) {
              await addLog(`Step 8: 检测到当前页面已是 add-phone，停止点击尝试`, 'warn');
              resolved = true;
              cleanupListener();
              clearTimeout(timeout);  // 清理 timeout
              await setState({ registrationFailed: true, failureReason: 'phone_verification_required' });
              await addLog(`Step 8: Registration failed - phone verification required (add-phone page detected)`, 'warn');
              await addLog(`Step 8: Skipping Step 9, will restart registration flow...`, 'info');
              await setStepStatus(8, 'completed');  // 添加 await
              notifyStepComplete(8, { skipStep9: true, reason: 'phone_verification_required' });
              chrome.runtime.sendMessage({
                type: 'DATA_UPDATED',
                payload: { registrationFailed: true, failureReason: 'phone_verification_required' },
              }).catch(() => {});
              resolve({ skipStep9: true, reason: 'phone_verification_required' });
              return;
            }
          } catch (tabErr) {
            await addLog(`Step 8: 无法检查当前页面 URL: ${tabErr.message}`, 'warn');
          }
          
          try {
            await addLog(`Step 8: 尝试点击"继续"按钮 (${attempt}/${MAX_CLICK_RETRIES})...`);
            
            // 阶段1: 查找按钮位置
            const clickResult = await sendToContentScript('signup-page', {
              type: 'STEP8_FIND_AND_CLICK',
              source: 'background',
              payload: {},
            });

            console.log(LOG_PREFIX, `Step 8: clickResult received (attempt ${attempt}):`, clickResult);

            if (clickResult?.error) {
              throw new Error(clickResult.error);
            }
            
            if (!clickResult) {
              throw new Error('Step 8: No response from content script (clickResult is null/undefined)');
            }
            
            if (!clickResult.rect) {
              throw new Error(`Step 8: Content script did not return rect. Received: ${JSON.stringify(clickResult)}`);
            }

            // 记录详细信息
            await addLog(`Step 8: 按钮位置: (${clickResult.rect.centerX}, ${clickResult.rect.centerY})`);
            await addLog(`Step 8: 按钮文本: "${clickResult.buttonText}"`);
            await addLog(`Step 8: 当前页面: ${clickResult.url?.slice(0, 80)}...`);

            // 阶段2: 使用 Debugger API 点击
            if (!resolved) {
              await clickWithDebugger(signupTabId, clickResult.rect);
              await addLog(`Step 8: Debugger 点击已执行 (尝试 ${attempt}/${MAX_CLICK_RETRIES})`);
              
              // 等待 3 秒，检查是否有 redirect
              await addLog(`Step 8: 等待 3 秒检查页面跳转...`);
              await new Promise(r => setTimeout(r, 3000));
              
              // 检查是否已经跳转
              if (resolved) {
                await addLog(`Step 8: 点击成功，页面已跳转`, 'ok');
                clickSuccess = true;
                break;
              }
              
              // 获取点击后的页面状态
              try {
                const afterState = await sendToContentScript('signup-page', {
                  type: 'GET_PAGE_STATE',
                  source: 'background',
                  payload: {},
                });
                
                if (afterState) {
                  await addLog(`Step 8: 点击后页面 URL: ${afterState.url?.slice(0, 80)}...`);
                  await addLog(`Step 8: 点击后按钮状态: ${afterState.buttonExists ? (afterState.buttonDisabled ? '存在(禁用)' : '存在(启用)') : '不存在'}`);
                  
                  // 如果按钮消失或被禁用，说明点击可能生效了，继续等待
                  if (!afterState.buttonExists || afterState.buttonDisabled) {
                    await addLog(`Step 8: 按钮状态已改变，可能正在处理，继续等待跳转...`, 'info');
                    clickSuccess = true;
                    break;
                  }
                }
              } catch (stateErr) {
                await addLog(`Step 8: 无法获取点击后状态: ${stateErr.message}`, 'warn');
              }
              
              // 如果没有跳转且按钮状态未变，准备重试
              if (attempt < MAX_CLICK_RETRIES) {
                await addLog(`Step 8: 点击后未检测到跳转或状态变化，2秒后重试...`, 'warn');
                await new Promise(r => setTimeout(r, 2000));
              } else {
                await addLog(`Step 8: 已尝试 ${MAX_CLICK_RETRIES} 次点击，继续等待页面跳转...`, 'warn');
                // 不抛出异常，继续等待 redirect listener
              }
            }
          } catch (err) {
            await addLog(`Step 8: 点击尝试 ${attempt}/${MAX_CLICK_RETRIES} 失败: ${err.message}`, 'warn');
            
            if (attempt === MAX_CLICK_RETRIES) {
              // 最后一次尝试失败，但不立即 reject，继续等待 redirect listener
              await addLog(`Step 8: 所有点击尝试均失败，但继续等待页面跳转（可能需要人工点击）...`, 'warn');
            } else {
              await new Promise(r => setTimeout(r, 2000));
            }
          }
        }
        
        if (!clickSuccess && !resolved) {
          await addLog(`Step 8: 自动点击未成功，等待用户手动点击或页面自动跳转...`, 'warn');
        }
        
      } catch (err) {
        clearTimeout(timeout);
        cleanupListener();
        reject(err);
      }
    })();
  });
}

// ============================================================
// Step 9: VPS Verify (via vps-panel.js)
// ============================================================

function makeTimestampForFile() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

async function downloadAuthResultFile(state) {
  const callback = parseCallbackFromUrl(state.localhostUrl || '');
  if (!callback || !callback.code) {
    throw new Error('回调 URL 无法解析出 code，无法本地换取 token。');
  }
  if (callback.error) {
    throw new Error(`授权回调返回错误: ${callback.error}`);
  }
  if (!state.oauthCodeVerifier) {
    throw new Error('缺少 PKCE code_verifier，请重新从第1步开始。');
  }
  if (state.oauthState && callback.state !== state.oauthState) {
    throw new Error('回调 state 与本地记录不匹配，请重新开始流程。');
  }

  await addLog('Step 9: 正在本地换取 token...', 'info');
  const tokens = await exchangeTokenWithOpenAI(callback.code, state.oauthCodeVerifier);
  const payload = buildCodexTokenFile(tokens);
  const filename = `token_${Date.now()}.json`;
  const content = JSON.stringify(payload, null, 2);
  const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(content)}`;

  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false,
  });

  await addLog(`Step 9: 本地换取成功，已下载 ${filename}`, 'ok');
}

async function executeStep9(state) {
  // 检查是否因为 add-phone 而跳过 Step 9
  if (state.registrationFailed && state.failureReason === 'phone_verification_required') {
    await addLog('Step 9: Skipped due to phone verification requirement (add-phone detected in Step 8)', 'warn');
    await setStepStatus(9, 'skipped');
    notifyStepComplete(9, { skipped: true, reason: 'phone_verification_required' });
    return;
  }
  
  if (!state.localhostUrl) {
    throw new Error('No localhost URL. Complete step 8 first.');
  }
  
  // 本地模式：直接下载认证文件（不需要 CPA 接口）
  if (state.localMode || !state.vpsUrl) {
    await addLog('Step 9: 本地模式，正在生成并保存认证文件...', 'info');
    
    // 调用 downloadAuthFile 函数（会根据 localMode 自动处理）
    try {
      await downloadAuthFile(state);
      await setStepStatus(9, 'completed');
      notifyStepComplete(9, { mode: 'local' });
    } catch (err) {
      // 如果保存失败，使用浏览器下载作为后备方案
      await addLog(`Step 9: 保存到本地失败 (${err.message})，使用浏览器下载作为后备方案`, 'warn');
      await downloadAuthResultFile(state);
      await setStepStatus(9, 'completed');
      notifyStepComplete(9, { mode: 'download' });
    }
    return;
  }

  // CPA 模式：通过 VPS 面板验证
  await addLog('Step 9: Opening VPS panel...');

  let tabId = await getTabId('vps-panel');
  const alive = tabId && await isTabAlive('vps-panel');

  if (!alive) {
    // Create new tab
    const tab = await chrome.tabs.create({ url: state.vpsUrl, active: true });
    tabId = tab.id;
    await new Promise(resolve => {
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  } else {
    await chrome.tabs.update(tabId, { active: true });
  }

  // Inject scripts directly and wait for them to be ready
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/utils.js', 'content/vps-panel.js'],
  });
  await new Promise(r => setTimeout(r, 1000));

  // Send command directly — bypass queue/ready mechanism
  await addLog(`Step 9: Filling callback URL...`);
  await chrome.tabs.sendMessage(tabId, {
    type: 'EXECUTE_STEP',
    step: 9,
    source: 'background',
    payload: { localhostUrl: state.localhostUrl },
  });
  
  // 注意：不在这里等待 Step 9 完成，让 VPS 面板的 STEP_COMPLETE 消息
  // 直接通知外层的 executeStepAndWait，避免覆盖 stepWaiters
  
  // VPS 面板会发送 STEP_COMPLETE 消息，触发 notifyStepComplete(9)
  // 这会解除外层 executeStepAndWait 中的 waitForStepComplete(9)
}

/**
 * 从 CPA 接口下载认证文件
 */
async function downloadAuthFile(state) {
  const { vpsUrl, email, saveToLocal, localSavePath, localMode, oauthCodeVerifier, localhostUrl } = state;
  
  // 添加详细日志
  await addLog(`Step 9: 检查保存设置 - localMode: ${localMode}, saveToLocal: ${saveToLocal}, localSavePath: ${localSavePath}`, 'info');
  
  // 检查是否启用本地保存
  if (!saveToLocal) {
    await addLog('Step 9: 未勾选"保存账号信息到本地"，跳过下载认证文件', 'info');
    return;
  }
  
  if (!localSavePath) {
    await addLog('Step 9: 未选择保存文件夹，跳过下载认证文件', 'warn');
    return;
  }
  
  if (!email) {
    await addLog('Step 9: 没有邮箱信息，无法下载认证文件', 'warn');
    return;
  }
  
  // 本地模式：使用本地生成的认证文件
  if (localMode) {
    await addLog('Step 9: 本地模式，使用本地生成的认证文件', 'info');
    
    if (!oauthCodeVerifier) {
      await addLog('Step 9: 缺少 code_verifier，无法生成认证文件', 'error');
      throw new Error('本地模式缺少 code_verifier');
    }
    
    if (!localhostUrl) {
      await addLog('Step 9: 缺少回调 URL，无法生成认证文件', 'error');
      throw new Error('本地模式缺少回调 URL');
    }
    
    try {
      // 从回调 URL 中提取 code
      const parsed = parseCallbackFromUrl(localhostUrl);
      if (!parsed || !parsed.code) {
        throw new Error('无法从回调 URL 中提取 authorization code');
      }
      
      await addLog(`Step 9: 正在使用 code 和 code_verifier 换取 token...`, 'info');
      
      // 使用 code 和 code_verifier 换取 token
      const tokens = await exchangeTokenWithOpenAI(parsed.code, oauthCodeVerifier);
      
      await addLog(`Step 9: Token 换取成功`, 'ok');
      
      // 构建认证文件
      const authData = buildCodexTokenFile(tokens);
      
      await addLog(`Step 9: 认证文件构建成功`, 'ok');
      
      // 保存到本地
      await saveAuthFileToLocal(authData, email);
      
      await addLog(`Step 9: 认证文件保存成功`, 'ok');
      return;
    } catch (err) {
      await addLog(`Step 9: 本地模式生成认证文件失败: ${err.message}`, 'error');
      throw err;
    }
  }
  
  // CPA 模式：从 CPA 接口下载认证文件
  if (!vpsUrl) {
    await addLog('Step 9: 没有 CPA 接口地址，无法下载认证文件', 'warn');
    return;
  }
  
  // 获取用户输入的 CPA 管理密钥
  const cpaKey = state.cpaManagementKey;
  if (!cpaKey || !cpaKey.trim()) {
    throw new Error('未设置 CPA 管理密钥，请在侧边栏"保存账号信息到本地"下方输入 CPA 管理密钥');
  }
  
  const trimmedKey = cpaKey.trim();
  if (!trimmedKey) {
    throw new Error('CPA 管理密钥不能为空');
  }
  
  try {
    // 从 vpsUrl 提取域名
    const url = new URL(vpsUrl);
    const baseUrl = `${url.protocol}//${url.host}`;
    
    await addLog(`Step 9: VPS 基础 URL: ${baseUrl}`, 'info');
    
    // 构建下载 URL - 将邮箱转换为小写
    const emailLowerCase = email.toLowerCase();
    const filename = `codex-${emailLowerCase}-free.json`;
    const downloadUrl = `${baseUrl}/v0/management/auth-files/download?name=${encodeURIComponent(filename)}`;
    
    await addLog(`Step 9: 正在下载认证文件: ${filename}`, 'info');
    await addLog(`Step 9: 下载 URL: ${downloadUrl}`, 'info');
    await addLog(`Step 9: 使用用户提供的 CPA 管理密钥`, 'info');
    
    // 检查 vps-panel 标签页是否存在
    const tabId = await getTabId('vps-panel');
    if (!tabId) {
      throw new Error('VPS 面板标签页不存在，无法下载认证文件');
    }
    
    await addLog(`Step 9: VPS 面板标签页 ID: ${tabId}`, 'info');
    
    // 添加超时机制，防止 executeScript 卡住
    const downloadPromise = chrome.scripting.executeScript({
      target: { tabId },
      func: async (downloadUrl, managementKey) => {
        try {
          console.log('[downloadAuthFile] 开始下载:', downloadUrl);
          console.log('[downloadAuthFile] 使用管理密钥:', managementKey.slice(0, 15) + '...');
          
          // 记录当前页面信息
          const pageInfo = {
            url: location.href,
            cookies: document.cookie ? '有 Cookie' : '无 Cookie',
            cookieCount: document.cookie.split(';').filter(c => c.trim()).length
          };
          
          // 直接使用传入的 management key 发起请求
          const response = await fetch(downloadUrl, {
            method: 'GET',
            credentials: 'include',
            headers: {
              'Accept': 'application/json',
              'Authorization': `Bearer ${managementKey}`
            }
          });
          
          console.log('[downloadAuthFile] 响应状态:', response.status, response.statusText);
          
          if (!response.ok) {
            let errorBody = '';
            try {
              errorBody = await response.text();
              console.log('[downloadAuthFile] 错误响应体:', errorBody);
            } catch (e) {
              console.log('[downloadAuthFile] 无法读取错误响应体:', e.message);
            }
            
            // 根据状态码提供更友好的错误提示
            let errorMessage = `下载失败: ${response.status} ${response.statusText}`;
            if (response.status === 401 || response.status === 403) {
              errorMessage += ' - 请检查 CPA 管理密钥是否正确';
            }
            
            return { 
              error: errorMessage,
              details: {
                status: response.status,
                statusText: response.statusText,
                errorBody: errorBody.slice(0, 200),
                pageInfo
              }
            };
          }
          
          const data = await response.json();
          console.log('[downloadAuthFile] 下载成功，数据大小:', JSON.stringify(data).length);
          
          return { success: true, data, pageInfo };
        } catch (err) {
          console.error('[downloadAuthFile] 异常:', err);
          return { 
            error: err.message,
            details: {
              name: err.name,
              stack: err.stack?.slice(0, 200)
            }
          };
        }
      },
      args: [downloadUrl, trimmedKey]
    });
    
    // 设置 15 秒超时
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('下载超时（15秒）')), 15000);
    });
    
    await addLog(`Step 9: 正在执行下载脚本...`, 'info');
    const results = await Promise.race([downloadPromise, timeoutPromise]);
    
    // executeScript 返回的是数组，取第一个结果
    if (!results || !Array.isArray(results) || results.length === 0) {
      await addLog(`Step 9: executeScript 返回空结果`, 'error');
      throw new Error('下载认证文件失败：executeScript 无返回结果');
    }
    
    await addLog(`Step 9: executeScript 返回结果数量: ${results.length}`, 'info');
    
    const result = results[0];
    
    if (!result || !result.result) {
      await addLog(`Step 9: result 结构异常: ${JSON.stringify(result)}`, 'error');
      throw new Error('下载认证文件失败：无返回数据');
    }
    
    const scriptResult = result.result;
    await addLog(`Step 9: 脚本执行结果: ${JSON.stringify(scriptResult).slice(0, 200)}`, 'info');
    
    // 检查脚本执行结果
    if (scriptResult.error) {
      // 记录详细的错误信息
      if (scriptResult.details) {
        await addLog(`Step 9: 错误详情 - 状态码: ${scriptResult.details.status}, 页面: ${scriptResult.details.pageInfo?.url}`, 'error');
        await addLog(`Step 9: 错误详情 - Cookie 状态: ${scriptResult.details.pageInfo?.cookies}, 数量: ${scriptResult.details.pageInfo?.cookieCount}`, 'error');
        if (scriptResult.details.errorBody) {
          await addLog(`Step 9: 服务器错误响应: ${scriptResult.details.errorBody}`, 'error');
        }
      }
      throw new Error(scriptResult.error);
    }
    
    if (!scriptResult.success || !scriptResult.data) {
      await addLog(`Step 9: 数据格式错误 - success: ${scriptResult.success}, data: ${!!scriptResult.data}`, 'error');
      throw new Error('下载认证文件失败：数据格式错误');
    }
    
    const authData = scriptResult.data;
    await addLog(`Step 9: 认证数据获取成功，大小: ${JSON.stringify(authData).length} 字节`, 'info');
    
    // 记录页面信息
    if (scriptResult.pageInfo) {
      await addLog(`Step 9: 下载时页面信息 - URL: ${scriptResult.pageInfo.url}, Cookie: ${scriptResult.pageInfo.cookies}`, 'info');
    }
    
    // 保存到本地
    await saveAuthFileToLocal(authData, email);
    
    await addLog(`Step 9: 认证文件下载并保存成功`, 'ok');
  } catch (err) {
    await addLog(`Step 9: 下载认证文件失败: ${err.message}`, 'error');
    await addLog(`Step 9: 错误堆栈: ${err.stack?.slice(0, 300)}`, 'error');
    // 不再抛出异常，让调用者决定如何处理
    throw err;
  }
}

/**
 * 保存认证文件到本地
 */
async function saveAuthFileToLocal(authData, email) {
  // 获取当前日期，格式: YYYY-MM-DD
  const now = new Date();
  const dateFolder = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  
  // 将邮箱转换为小写
  const emailLowerCase = email.toLowerCase();
  const filename = `codex-${emailLowerCase}-free.json`;
  
  // 获取当前模式
  const state = await getState();
  const mode = state.localMode ? 'local' : 'cpa';
  
  try {
    await addLog(`Step 9: 准备保存认证文件: ${filename} (${mode} 模式)`);
    
    // 将 JSON 转换为字符串
    const jsonContent = JSON.stringify(authData, null, 2);
    
    // 通知侧边栏保存文件
    const response = await chrome.runtime.sendMessage({
      type: 'SAVE_AUTH_FILE',
      payload: {
        content: jsonContent,
        filename: filename,
        dateFolder: dateFolder,
        mode: mode,  // 添加模式参数
      }
    });
    
    if (response && response.error) {
      throw new Error(response.error);
    }
    
    await addLog(`Step 9: 文件保存请求已发送到侧边栏`, 'ok');
  } catch (err) {
    throw new Error(`保存文件失败: ${err.message}`);
  }
}

// ============================================================
// Open Side Panel on extension icon click
// ============================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
