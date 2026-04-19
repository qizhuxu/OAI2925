// sidepanel/sidepanel.js - Side Panel logic

// ============================================================
// Hotmail 管理器初始化
// ============================================================
let hotmailManager;
let appleMailAPI;

async function initHotmailManager() {
  try {
    hotmailManager = new HotmailManager();
    await hotmailManager.init();
    appleMailAPI = new AppleMailAPI();
    await updateHotmailStats();
    console.log('[Hotmail] Manager initialized successfully');
  } catch (error) {
    console.error('[Hotmail] Initialization failed:', error);
  }
}

const STATUS_ICONS = {
  pending: '',
  running: '',
  completed: '\u2713',
  failed: '\u2717',
};

const logArea = document.getElementById('log-area');
const displayOauthUrl = document.getElementById('display-oauth-url');
const displayLocalhostUrl = document.getElementById('display-localhost-url');
const displayStatus = document.getElementById('display-status');
const statusBar = document.getElementById('status-bar');
const btnReset = document.getElementById('btn-reset');
const stepsProgress = document.getElementById('steps-progress');
const btnAutoRun = document.getElementById('btn-auto-run');
const btnAutoContinue = document.getElementById('btn-auto-continue');
const autoContinueBar = document.getElementById('auto-continue-bar');
const manualInterventionBar = document.getElementById('manual-intervention-bar');
const manualInterventionText = document.getElementById('manual-intervention-text');
const btnManualContinue = document.getElementById('btn-manual-continue');
const btnClearLog = document.getElementById('btn-clear-log');
const inputVpsUrl = document.getElementById('input-vps-url');
const inputRunCount = document.getElementById('input-run-count');
const inputEmailPrefix = document.getElementById('input-email-prefix');
const inputDefaultPassword = document.getElementById('input-default-password');
const btnToggleDefaultPassword = document.getElementById('btn-toggle-default-password');
const btnSaveConfig = document.getElementById('btn-save-config');
const displayGeneratedEmail = document.getElementById('display-generated-email');
const displayGeneratedPassword = document.getElementById('display-generated-password');
const btnStopFlow = document.getElementById('btn-stop-flow');
const btnResumeFlow = document.getElementById('btn-resume-flow');
const btnToggleVpsUrl = document.getElementById('btn-toggle-vps-url');
const btnCopyEmail = document.getElementById('btn-copy-email');
const btnCopyPassword = document.getElementById('btn-copy-password');
const btnCopyOauth = document.getElementById('btn-copy-oauth');
const btnCopyCallback = document.getElementById('btn-copy-callback');
const checkboxSaveLocal = document.getElementById('checkbox-save-local');
const btnSelectFolder = document.getElementById('btn-select-folder');
const btnSelectFolderCpa = document.getElementById('btn-select-folder-cpa');
const selectedFolderPath = document.getElementById('selected-folder-path');
const selectedFolderPathCpa = document.getElementById('selected-folder-path-cpa');
const localModeConfig = document.getElementById('local-mode-config');
const cpaModeConfig = document.getElementById('cpa-mode-config');
const inputCpaKey = document.getElementById('input-cpa-key');
const btnToggleCpaKey = document.getElementById('btn-toggle-cpa-key');
const cpaInterfaceRow = document.getElementById('cpa-interface-row');
const checkboxIncognitoMode = document.getElementById('checkbox-incognito-mode');
const selectRunMode = document.getElementById('select-run-mode');

let selectedFolderHandle = null;

// ============================================================
// IndexedDB 持久化文件夹句柄
// ============================================================

const DB_NAME = 'OAI2925_Config';
const DB_VERSION = 1;
const STORE_NAME = 'settings';

async function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

async function saveFolderHandle(handle) {
  try {
    console.log('[IndexedDB] Attempting to save folder handle...');
    const db = await openDB();
    console.log('[IndexedDB] Database opened');
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    
    await new Promise((resolve, reject) => {
      const request = store.put(handle, 'folderHandle');
      request.onsuccess = () => {
        console.log('[IndexedDB] Folder handle saved successfully');
        resolve();
      };
      request.onerror = () => {
        console.error('[IndexedDB] Save error:', request.error);
        reject(request.error);
      };
    });
    
    // 验证保存是否成功
    const verifyTx = db.transaction(STORE_NAME, 'readonly');
    const verifyStore = verifyTx.objectStore(STORE_NAME);
    const verifyRequest = verifyStore.get('folderHandle');
    verifyRequest.onsuccess = () => {
      if (verifyRequest.result) {
        console.log('[IndexedDB] Verification: Folder handle exists in DB');
      } else {
        console.error('[IndexedDB] Verification: Folder handle NOT found in DB');
      }
    };
  } catch (err) {
    console.error('[IndexedDB] Failed to save folder handle:', err);
    throw err;
  }
}

async function saveConfig(config) {
  try {
    console.log('[IndexedDB] Attempting to save config...');
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    
    await new Promise((resolve, reject) => {
      const request = store.put(config, 'userConfig');
      request.onsuccess = () => {
        console.log('[IndexedDB] Config saved successfully');
        resolve();
      };
      request.onerror = () => {
        console.error('[IndexedDB] Config save error:', request.error);
        reject(request.error);
      };
    });
  } catch (err) {
    console.error('[IndexedDB] Failed to save config:', err);
    throw err;
  }
}

async function loadConfig() {
  try {
    console.log('[IndexedDB] Attempting to load config...');
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    
    const config = await new Promise((resolve, reject) => {
      const request = store.get('userConfig');
      request.onsuccess = () => {
        console.log('[IndexedDB] Config loaded:', request.result);
        resolve(request.result);
      };
      request.onerror = () => {
        console.error('[IndexedDB] Config load error:', request.error);
        reject(request.error);
      };
    });
    
    return config || null;
  } catch (err) {
    console.error('[IndexedDB] Failed to load config:', err);
    return null;
  }
}

async function loadFolderHandle() {
  try {
    console.log('[IndexedDB] Attempting to load folder handle...');
    const db = await openDB();
    console.log('[IndexedDB] Database opened');
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    
    const handle = await new Promise((resolve, reject) => {
      const request = store.get('folderHandle');
      request.onsuccess = () => {
        console.log('[IndexedDB] Get request succeeded, result:', request.result);
        resolve(request.result);
      };
      request.onerror = () => {
        console.error('[IndexedDB] Get request error:', request.error);
        reject(request.error);
      };
    });
    
    if (!handle) {
      console.log('[IndexedDB] No saved folder handle found');
      return null;
    }
    
    console.log('[IndexedDB] Folder handle found, checking permissions...');
    console.log('[IndexedDB] Handle type:', handle.kind, 'Name:', handle.name);
    
    // 验证句柄是否仍然有效（只查询权限，不请求）
    try {
      const permission = await handle.queryPermission({ mode: 'readwrite' });
      console.log('[IndexedDB] Current permission:', permission);
      
      if (permission === 'granted') {
        console.log('[IndexedDB] Folder handle loaded and permission granted');
        return handle;
      }
      
      // 如果权限是 'prompt'，返回句柄但标记需要用户交互
      if (permission === 'prompt') {
        console.log('[IndexedDB] Permission is prompt, need user interaction');
        return { handle, needsPermission: true };
      }
      
      console.log('[IndexedDB] Folder handle permission denied');
      return null;
    } catch (permErr) {
      console.error('[IndexedDB] Permission check failed:', permErr);
      // 如果权限检查失败，可能是句柄已失效
      return null;
    }
  } catch (err) {
    console.error('[IndexedDB] Failed to load folder handle:', err);
    return null;
  }
}

async function requestFolderPermission(handle) {
  try {
    console.log('[IndexedDB] Requesting permission for folder handle...');
    const permission = await handle.requestPermission({ mode: 'readwrite' });
    console.log('[IndexedDB] Permission result:', permission);
    return permission === 'granted';
  } catch (err) {
    console.error('[IndexedDB] Failed to request permission:', err);
    return false;
  }
}

async function clearFolderHandle() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    
    await new Promise((resolve, reject) => {
      const request = store.delete('folderHandle');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    
    console.log('[IndexedDB] Folder handle cleared');
  } catch (err) {
    console.error('[IndexedDB] Failed to clear folder handle:', err);
  }
}

// ============================================================
// Toast Notifications
// ============================================================

const toastContainer = document.getElementById('toast-container');

const TOAST_ICONS = {
  error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  warn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

function showToast(message, type = 'error', duration = 4000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `${TOAST_ICONS[type] || ''}<span class="toast-msg">${escapeHtml(message)}</span><button class="toast-close">&times;</button>`;

  toast.querySelector('.toast-close').addEventListener('click', () => dismissToast(toast));
  toastContainer.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => dismissToast(toast), duration);
  }
}

function dismissToast(toast) {
  if (!toast.parentNode) return;
  toast.classList.add('toast-exit');
  toast.addEventListener('animationend', () => toast.remove());
}

// ============================================================
// State Restore on load
// ============================================================

async function restoreState() {
  try {
    console.log('[Restore] Starting state restoration...');
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' });
    console.log('[Restore] State received:', state);

    if (state.oauthUrl) {
      displayOauthUrl.textContent = state.oauthUrl;
      displayOauthUrl.classList.add('has-value');
      btnCopyOauth.style.display = 'inline-flex';
    }
    if (state.localhostUrl) {
      displayLocalhostUrl.textContent = state.localhostUrl;
      displayLocalhostUrl.classList.add('has-value');
      btnCopyCallback.style.display = 'inline-flex';
    }
    if (state.email) {
      displayGeneratedEmail.textContent = state.email;
      displayGeneratedEmail.classList.add('has-value');
      btnCopyEmail.style.display = 'inline-flex';
    }
    if (state.password) {
      displayGeneratedPassword.textContent = state.password;
      displayGeneratedPassword.classList.add('has-value');
      btnCopyPassword.style.display = 'inline-flex';
    }
    if (state.vpsUrl) {
      inputVpsUrl.value = state.vpsUrl;
    }
    if (state.emailPrefix) {
      inputEmailPrefix.value = state.emailPrefix;
    }
    
    // 从 IndexedDB 恢复用户配置
    console.log('[Restore] Attempting to load user config from IndexedDB...');
    const savedConfig = await loadConfig();
    
    // 如果有保存的配置，使用保存的配置；否则使用 background state 的配置
    const finalConfig = savedConfig || {
      runMode: state.localMode ? 'local' : 'cpa',
      saveToLocal: state.saveToLocal || false,
      incognitoMode: state.incognitoMode || false
    };
    
    if (savedConfig) {
      console.log('[Restore] User config loaded from IndexedDB:', savedConfig);
      
      // 恢复 CPA 接口（优先使用 IndexedDB，如果 background state 没有的话）
      if (savedConfig.vpsUrl) {
        inputVpsUrl.value = savedConfig.vpsUrl;
        if (!state.vpsUrl) {
          await chrome.runtime.sendMessage({
            type: 'SAVE_SETTING',
            source: 'sidepanel',
            payload: { vpsUrl: savedConfig.vpsUrl }
          });
        }
      }
      
      // 恢复邮箱前缀
      if (savedConfig.emailPrefix) {
        inputEmailPrefix.value = savedConfig.emailPrefix;
        if (!state.emailPrefix) {
          await chrome.runtime.sendMessage({
            type: 'SAVE_SETTING',
            source: 'sidepanel',
            payload: { emailPrefix: savedConfig.emailPrefix }
          });
        }
      }
      
      // 恢复默认密码
      if (savedConfig.defaultPassword) {
        inputDefaultPassword.value = savedConfig.defaultPassword;
        await chrome.runtime.sendMessage({
          type: 'SAVE_SETTING',
          source: 'sidepanel',
          payload: { defaultPassword: savedConfig.defaultPassword }
        });
      }
      
      // 恢复 CPA 密钥
      if (savedConfig.cpaManagementKey) {
        inputCpaKey.value = savedConfig.cpaManagementKey;
        if (!state.cpaManagementKey) {
          await chrome.runtime.sendMessage({
            type: 'SAVE_SETTING',
            source: 'sidepanel',
            payload: { cpaManagementKey: savedConfig.cpaManagementKey }
          });
        }
      }
      
      // 恢复注册入口
      if (savedConfig.signupEntry) {
        selectSignupEntry.value = savedConfig.signupEntry;
        await chrome.runtime.sendMessage({
          type: 'SAVE_SETTING',
          source: 'sidepanel',
          payload: { signupEntry: savedConfig.signupEntry }
        });
        console.log('[Restore] 注册入口已恢复:', savedConfig.signupEntry);
      }
      
      // 恢复邮箱类型
      if (savedConfig.emailType) {
        selectEmailType.value = savedConfig.emailType;
        await chrome.storage.local.set({ emailType: savedConfig.emailType });
        // 触发 change 事件以更新 UI
        selectEmailType.dispatchEvent(new Event('change'));
        console.log('[Restore] 邮箱类型已恢复:', savedConfig.emailType);
      }
    } else {
      console.log('[Restore] No saved config in IndexedDB, using background state');
    }
    
    // 统一设置 UI（无论是否有保存的配置）
    
    // 1. 恢复无痕模式设置
    const incognitoMode = finalConfig.incognitoMode;
    checkboxIncognitoMode.checked = incognitoMode;
    if (savedConfig && savedConfig.incognitoMode !== undefined) {
      await chrome.runtime.sendMessage({
        type: 'SAVE_SETTING',
        source: 'sidepanel',
        payload: { incognitoMode: incognitoMode }
      });
    }
    console.log('[Restore] 无痕模式已恢复:', incognitoMode);
    
    // 2. 恢复运行模式（重要：必须在"保存到本地"之前）
    const runMode = finalConfig.runMode;
    selectRunMode.value = runMode;
    const isLocalMode = runMode === 'local';
    
    // 设置 CPA 接口行的显示/隐藏
    if (isLocalMode) {
      inputVpsUrl.disabled = true;
      cpaInterfaceRow.style.display = 'none';
    } else {
      inputVpsUrl.disabled = false;
      cpaInterfaceRow.style.display = 'flex';
    }
    
    if (savedConfig && savedConfig.runMode) {
      await chrome.runtime.sendMessage({
        type: 'SAVE_SETTING',
        source: 'sidepanel',
        payload: { localMode: isLocalMode }
      });
    }
    console.log('[Restore] 运行模式已恢复:', runMode);
    
    // 3. 恢复"保存到本地"设置（依赖于运行模式）
    const saveToLocal = finalConfig.saveToLocal;
    checkboxSaveLocal.checked = saveToLocal;
    
    // 根据运行模式和"保存到本地"状态显示配置区域
    if (saveToLocal) {
      if (isLocalMode) {
        // 本地模式：显示文件夹选择
        localModeConfig.style.display = 'block';
        cpaModeConfig.style.display = 'none';
      } else {
        // CPA 模式：显示 CPA 密钥输入
        localModeConfig.style.display = 'none';
        cpaModeConfig.style.display = 'block';
      }
    } else {
      // 不保存到本地：隐藏所有配置
      localModeConfig.style.display = 'none';
      cpaModeConfig.style.display = 'none';
    }
    
    if (savedConfig && savedConfig.saveToLocal !== undefined) {
      await chrome.runtime.sendMessage({
        type: 'SAVE_SETTING',
        source: 'sidepanel',
        payload: { saveToLocal: saveToLocal }
      });
    }
    console.log('[Restore] 保存到本地已恢复:', saveToLocal, '| 运行模式:', runMode);
    console.log('[Restore] UI 状态 - localModeConfig:', localModeConfig.style.display, '| cpaModeConfig:', cpaModeConfig.style.display);
    
    if (savedConfig) {
      console.log('[Restore] User config restored successfully');
    }
    
    // 尝试从 IndexedDB 恢复文件夹句柄
    console.log('[Restore] Attempting to load folder handle from IndexedDB...');
    const savedHandleResult = await loadFolderHandle();
    console.log('[Restore] Load result:', savedHandleResult);
    
    if (savedHandleResult) {
      // 检查是否需要用户交互来恢复权限
      if (savedHandleResult.needsPermission) {
        const handle = savedHandleResult.handle;
        const folderName = handle.name;
        console.log('[Restore] Folder handle found but needs permission:', folderName);
        
        // 显示"需要恢复权限"的提示
        const pathText = `${folderName} (点击恢复)`;
        const pathColor = '#f59e0b'; // 橙色提示
        
        selectedFolderPath.textContent = pathText;
        selectedFolderPath.classList.add('selected');
        selectedFolderPath.style.color = pathColor;
        selectedFolderPath.style.cursor = 'pointer';
        selectedFolderPath.title = '点击恢复文件夹访问权限';
        
        selectedFolderPathCpa.textContent = pathText;
        selectedFolderPathCpa.classList.add('selected');
        selectedFolderPathCpa.style.color = pathColor;
        selectedFolderPathCpa.style.cursor = 'pointer';
        selectedFolderPathCpa.title = '点击恢复文件夹访问权限';
        
        // 添加点击事件来恢复权限
        const restorePermission = async () => {
          try {
            const granted = await requestFolderPermission(handle);
            if (granted) {
              selectedFolderHandle = handle;
              
              selectedFolderPath.textContent = `${folderName} (已恢复)`;
              selectedFolderPath.style.color = '#10b981';
              selectedFolderPath.style.cursor = '';
              selectedFolderPath.title = '';
              
              selectedFolderPathCpa.textContent = `${folderName} (已恢复)`;
              selectedFolderPathCpa.style.color = '#10b981';
              selectedFolderPathCpa.style.cursor = '';
              selectedFolderPathCpa.title = '';
              
              // 移除点击事件
              selectedFolderPath.removeEventListener('click', restorePermission);
              selectedFolderPathCpa.removeEventListener('click', restorePermission);
              
              // 更新保存的路径名称
              await chrome.runtime.sendMessage({
                type: 'SAVE_SETTING',
                source: 'sidepanel',
                payload: { localSavePath: folderName }
              });
              
              showToast(`文件夹权限已恢复: ${folderName}`, 'success', 3000);
            } else {
              showToast('权限恢复失败，请重新选择文件夹', 'error');
            }
          } catch (err) {
            console.error('[Restore] Failed to restore permission:', err);
            showToast('权限恢复失败，请重新选择文件夹', 'error');
          }
        };
        
        selectedFolderPath.addEventListener('click', restorePermission);
        selectedFolderPathCpa.addEventListener('click', restorePermission);
        
        showToast(`文件夹 ${folderName} 需要恢复权限，请点击路径`, 'info', 4000);
      } else {
        // 权限已授予，直接使用
        selectedFolderHandle = savedHandleResult;
        const folderName = savedHandleResult.name;
        console.log('[Restore] Folder handle restored successfully:', folderName);
        
        selectedFolderPath.textContent = `${folderName} (已恢复)`;
        selectedFolderPath.classList.add('selected');
        selectedFolderPath.style.color = '#10b981'; // 绿色表示成功恢复
        
        selectedFolderPathCpa.textContent = `${folderName} (已恢复)`;
        selectedFolderPathCpa.classList.add('selected');
        selectedFolderPathCpa.style.color = '#10b981';
        
        // 更新保存的路径名称
        await chrome.runtime.sendMessage({
          type: 'SAVE_SETTING',
          source: 'sidepanel',
          payload: { localSavePath: folderName }
        });
        
        showToast(`文件夹已自动恢复: ${folderName}`, 'success', 3000);
      }
    } else {
      console.log('[Restore] No folder handle restored');
      if (state.localSavePath) {
        // 如果无法恢复句柄，但有保存的路径，显示提示
        const pathText = `${state.localSavePath} (需重新选择)`;
        const pathColor = '#f59e0b'; // 橙色提示
        
        selectedFolderPath.textContent = pathText;
        selectedFolderPath.classList.add('selected');
        selectedFolderPath.style.color = pathColor;
        
        selectedFolderPathCpa.textContent = pathText;
        selectedFolderPathCpa.classList.add('selected');
        selectedFolderPathCpa.style.color = pathColor;
        
        console.log('[Restore] Showing "need reselect" message for:', state.localSavePath);
      }
    }
    
    // 注意：saveToLocal、localMode、incognitoMode 等设置会在后面从 IndexedDB 恢复
    // 这里只恢复 background state 中的值到变量，不设置 UI
    // UI 会在 IndexedDB 恢复时统一设置

    if (state.stepStatuses) {
      for (const [step, status] of Object.entries(state.stepStatuses)) {
        updateStepUI(Number(step), status);
      }
    }

    if (state.logs) {
      for (const entry of state.logs) {
        appendLog(entry);
      }
    }

    if (state.manualIntervention) {
      const { step, message } = state.manualIntervention;
      manualInterventionText.textContent = `步骤 ${step} 需要人工介入：${message}`;
      manualInterventionBar.style.display = 'flex';
    }

    updateStatusDisplay(state);
    updateProgressCounter();
  } catch (err) {
    console.error('Failed to restore state:', err);
  }
}

// ============================================================
// UI Updates
// ============================================================

function updateStepUI(step, status) {
  const statusEl = document.querySelector(`.step-status[data-step="${step}"]`);
  const row = document.querySelector(`.step-row[data-step="${step}"]`);
  const retryBtn = document.querySelector(`.step-retry-btn[data-step="${step}"]`);

  if (statusEl) statusEl.textContent = STATUS_ICONS[status] || '';
  if (row) {
    row.className = `step-row ${status}`;
  }
  if (retryBtn) {
    retryBtn.style.display = status === 'failed' ? 'inline-flex' : 'none';
  }

  updateButtonStates();
  updateProgressCounter();
}

function updateProgressCounter() {
  let completed = 0;
  document.querySelectorAll('.step-row').forEach(row => {
    if (row.classList.contains('completed')) completed++;
  });
  stepsProgress.textContent = `${completed} / 9`;
}

function updateButtonStates() {
  const statuses = {};
  document.querySelectorAll('.step-row').forEach(row => {
    const step = Number(row.dataset.step);
    if (row.classList.contains('completed')) statuses[step] = 'completed';
    else if (row.classList.contains('running')) statuses[step] = 'running';
    else if (row.classList.contains('failed')) statuses[step] = 'failed';
    else statuses[step] = 'pending';
  });

  const anyRunning = Object.values(statuses).some(s => s === 'running');

  for (let step = 1; step <= 9; step++) {
    const btn = document.querySelector(`.step-btn[data-step="${step}"]`);
    if (!btn) continue;

    if (anyRunning) {
      btn.disabled = true;
    } else if (step === 1) {
      btn.disabled = false;
    } else {
      const prevStatus = statuses[step - 1];
      const currentStatus = statuses[step];
      btn.disabled = !(prevStatus === 'completed' || currentStatus === 'failed' || currentStatus === 'completed');
    }
  }
}

function updateStatusDisplay(state) {
  if (!state || !state.stepStatuses) return;

  statusBar.className = 'status-bar';

  const running = Object.entries(state.stepStatuses).find(([, s]) => s === 'running');
  if (running) {
    displayStatus.textContent = `步骤 ${running[0]} 执行中...`;
    statusBar.classList.add('running');
    return;
  }

  const failed = Object.entries(state.stepStatuses).find(([, s]) => s === 'failed');
  if (failed) {
    displayStatus.textContent = `步骤 ${failed[0]} 失败`;
    statusBar.classList.add('failed');
    return;
  }

  const lastCompleted = Object.entries(state.stepStatuses)
    .filter(([, s]) => s === 'completed')
    .map(([k]) => Number(k))
    .sort((a, b) => b - a)[0];

  if (lastCompleted === 9) {
    displayStatus.textContent = '全部步骤已完成';
    statusBar.classList.add('completed');
  } else if (lastCompleted) {
    displayStatus.textContent = `步骤 ${lastCompleted} 已完成`;
  } else {
    displayStatus.textContent = '就绪';
  }
}

function appendLog(entry) {
  const time = new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
  const levelLabel = entry.level.toUpperCase();
  const line = document.createElement('div');
  line.className = `log-line log-${entry.level}`;

  const stepMatch = entry.message.match(/(?:Step|步骤)\s*(\d)/);
  const stepNum = stepMatch ? stepMatch[1] : null;

  let html = `<span class="log-time">${time}</span> `;
  html += `<span class="log-level log-level-${entry.level}">${levelLabel}</span> `;
  if (stepNum) {
    html += `<span class="log-step-tag step-${stepNum}">S${stepNum}</span>`;
  }
  html += `<span class="log-msg">${escapeHtml(entry.message)}</span>`;

  line.innerHTML = html;
  logArea.appendChild(line);
  logArea.scrollTop = logArea.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================
// Button Handlers
// ============================================================

document.querySelectorAll('.step-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const step = Number(btn.dataset.step);
    
    // Step 1 需要检查配置
    if (step === 1) {
      const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' });
      const localMode = state.localMode || false;
      const vpsUrl = inputVpsUrl.value.trim();
      
      if (!localMode && !vpsUrl) {
        showToast('请勾选"本地模式"或填写 CPA 接口地址', 'warn');
        return;
      }
      
      // 本地模式下检查是否选择了文件夹
      if (localMode) {
        if (!state.saveToLocal) {
          showToast('本地模式需要保存账号信息，请勾选"保存账号信息到本地"', 'warn');
          return;
        }
        if (!state.localSavePath || !selectedFolderHandle) {
          showToast('本地模式需要选择保存文件夹，请点击"选择文件夹"按钮', 'warn');
          return;
        }
      }
    }
    
    if (step === 3) {
      // 获取邮箱类型
      const { emailType } = await chrome.storage.local.get('emailType');
      
      // 只有 2925 模式才需要检查邮箱前缀
      if (emailType !== 'hotmail') {
        const emailPrefix = inputEmailPrefix.value.trim();
        if (!emailPrefix) {
          showToast('请先填写 2925 邮箱前缀', 'warn');
          return;
        }
        const response = await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step, emailPrefix } });
        if (response && response.error) {
          const errorMsg = response.error === 'Auto run in progress' ? '自动流程运行中，无法手动执行步骤' :
                           response.error === 'Another step is executing' ? '另一个步骤正在执行中，请稍候' :
                           response.error;
          showToast(errorMsg, 'warn');
        }
      } else {
        // Hotmail 模式不需要邮箱前缀
        const response = await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step } });
        if (response && response.error) {
          const errorMsg = response.error === 'Auto run in progress' ? '自动流程运行中，无法手动执行步骤' :
                           response.error === 'Another step is executing' ? '另一个步骤正在执行中，请稍候' :
                           response.error;
          showToast(errorMsg, 'warn');
        }
      }
    } else {
      const response = await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step } });
      if (response && response.error) {
        const errorMsg = response.error === 'Auto run in progress' ? '自动流程运行中，无法手动执行步骤' :
                         response.error === 'Another step is executing' ? '另一个步骤正在执行中，请稍候' :
                         response.error;
        showToast(errorMsg, 'warn');
      }
    }
  });
});

document.querySelectorAll('.step-retry-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const step = Number(btn.dataset.step);
    
    // Step 1 需要检查配置
    if (step === 1) {
      const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' });
      const localMode = state.localMode || false;
      const vpsUrl = inputVpsUrl.value.trim();
      
      if (!localMode && !vpsUrl) {
        showToast('请勾选"本地模式"或填写 CPA 接口地址', 'warn');
        return;
      }
      
      // 本地模式下检查是否选择了文件夹
      if (localMode) {
        if (!state.saveToLocal) {
          showToast('本地模式需要保存账号信息，请勾选"保存账号信息到本地"', 'warn');
          return;
        }
        if (!state.localSavePath || !selectedFolderHandle) {
          showToast('本地模式需要选择保存文件夹，请点击"选择文件夹"按钮', 'warn');
          return;
        }
      }
    }
    
    if (step === 3) {
      // 获取邮箱类型
      const { emailType } = await chrome.storage.local.get('emailType');
      
      // 只有 2925 模式才需要检查邮箱前缀
      if (emailType !== 'hotmail') {
        const emailPrefix = inputEmailPrefix.value.trim();
        if (!emailPrefix) {
          showToast('请先填写 2925 邮箱前缀', 'warn');
          return;
        }
        const response = await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step, emailPrefix } });
        if (response && response.error) {
          const errorMsg = response.error === 'Auto run in progress' ? '自动流程运行中，无法手动重试步骤' :
                           response.error === 'Another step is executing' ? '另一个步骤正在执行中，请稍候' :
                           response.error;
          showToast(errorMsg, 'warn');
        }
      } else {
        // Hotmail 模式不需要邮箱前缀
        const response = await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step } });
        if (response && response.error) {
          const errorMsg = response.error === 'Auto run in progress' ? '自动流程运行中，无法手动重试步骤' :
                           response.error === 'Another step is executing' ? '另一个步骤正在执行中，请稍候' :
                           response.error;
          showToast(errorMsg, 'warn');
        }
      }
    } else {
      const response = await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step } });
      if (response && response.error) {
        const errorMsg = response.error === 'Auto run in progress' ? '自动流程运行中，无法手动重试步骤' :
                         response.error === 'Another step is executing' ? '另一个步骤正在执行中，请稍候' :
                         response.error;
        showToast(errorMsg, 'warn');
      }
    }
  });
});

// Auto Run
btnAutoRun.addEventListener('click', async () => {
  console.log('[btnAutoRun] 按钮被点击');
  
  // 获取邮箱类型
  const { emailType } = await chrome.storage.local.get('emailType');
  
  const vpsUrl = inputVpsUrl.value.trim();
  const emailPrefix = inputEmailPrefix.value.trim();
  
  console.log('[btnAutoRun] emailType:', emailType);
  console.log('[btnAutoRun] vpsUrl:', vpsUrl);
  console.log('[btnAutoRun] emailPrefix:', emailPrefix);

  // 只有 2925 模式才需要检查邮箱前缀
  if (emailType !== 'hotmail' && !emailPrefix) {
    showToast('请先填写 2925 邮箱前缀', 'warn');
    return;
  }
  
  // Hotmail 模式检查是否有可用邮箱
  if (emailType === 'hotmail') {
    try {
      const stats = await hotmailManager.getStats();
      if (stats.available === 0) {
        showToast('没有可用的 Hotmail 邮箱，请先导入邮箱', 'warn');
        return;
      }
    } catch (error) {
      showToast('检查邮箱状态失败，请重试', 'error');
      return;
    }
  }
  
  // 检查运行模式配置
  console.log('[btnAutoRun] 正在获取状态...');
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' });
  console.log('[btnAutoRun] 状态:', state);
  
  const runMode = selectRunMode.value;
  const isLocalMode = runMode === 'local';
  
  console.log('[btnAutoRun] runMode:', runMode);
  console.log('[btnAutoRun] isLocalMode:', isLocalMode);
  
  if (!isLocalMode && !vpsUrl) {
    showToast('CPA 模式需要填写 CPA 接口地址，或切换到本地模式', 'warn');
    return;
  }
  
  // 本地模式下检查是否选择了文件夹
  if (isLocalMode) {
    console.log('[btnAutoRun] 本地模式检查 - saveToLocal:', state.saveToLocal);
    console.log('[btnAutoRun] 本地模式检查 - localSavePath:', state.localSavePath);
    console.log('[btnAutoRun] 本地模式检查 - selectedFolderHandle:', selectedFolderHandle);
    
    if (!state.saveToLocal) {
      showToast('本地模式需要保存账号信息，请勾选"保存账号信息到本地"', 'warn');
      return;
    }
    if (!state.localSavePath || !selectedFolderHandle) {
      showToast('本地模式需要选择保存文件夹，请点击"选择文件夹"按钮', 'warn');
      return;
    }
  }
  
  // CPA 模式下，如果勾选了保存到本地，检查是否输入了 CPA 管理密钥和文件夹
  if (!isLocalMode && state.saveToLocal) {
    console.log('[btnAutoRun] CPA 模式检查 - localSavePath:', state.localSavePath);
    console.log('[btnAutoRun] CPA 模式检查 - selectedFolderHandle:', selectedFolderHandle);
    
    // 检查是否选择了文件夹
    if (!state.localSavePath || !selectedFolderHandle) {
      showToast('保存账号信息需要选择保存文件夹，请点击"选择文件夹"按钮', 'warn');
      return;
    }
    
    const cpaKey = inputCpaKey.value.trim();
    console.log('[btnAutoRun] CPA 模式检查 - cpaKey:', cpaKey ? cpaKey.slice(0, 10) + '...' : '(空)');
    
    if (!cpaKey) {
      showToast('CPA 模式下保存账号信息需要输入 CPA 管理密钥', 'warn');
      return;
    }
    // 不检查密钥格式，由服务器验证
  }
  
  console.log('[btnAutoRun] 所有检查通过，准备启动...');

  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { vpsUrl, emailPrefix },
  });

  const totalRuns = parseInt(inputRunCount.value) || 1;
  btnAutoRun.disabled = true;
  inputRunCount.disabled = true;
  btnStopFlow.style.display = 'inline-flex';
  btnStopFlow.disabled = false;  // 确保停止按钮可用
  btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> 运行中...';
  
  console.log('[btnAutoRun] UI 已更新 - 停止按钮显示:', btnStopFlow.style.display);
  console.log('[btnAutoRun] 发送 AUTO_RUN 消息, totalRuns:', totalRuns);
  await chrome.runtime.sendMessage({ type: 'AUTO_RUN', source: 'sidepanel', payload: { totalRuns } });
  console.log('[btnAutoRun] AUTO_RUN 消息已发送');
});

// Stop Flow
btnStopFlow.addEventListener('click', async () => {
  if (confirm('确定要停止当前流程吗？')) {
    btnStopFlow.disabled = true;
    
    try {
      await chrome.runtime.sendMessage({ type: 'STOP_AUTO_RUN', source: 'sidepanel' });
      // 等待 background 发送 AUTO_RUN_STATUS (phase: 'paused') 来更新 UI
    } catch (err) {
      showToast('停止流程失败', 'error');
      btnStopFlow.disabled = false;
    }
  }
});

// Resume Flow
btnResumeFlow.addEventListener('click', async () => {
  btnResumeFlow.disabled = true;
  
  try {
    const response = await chrome.runtime.sendMessage({ type: 'RESUME_AUTO_RUN', source: 'sidepanel' });
    
    if (response && response.ok === false) {
      // 如果失败，显示提示并恢复按钮
      showToast('无法继续：没有暂停的流程', 'warn');
      btnResumeFlow.disabled = false;
    }
    // 如果成功，等待 background 发送 AUTO_RUN_STATUS 消息来更新 UI
  } catch (err) {
    showToast('恢复流程失败', 'error');
    btnResumeFlow.disabled = false;
  }
});

// Toggle VPS URL visibility
btnToggleVpsUrl.addEventListener('click', () => {
  const isPassword = inputVpsUrl.type === 'password';
  inputVpsUrl.type = isPassword ? 'text' : 'password';
  const iconEye = btnToggleVpsUrl.querySelector('.icon-eye');
  const iconEyeOff = btnToggleVpsUrl.querySelector('.icon-eye-off');
  if (isPassword) {
    iconEye.style.display = 'none';
    iconEyeOff.style.display = 'block';
  } else {
    iconEye.style.display = 'block';
    iconEyeOff.style.display = 'none';
  }
});

// Toggle Default Password visibility
btnToggleDefaultPassword.addEventListener('click', () => {
  const isPassword = inputDefaultPassword.type === 'password';
  inputDefaultPassword.type = isPassword ? 'text' : 'password';
  const iconEye = btnToggleDefaultPassword.querySelector('.icon-eye');
  const iconEyeOff = btnToggleDefaultPassword.querySelector('.icon-eye-off');
  if (isPassword) {
    iconEye.style.display = 'none';
    iconEyeOff.style.display = 'block';
  } else {
    iconEye.style.display = 'block';
    iconEyeOff.style.display = 'none';
  }
});

// Save Config Button
btnSaveConfig.addEventListener('click', async () => {
  try {
    // 获取邮箱类型
    const { emailType } = await chrome.storage.local.get('emailType');
    
    const config = {
      vpsUrl: inputVpsUrl.value.trim(),
      emailPrefix: inputEmailPrefix.value.trim(),
      defaultPassword: inputDefaultPassword.value.trim(),
      cpaManagementKey: inputCpaKey.value.trim(),
      signupEntry: selectSignupEntry.value,
      emailType: emailType || '2925',
      runMode: selectRunMode.value,
      saveToLocal: checkboxSaveLocal.checked,
      incognitoMode: checkboxIncognitoMode.checked,
      savedAt: new Date().toISOString()
    };
    
    // 保存到 IndexedDB
    await saveConfig(config);
    
    // 同时保存到 background state
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTING',
      source: 'sidepanel',
      payload: {
        vpsUrl: config.vpsUrl,
        emailPrefix: config.emailPrefix,
        defaultPassword: config.defaultPassword,
        cpaManagementKey: config.cpaManagementKey,
        signupEntry: config.signupEntry,
        localMode: config.runMode === 'local',
        saveToLocal: config.saveToLocal,
        incognitoMode: config.incognitoMode
      }
    });
    
    // 保存邮箱类型到 chrome.storage.local
    await chrome.storage.local.set({ emailType: config.emailType });
    
    showToast('配置已保存', 'success', 2000);
    console.log('[Config] Configuration saved:', {
      vpsUrl: config.vpsUrl ? '***' : '(empty)',
      emailPrefix: config.emailPrefix || '(empty)',
      defaultPassword: config.defaultPassword ? '***' : '(empty)',
      cpaManagementKey: config.cpaManagementKey ? '***' : '(empty)',
      signupEntry: config.signupEntry,
      emailType: config.emailType,
      runMode: config.runMode,
      saveToLocal: config.saveToLocal,
      incognitoMode: config.incognitoMode
    });
  } catch (err) {
    showToast('保存配置失败: ' + err.message, 'error');
    console.error('[Config] Failed to save configuration:', err);
  }
});

// Copy buttons
btnCopyEmail.addEventListener('click', async () => {
  const email = displayGeneratedEmail.textContent;
  if (email && email !== '等待生成...') {
    await copyToClipboard(email, '邮箱已复制');
  }
});

btnCopyPassword.addEventListener('click', async () => {
  const password = displayGeneratedPassword.textContent;
  if (password && password !== '等待生成...') {
    await copyToClipboard(password, '密码已复制');
  }
});

btnCopyOauth.addEventListener('click', async () => {
  const oauth = displayOauthUrl.textContent;
  if (oauth && oauth !== '等待中...') {
    await copyToClipboard(oauth, 'OAuth URL 已复制');
  }
});

btnCopyCallback.addEventListener('click', async () => {
  const callback = displayLocalhostUrl.textContent;
  if (callback && callback !== '等待中...') {
    await copyToClipboard(callback, '回调 URL 已复制');
  }
});

async function copyToClipboard(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage, 'success', 2000);
  } catch (err) {
    showToast('复制失败', 'error');
  }
}

// ============================================================
// Local Save Functionality
// ============================================================

checkboxSaveLocal.addEventListener('change', async () => {
  const isChecked = checkboxSaveLocal.checked;
  const runMode = selectRunMode.value;
  
  // 根据运行模式显示不同的配置区域
  if (isChecked) {
    if (runMode === 'local') {
      localModeConfig.style.display = 'block';
      cpaModeConfig.style.display = 'none';
    } else {
      localModeConfig.style.display = 'none';
      cpaModeConfig.style.display = 'block';
    }
  } else {
    localModeConfig.style.display = 'none';
    cpaModeConfig.style.display = 'none';
  }
  
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { saveToLocal: isChecked }
  });
});

checkboxIncognitoMode.addEventListener('change', async () => {
  const isChecked = checkboxIncognitoMode.checked;
  
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { incognitoMode: isChecked }
  });
  
  if (isChecked) {
    showToast('无痕模式已启用，OpenAI 相关操作将在无痕窗口中进行', 'info', 3000);
  }
});

selectRunMode.addEventListener('change', async () => {
  const runMode = selectRunMode.value;
  const isLocalMode = runMode === 'local';
  
  // 隐藏/显示 CPA 接口输入框
  cpaInterfaceRow.style.display = isLocalMode ? 'none' : 'flex';
  
  // 禁用/启用 CPA 接口输入框
  inputVpsUrl.disabled = isLocalMode;
  
  // 本地模式自动启用"保存到本地"
  if (isLocalMode) {
    checkboxSaveLocal.checked = true;
    localModeConfig.style.display = 'block';
    cpaModeConfig.style.display = 'none';
    
    // 保存设置
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTING',
      source: 'sidepanel',
      payload: { 
        localMode: true,
        saveToLocal: true
      }
    });
    
    showToast('本地模式：账号信息将保存到您选择的文件夹', 'info', 3000);
  } else {
    // CPA 模式：根据"保存到本地"复选框状态显示配置
    const saveToLocal = checkboxSaveLocal.checked;
    localModeConfig.style.display = 'none';
    cpaModeConfig.style.display = saveToLocal ? 'block' : 'none';
    
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTING',
      source: 'sidepanel',
      payload: { localMode: false }
    });
  }
});

btnSelectFolder.addEventListener('click', async () => {
  try {
    selectedFolderHandle = await window.showDirectoryPicker({
      mode: 'readwrite',
      startIn: 'documents'
    });
    
    const folderName = selectedFolderHandle.name;
    
    // 保存到 IndexedDB
    await saveFolderHandle(selectedFolderHandle);
    
    selectedFolderPath.textContent = `${folderName} (已选择)`;
    selectedFolderPath.classList.add('selected');
    selectedFolderPath.style.color = '';
    selectedFolderPath.title = `已选择文件夹: ${folderName}\n\n文件将保存到您选择的"${folderName}"文件夹中。\n下次打开插件会自动恢复此文件夹。`;
    
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTING',
      source: 'sidepanel',
      payload: { 
        localSavePath: folderName
      }
    });
    
    showToast(`已选择文件夹: ${folderName}`, 'success', 2000);
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast('选择文件夹失败', 'error');
      console.error('Failed to select folder:', err);
    }
  }
});

// CPA 模式的文件夹选择按钮（共享同一个 selectedFolderHandle）
btnSelectFolderCpa.addEventListener('click', async () => {
  try {
    selectedFolderHandle = await window.showDirectoryPicker({
      mode: 'readwrite',
      startIn: 'documents'
    });
    
    const folderName = selectedFolderHandle.name;
    
    // 保存到 IndexedDB
    await saveFolderHandle(selectedFolderHandle);
    
    // 同时更新两个路径显示
    selectedFolderPath.textContent = `${folderName} (已选择)`;
    selectedFolderPath.classList.add('selected');
    selectedFolderPath.style.color = '';
    
    selectedFolderPathCpa.textContent = `${folderName} (已选择)`;
    selectedFolderPathCpa.classList.add('selected');
    selectedFolderPathCpa.style.color = '';
    selectedFolderPathCpa.title = `已选择文件夹: ${folderName}\n\n文件将保存到您选择的"${folderName}"文件夹中。\n下次打开插件会自动恢复此文件夹。`;
    
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTING',
      source: 'sidepanel',
      payload: { 
        localSavePath: folderName
      }
    });
    
    showToast(`已选择文件夹: ${folderName}`, 'success', 2000);
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast('选择文件夹失败', 'error');
      console.error('Failed to select folder:', err);
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SAVE_AUTH_FILE') {
    handleSaveAuthFile(message.payload).then(() => {
      sendResponse({ ok: true });
    }).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }
});

async function handleSaveAuthFile(payload) {
  const { content, filename, dateFolder, mode } = payload;
  
  if (!selectedFolderHandle) {
    throw new Error('未选择保存文件夹');
  }
  
  try {
    // 创建日期文件夹
    const dateFolderHandle = await selectedFolderHandle.getDirectoryHandle(dateFolder, { create: true });
    
    // 创建模式子文件夹 (cpa 或 local)
    const modeFolderHandle = await dateFolderHandle.getDirectoryHandle(mode, { create: true });
    
    // 在模式文件夹中保存认证文件
    const fileHandle = await modeFolderHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    
    showToast(`认证文件已保存: ${mode}/${filename}`, 'success', 3000);
    
    // CSV 汇总文件保存在日期文件夹根目录
    await saveAccountToCSV(dateFolderHandle, mode);
  } catch (err) {
    showToast(`保存文件失败: ${err.message}`, 'error');
    throw err;
  }
}

async function saveAccountToCSV(dateFolderHandle, mode) {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' });
    if (!state.email || !state.password) {
      return;
    }
    
    const csvFilename = 'accounts.csv';
    let fileHandle;
    let existingContent = '';
    
    try {
      fileHandle = await dateFolderHandle.getFileHandle(csvFilename);
      const file = await fileHandle.getFile();
      existingContent = await file.text();
    } catch {
      fileHandle = await dateFolderHandle.getFileHandle(csvFilename, { create: true });
    }
    
    const timestamp = new Date().toISOString();
    const newLine = `${state.email},${state.password},${mode},${timestamp}\n`;
    
    let content = existingContent;
    if (!existingContent) {
      content = 'Email,Password,Mode,Created At\n';
    }
    content += newLine;
    
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    
    showToast('账号信息已保存到 CSV', 'success', 2000);
  } catch (err) {
    console.error('Failed to save to CSV:', err);
    showToast(`保存 CSV 失败: ${err.message}`, 'error');
  }
}

btnAutoContinue.addEventListener('click', async () => {
  showToast('2925 邮箱模式不需要手动继续', 'info');
  autoContinueBar.style.display = 'none';
});

btnManualContinue.addEventListener('click', async () => {
  btnManualContinue.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'RESUME_MANUAL_INTERVENTION', source: 'sidepanel', payload: {} });
    manualInterventionBar.style.display = 'none';
  } finally {
    btnManualContinue.disabled = false;
  }
});

btnReset.addEventListener('click', async () => {
  if (confirm('重置全部步骤和数据？')) {
    await chrome.runtime.sendMessage({ type: 'RESET', source: 'sidepanel' });
    displayOauthUrl.textContent = '等待中...';
    displayOauthUrl.classList.remove('has-value');
    btnCopyOauth.style.display = 'none';
    displayLocalhostUrl.textContent = '等待中...';
    displayLocalhostUrl.classList.remove('has-value');
    btnCopyCallback.style.display = 'none';
    displayGeneratedEmail.textContent = '等待生成...';
    displayGeneratedEmail.classList.remove('has-value');
    btnCopyEmail.style.display = 'none';
    displayGeneratedPassword.textContent = '等待生成...';
    displayGeneratedPassword.classList.remove('has-value');
    btnCopyPassword.style.display = 'none';
    displayStatus.textContent = '就绪';
    statusBar.className = 'status-bar';
    logArea.innerHTML = '';
    document.querySelectorAll('.step-row').forEach(row => row.className = 'step-row');
    document.querySelectorAll('.step-status').forEach(el => el.textContent = '');
    btnAutoRun.disabled = false;
    inputRunCount.disabled = false;
    btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> 自动';
    btnStopFlow.style.display = 'none';
    btnResumeFlow.style.display = 'none';
    autoContinueBar.style.display = 'none';
    manualInterventionBar.style.display = 'none';
    document.querySelectorAll('.step-retry-btn').forEach(b => b.style.display = 'none');
    updateButtonStates();
    updateProgressCounter();
  }
});

btnClearLog.addEventListener('click', () => {
  logArea.innerHTML = '';
});

inputVpsUrl.addEventListener('change', async () => {
  const vpsUrl = inputVpsUrl.value.trim();
  if (vpsUrl) {
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTING', source: 'sidepanel', payload: { vpsUrl } });
  }
});

inputEmailPrefix.addEventListener('change', async () => {
  const emailPrefix = inputEmailPrefix.value.trim();
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING', source: 'sidepanel',
    payload: { emailPrefix },
  });
});

// CPA 密钥输入框变化时保存
inputCpaKey.addEventListener('change', async () => {
  const cpaKey = inputCpaKey.value.trim();
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { cpaManagementKey: cpaKey }
  });
});

// CPA 密钥显示/隐藏切换
btnToggleCpaKey.addEventListener('click', () => {
  const isPassword = inputCpaKey.type === 'password';
  inputCpaKey.type = isPassword ? 'text' : 'password';
  
  const iconEye = btnToggleCpaKey.querySelector('.icon-eye');
  const iconEyeOff = btnToggleCpaKey.querySelector('.icon-eye-off');
  
  if (isPassword) {
    iconEye.style.display = 'none';
    iconEyeOff.style.display = 'block';
  } else {
    iconEye.style.display = 'block';
    iconEyeOff.style.display = 'none';
  }
});
// ============================================================
// Listen for Background broadcasts
// ============================================================

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'LOG_ENTRY':
      appendLog(message.payload);
      if (message.payload.level === 'error') {
        showToast(message.payload.message, 'error');
      }
      break;

    case 'STEP_STATUS_CHANGED': {
      const { step, status } = message.payload;
      updateStepUI(step, status);
      chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).then(updateStatusDisplay);
      if (status === 'completed') {
        chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).then(state => {
          if (state.oauthUrl) {
            displayOauthUrl.textContent = state.oauthUrl;
            displayOauthUrl.classList.add('has-value');
          }
          if (state.localhostUrl) {
            displayLocalhostUrl.textContent = state.localhostUrl;
            displayLocalhostUrl.classList.add('has-value');
          }
        });
      }
      break;
    }

    case 'AUTO_RUN_RESET': {
      displayOauthUrl.textContent = '等待中...';
      displayOauthUrl.classList.remove('has-value');
      btnCopyOauth.style.display = 'none';
      displayLocalhostUrl.textContent = '等待中...';
      displayLocalhostUrl.classList.remove('has-value');
      btnCopyCallback.style.display = 'none';
      displayGeneratedEmail.textContent = '等待生成...';
      displayGeneratedEmail.classList.remove('has-value');
      btnCopyEmail.style.display = 'none';
      displayGeneratedPassword.textContent = '等待生成...';
      displayGeneratedPassword.classList.remove('has-value');
      btnCopyPassword.style.display = 'none';
      displayStatus.textContent = '就绪';
      statusBar.className = 'status-bar';
      logArea.innerHTML = '';
      document.querySelectorAll('.step-row').forEach(row => row.className = 'step-row');
      document.querySelectorAll('.step-status').forEach(el => el.textContent = '');
      document.querySelectorAll('.step-retry-btn').forEach(b => b.style.display = 'none');
      autoContinueBar.style.display = 'none';
      manualInterventionBar.style.display = 'none';
      
      // 重要：保持停止按钮显示状态（因为流程正在运行）
      // btnStopFlow 的显示状态由 AUTO_RUN_STATUS 控制，这里不重置
      
      updateProgressCounter();
      break;
    }

    case 'DATA_UPDATED': {
      if (message.payload.oauthUrl) {
        displayOauthUrl.textContent = message.payload.oauthUrl;
        displayOauthUrl.classList.add('has-value');
        btnCopyOauth.style.display = 'inline-flex';
      }
      if (message.payload.localhostUrl) {
        displayLocalhostUrl.textContent = message.payload.localhostUrl;
        displayLocalhostUrl.classList.add('has-value');
        btnCopyCallback.style.display = 'inline-flex';
      }
      if (message.payload.generatedEmail) {
        displayGeneratedEmail.textContent = message.payload.generatedEmail;
        displayGeneratedEmail.classList.add('has-value');
        btnCopyEmail.style.display = 'inline-flex';
      }
      if (message.payload.generatedPassword) {
        displayGeneratedPassword.textContent = message.payload.generatedPassword;
        displayGeneratedPassword.classList.add('has-value');
        btnCopyPassword.style.display = 'inline-flex';
      }
      break;
    }

    case 'AUTO_RUN_STATUS': {
      const { phase, currentRun, totalRuns } = message.payload;
      const runLabel = totalRuns > 1 ? ` (${currentRun}/${totalRuns})` : '';
      console.log('[AUTO_RUN_STATUS] phase:', phase, 'currentRun:', currentRun, 'totalRuns:', totalRuns);
      
      switch (phase) {
        case 'waiting_email':
          autoContinueBar.style.display = 'flex';
          manualInterventionBar.style.display = 'none';
          btnStopFlow.style.display = 'none';
          btnResumeFlow.style.display = 'none';
          btnAutoRun.innerHTML = `已暂停${runLabel}`;
          break;
        case 'manual_intervention':
          autoContinueBar.style.display = 'none';
          manualInterventionText.textContent = `步骤 ${message.payload.step || message.payload?.step || ''} 需要人工介入：${message.payload.message}`;
          manualInterventionBar.style.display = 'flex';
          btnStopFlow.style.display = 'inline-flex';
          btnResumeFlow.style.display = 'none';
          btnAutoRun.innerHTML = `人工介入${runLabel}`;
          break;
        case 'running':
          console.log('[AUTO_RUN_STATUS] 设置运行中状态，显示停止按钮');
          autoContinueBar.style.display = 'none';
          manualInterventionBar.style.display = 'none';
          btnStopFlow.style.display = 'inline-flex';
          btnStopFlow.disabled = false;
          btnResumeFlow.style.display = 'none';
          btnResumeFlow.disabled = false; // 重新启用继续按钮
          btnAutoRun.innerHTML = `运行中${runLabel}`;
          console.log('[AUTO_RUN_STATUS] 停止按钮显示状态:', btnStopFlow.style.display);
          break;
        case 'paused':
          autoContinueBar.style.display = 'none';
          manualInterventionBar.style.display = 'none';
          btnStopFlow.style.display = 'none';
          btnStopFlow.disabled = false; // 重新启用停止按钮
          btnResumeFlow.style.display = 'inline-flex';
          btnResumeFlow.disabled = false; // 确保继续按钮可用
          btnAutoRun.disabled = true;
          inputRunCount.disabled = true;
          btnAutoRun.innerHTML = `已暂停${runLabel}`;
          break;
        case 'complete':
          btnAutoRun.disabled = false;
          inputRunCount.disabled = false;
          btnStopFlow.style.display = 'none';
          btnResumeFlow.style.display = 'none';
          btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> 自动';
          autoContinueBar.style.display = 'none';
          manualInterventionBar.style.display = 'none';
          break;
        case 'stopped':
          btnAutoRun.disabled = false;
          inputRunCount.disabled = false;
          btnStopFlow.style.display = 'none';
          btnResumeFlow.style.display = 'none';
          btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> 自动';
          autoContinueBar.style.display = 'none';
          manualInterventionBar.style.display = 'none';
          break;
        case 'reset':
          // 重置所有 UI 状态
          displayOauthUrl.textContent = '等待中...';
          displayOauthUrl.classList.remove('has-value');
          btnCopyOauth.style.display = 'none';
          displayLocalhostUrl.textContent = '等待中...';
          displayLocalhostUrl.classList.remove('has-value');
          btnCopyCallback.style.display = 'none';
          displayGeneratedEmail.textContent = '等待生成...';
          displayGeneratedEmail.classList.remove('has-value');
          btnCopyEmail.style.display = 'none';
          displayGeneratedPassword.textContent = '等待生成...';
          displayGeneratedPassword.classList.remove('has-value');
          btnCopyPassword.style.display = 'none';
          btnAutoRun.disabled = false;
          inputRunCount.disabled = false;
          btnStopFlow.style.display = 'none';
          btnResumeFlow.style.display = 'none';
          btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> 自动';
          autoContinueBar.style.display = 'none';
          manualInterventionBar.style.display = 'none';
          break;
      }
      break;
    }
  }
});

// ============================================================
// Theme Toggle
// ============================================================

const btnTheme = document.getElementById('btn-theme');

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('multipage-theme', theme);
}

function initTheme() {
  const saved = localStorage.getItem('multipage-theme');
  if (saved) {
    setTheme(saved);
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    setTheme('dark');
  }
}

btnTheme.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
});

// ============================================================
// Init
// ============================================================

initTheme();
restoreState().then(() => {
  updateButtonStates();
});


// ============================================================
// Hotmail 邮箱管理功能
// ============================================================

// 邮箱类型选择器
const selectEmailType = document.getElementById('select-email-type');
const hotmailSection = document.getElementById('hotmail-section');
const btnImportHotmail = document.getElementById('btn-import-hotmail');
const btnViewHotmail = document.getElementById('btn-view-hotmail');
const hotmailStats = document.getElementById('hotmail-stats');

// 注册入口选择器
const selectSignupEntry = document.getElementById('select-signup-entry');

// 导入模态框
const hotmailImportModal = document.getElementById('hotmail-import-modal');
const btnCloseImportModal = document.getElementById('btn-close-import-modal');
const btnCancelImport = document.getElementById('btn-cancel-import');
const btnConfirmImport = document.getElementById('btn-confirm-import');
const hotmailImportText = document.getElementById('hotmail-import-text');
const hotmailImportFile = document.getElementById('hotmail-import-file');

// 查看模态框
const hotmailViewModal = document.getElementById('hotmail-view-modal');
const btnCloseViewModal = document.getElementById('btn-close-view-modal');
const btnCloseView = document.getElementById('btn-close-view');
const hotmailList = document.getElementById('hotmail-list');
const btnExportHotmail = document.getElementById('btn-export-hotmail');
const btnClearHotmail = document.getElementById('btn-clear-hotmail');

// 邮箱类型切换
selectEmailType.addEventListener('change', async (e) => {
  const emailType = e.target.value;
  
  if (emailType === 'hotmail') {
    hotmailSection.style.display = 'block';
    inputEmailPrefix.closest('.data-row').style.display = 'none';
  } else {
    hotmailSection.style.display = 'none';
    inputEmailPrefix.closest('.data-row').style.display = 'block';
  }
  
  await chrome.storage.local.set({ emailType });
  console.log('[Hotmail] 切换到', emailType === 'hotmail' ? 'Hotmail' : '2925', '邮箱模式');
});

// 注册入口切换
selectSignupEntry.addEventListener('change', async (e) => {
  const signupEntry = e.target.value;
  
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { signupEntry }
  });
  
  console.log('[SignupEntry] 切换到', signupEntry === 'chatgpt' ? 'ChatGPT 注册' : 'OAuth 授权', '入口');
  
  if (signupEntry === 'chatgpt') {
    showToast('已切换到 ChatGPT 注册入口', 'info', 2000);
  } else {
    showToast('已切换到 OAuth 授权入口（默认）', 'info', 2000);
  }
});

// 导入标签页切换
document.querySelectorAll('.import-tab').forEach(tab => {
  tab.addEventListener('click', (e) => {
    const tabName = e.target.dataset.tab;
    
    document.querySelectorAll('.import-tab').forEach(t => t.classList.remove('active'));
    e.target.classList.add('active');
    
    document.getElementById('import-tab-text').style.display = tabName === 'text' ? 'block' : 'none';
    document.getElementById('import-tab-file').style.display = tabName === 'file' ? 'block' : 'none';
  });
});

// 打开导入模态框
btnImportHotmail.addEventListener('click', () => {
  hotmailImportModal.style.display = 'flex';
});

// 关闭导入模态框
btnCloseImportModal.addEventListener('click', () => {
  hotmailImportModal.style.display = 'none';
});

btnCancelImport.addEventListener('click', () => {
  hotmailImportModal.style.display = 'none';
});

// 确认导入
btnConfirmImport.addEventListener('click', async () => {
  const activeTab = document.querySelector('.import-tab.active').dataset.tab;
  
  try {
    let results;
    
    if (activeTab === 'text') {
      const text = hotmailImportText.value;
      if (!text.trim()) {
        showToast('请输入邮箱信息', 'error');
        return;
      }
      
      const lines = text.split('\n').filter(line => line.trim() && !line.startsWith('#'));
      results = await hotmailManager.importEmails(lines);
    } else {
      const file = hotmailImportFile.files[0];
      
      if (!file) {
        showToast('请选择文件', 'error');
        return;
      }
      
      const text = await file.text();
      
      if (file.name.endsWith('.json')) {
        const jsonData = JSON.parse(text);
        results = await hotmailManager.importFromJSON(jsonData);
      } else {
        const lines = text.split('\n').filter(line => line.trim() && !line.startsWith('#'));
        results = await hotmailManager.importEmails(lines);
      }
    }
    
    const message = `导入完成！\n✅ 成功: ${results.success.length}\n❌ 失败: ${results.failed.length}\n⏭️ 跳过: ${results.skipped.length}`;
    
    // 显示详细信息
    if (results.skipped.length > 0) {
      console.log('[Hotmail] 跳过的邮箱:', results.skipped);
    }
    if (results.failed.length > 0) {
      console.log('[Hotmail] 失败的邮箱:', results.failed);
    }
    
    showToast(message, results.success.length > 0 ? 'success' : 'info');
    console.log('[Hotmail]', message.replace(/\n/g, ' | '));
    
    await updateHotmailStats();
    
    hotmailImportModal.style.display = 'none';
    hotmailImportText.value = '';
    hotmailImportFile.value = '';
    
  } catch (error) {
    showToast(`导入失败: ${error.message}`, 'error');
    console.error('[Hotmail] 导入失败:', error);
  }
});

// 打开查看模态框
btnViewHotmail.addEventListener('click', async () => {
  await loadHotmailList();
  hotmailViewModal.style.display = 'flex';
});

// 关闭查看模态框
btnCloseViewModal.addEventListener('click', () => {
  hotmailViewModal.style.display = 'none';
});

btnCloseView.addEventListener('click', () => {
  hotmailViewModal.style.display = 'none';
});

// 加载邮箱列表
async function loadHotmailList() {
  try {
    const emails = await hotmailManager.getAllEmails();
    
    if (emails.length === 0) {
      hotmailList.innerHTML = '<p style="text-align:center;color:#999;padding:40px;">暂无邮箱数据</p>';
      return;
    }
    
    hotmailList.innerHTML = emails.map(email => `
      <div class="hotmail-item">
        <div class="hotmail-item-header">
          <span class="hotmail-email">${escapeHtml(email.email)}</span>
          <div class="hotmail-usage">
            <span>${email.usageCount} / 6</span>
            <span class="usage-badge ${email.usageCount >= 6 ? 'full' : 'available'}">
              ${email.usageCount >= 6 ? '已满' : '可用'}
            </span>
          </div>
        </div>
        <div class="hotmail-item-details">
          <span>最后使用:</span>
          <span>${email.lastUsed ? new Date(email.lastUsed).toLocaleString('zh-CN') : '未使用'}</span>
          <span>创建时间:</span>
          <span>${new Date(email.createdAt).toLocaleString('zh-CN')}</span>
        </div>
        <div class="hotmail-item-actions">
          <button class="btn btn-ghost btn-sm btn-delete-hotmail" data-email="${escapeHtml(email.email)}">删除</button>
        </div>
      </div>
    `).join('');
    
    // 使用事件委托绑定删除按钮
    hotmailList.querySelectorAll('.btn-delete-hotmail').forEach(btn => {
      btn.addEventListener('click', async () => {
        const email = btn.getAttribute('data-email');
        if (!confirm(`确定要删除邮箱 ${email} 吗？`)) return;
        
        try {
          await hotmailManager.deleteEmail(email);
          await loadHotmailList();
          await updateHotmailStats();
          showToast('删除成功', 'success');
          console.log('[Hotmail] 已删除邮箱:', email);
        } catch (error) {
          showToast(`删除失败: ${error.message}`, 'error');
          console.error('[Hotmail] 删除失败:', error);
        }
      });
    });
  } catch (error) {
    hotmailList.innerHTML = `<p style="text-align:center;color:#ef4444;padding:40px;">加载失败: ${error.message}</p>`;
  }
}

// 删除邮箱函数（保留用于兼容性，但不再使用）
window.deleteHotmailEmail = async function(email) {
  if (!confirm(`确定要删除邮箱 ${email} 吗？`)) return;
  
  try {
    await hotmailManager.deleteEmail(email);
    await loadHotmailList();
    await updateHotmailStats();
    showToast('删除成功', 'success');
    console.log('[Hotmail] 已删除邮箱:', email);
  } catch (error) {
    showToast(`删除失败: ${error.message}`, 'error');
    console.error('[Hotmail] 删除失败:', error);
  }
};

// 导出邮箱
btnExportHotmail.addEventListener('click', async () => {
  try {
    const emails = await hotmailManager.exportEmails();
    const json = JSON.stringify(emails, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hotmail-emails-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    showToast('导出成功', 'success');
    console.log('[Hotmail] 已导出', emails.length, '个邮箱');
  } catch (error) {
    showToast(`导出失败: ${error.message}`, 'error');
    console.error('[Hotmail] 导出失败:', error);
  }
});

// 清空全部
btnClearHotmail.addEventListener('click', async () => {
  if (!confirm('确定要清空所有 Hotmail 邮箱数据吗？此操作不可恢复！')) return;
  
  try {
    await hotmailManager.clearAll();
    await loadHotmailList();
    await updateHotmailStats();
    showToast('已清空所有邮箱数据', 'success');
    console.log('[Hotmail] 已清空所有邮箱数据');
  } catch (error) {
    showToast(`清空失败: ${error.message}`, 'error');
    console.error('[Hotmail] 清空失败:', error);
  }
});

// 更新统计信息
async function updateHotmailStats() {
  try {
    const stats = await hotmailManager.getStats();
    hotmailStats.textContent = `总计: ${stats.total} | 可用: ${stats.available} | 已满: ${stats.full}`;
  } catch (error) {
    hotmailStats.textContent = '统计信息加载失败';
    console.error('[Hotmail] Stats update failed:', error);
  }
}

// Toast 提示
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  
  const container = document.getElementById('toast-container');
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.classList.add('show');
  }, 10);
  
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      container.removeChild(toast);
    }, 300);
  }, 3000);
}

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', async () => {
  await initHotmailManager();
  
  // 注意：邮箱类型、注册入口等配置会在 restoreState() 中从 IndexedDB 恢复
  // 这里不需要重复恢复，避免冲突
});
