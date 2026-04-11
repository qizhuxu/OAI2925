// sidepanel/sidepanel.js - Side Panel logic

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
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' });

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
    
    // 恢复本地保存设置
    if (state.saveToLocal) {
      checkboxSaveLocal.checked = true;
      
      // 注意：selectedFolderHandle 无法跨会话保存，需要用户重新选择
      if (state.localSavePath) {
        const pathText = `${state.localSavePath} (需重新选择)`;
        const pathColor = '#f59e0b'; // 橙色提示
        
        selectedFolderPath.textContent = pathText;
        selectedFolderPath.classList.add('selected');
        selectedFolderPath.style.color = pathColor;
        
        selectedFolderPathCpa.textContent = pathText;
        selectedFolderPathCpa.classList.add('selected');
        selectedFolderPathCpa.style.color = pathColor;
      }
      
      // 恢复 CPA 密钥（如果是 CPA 模式）
      if (!state.localMode && state.cpaManagementKey) {
        inputCpaKey.value = state.cpaManagementKey;
      }
    }
    
    // 恢复无痕模式设置
    if (state.incognitoMode) {
      checkboxIncognitoMode.checked = true;
    }
    
    // 恢复运行模式设置
    if (state.localMode) {
      selectRunMode.value = 'local';
      inputVpsUrl.disabled = true;
      cpaInterfaceRow.style.display = 'none'; // 本地模式隐藏 CPA 接口
      // 本地模式自动启用保存到本地
      checkboxSaveLocal.checked = true;
      localModeConfig.style.display = 'block';
      cpaModeConfig.style.display = 'none';
    } else {
      // CPA 模式
      selectRunMode.value = 'cpa';
      cpaInterfaceRow.style.display = 'flex';
      
      // 根据"保存到本地"状态显示配置
      if (state.saveToLocal) {
        localModeConfig.style.display = 'none';
        cpaModeConfig.style.display = 'block';
      } else {
        localModeConfig.style.display = 'none';
        cpaModeConfig.style.display = 'none';
      }
    }

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
  
  const vpsUrl = inputVpsUrl.value.trim();
  const emailPrefix = inputEmailPrefix.value.trim();
  
  console.log('[btnAutoRun] vpsUrl:', vpsUrl);
  console.log('[btnAutoRun] emailPrefix:', emailPrefix);

  if (!emailPrefix) {
    showToast('请先填写 2925 邮箱前缀', 'warn');
    return;
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
  btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> 运行中...';
  
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
    
    selectedFolderPath.textContent = `${folderName} (已选择)`;
    selectedFolderPath.classList.add('selected');
    selectedFolderPath.style.color = '';
    selectedFolderPath.title = `已选择文件夹: ${folderName}\n\n注意：由于浏览器安全限制，无法显示完整路径。\n文件将保存到您选择的"${folderName}"文件夹中。`;
    
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
    
    // 同时更新两个路径显示
    selectedFolderPath.textContent = `${folderName} (已选择)`;
    selectedFolderPath.classList.add('selected');
    selectedFolderPath.style.color = '';
    
    selectedFolderPathCpa.textContent = `${folderName} (已选择)`;
    selectedFolderPathCpa.classList.add('selected');
    selectedFolderPathCpa.style.color = '';
    selectedFolderPathCpa.title = `已选择文件夹: ${folderName}\n\n注意：由于浏览器安全限制，无法显示完整路径。\n文件将保存到您选择的"${folderName}"文件夹中。`;
    
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
  const { content, filename, dateFolder } = payload;
  
  if (!selectedFolderHandle) {
    throw new Error('未选择保存文件夹');
  }
  
  try {
    const dateFolderHandle = await selectedFolderHandle.getDirectoryHandle(dateFolder, { create: true });
    
    const fileHandle = await dateFolderHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    
    showToast(`认证文件已保存: ${filename}`, 'success', 3000);
    
    await saveAccountToCSV(dateFolderHandle);
  } catch (err) {
    showToast(`保存文件失败: ${err.message}`, 'error');
    throw err;
  }
}

async function saveAccountToCSV(dateFolderHandle) {
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
    const newLine = `${state.email},${state.password},${timestamp}\n`;
    
    let content = existingContent;
    if (!existingContent) {
      content = 'Email,Password,Created At\n';
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
          autoContinueBar.style.display = 'none';
          manualInterventionBar.style.display = 'none';
          btnStopFlow.style.display = 'inline-flex';
          btnResumeFlow.style.display = 'none';
          btnResumeFlow.disabled = false; // 重新启用继续按钮
          btnAutoRun.innerHTML = `运行中${runLabel}`;
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
