// content/mail-2925.js — Content script for 2925 Mail (steps 4, 7)
// Injected on: 2925.com

const MAIL2925_PREFIX = '[MultiPage:mail-2925]';
const isTopFrame = window === window.top;
// 2925 list time text is often minute-level only (no seconds),
// so allow a small grace window when comparing with cycle start timestamp.
const MAIL_TIME_GRACE_MS = 65 * 1000;

console.log(MAIL2925_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

if (!isTopFrame) {
  console.log(MAIL2925_PREFIX, 'Skipping child frame');
} else {

// ============================================================
// Message Handler
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
    handlePollEmail(message.step, message.payload).then(result => {
      sendResponse(result);
    }).catch(err => {
      // POLL_EMAIL failures are handled by background retry/resend cycles.
      // Do not emit STEP_ERROR here, otherwise the step waiter is rejected too early.
      sendResponse({ error: err.message });
    });
    return true;
  }
});

// ============================================================
// 尝试多组已知 2925.com SPA 邮件列表选择器
// ============================================================

const MAIL_ITEM_SELECTORS = [
  '.mail-item',
  '.letter-item',
  '[class*="mailItem"]',
  '[class*="mail-item"]',
  '[class*="MailItem"]',
  '.el-table__row',
  'tr[class*="mail"]',
  '[class*="listItem"]',
  '[class*="list-item"]',
  'li[class*="mail"]',
];

function findMailItems() {
  for (const sel of MAIL_ITEM_SELECTORS) {
    const items = document.querySelectorAll(sel);
    if (items.length > 0) return Array.from(items);
  }
  return [];
}

function extractCodeFromLatestRow(item) {
  if (!item) return null;

  // 2925 当前列表结构：td.content -> .mail-content-title / .mail-content-text
  const contentCell = item.querySelector('td.content, .content, .mail-content');
  const titleEl = item.querySelector('.mail-content-title');
  const textEl = item.querySelector('.mail-content-text');

  const candidateText = [
    titleEl?.getAttribute('title') || '',
    titleEl?.textContent || '',
    textEl?.textContent || '',
    contentCell?.textContent || '',
  ].join(' ');

  return extractVerificationCode(candidateText);
}

function getMailItemText(item) {
  if (!item) return '';
  
  // 邮件列表项的内容
  const contentCell = item.querySelector('td.content, .content, .mail-content');
  const titleEl = item.querySelector('.mail-content-title');
  const textEl = item.querySelector('.mail-content-text');
  
  // 提取发件人信息（列表页面）
  const senderCell = item.querySelector('td.sender, .sender');
  const senderDisplayName = senderCell?.querySelector('.ivu-tooltip-rel');
  const senderFullEmail = senderCell?.querySelector('.ivu-tooltip-inner');
  
  // 提取发件人信息（详情页面）
  const senderName = item.querySelector('.user-button-name, .sender-name, [class*="sender-name"]');
  const senderAccount = item.querySelector('.user-button-account, .sender-account, [class*="sender-email"]');
  
  // 也尝试从 aria-label 或 title 属性中提取
  const ariaLabel = item.getAttribute('aria-label') || '';
  const title = item.getAttribute('title') || '';
  
  return [
    senderDisplayName?.textContent || '',
    senderFullEmail?.textContent || '',
    senderName?.textContent || '',
    senderAccount?.textContent || '',
    ariaLabel,
    title,
    titleEl?.getAttribute('title') || '',
    titleEl?.textContent || '',
    textEl?.textContent || '',
    contentCell?.textContent || '',
    item.textContent || '',
  ].join(' ');
}

function getMailItemRecipient(item) {
  if (!item) return '';
  
  // 2925 邮箱的收件人信息可能在详情页面
  // 收件人：<span class="user-button-account"><qiqi778698_7r@2925.com></span>
  const recipientButtons = item.querySelectorAll('.user-button');
  for (const btn of recipientButtons) {
    const parentText = btn.parentElement?.textContent || '';
    if (/收件人/.test(parentText)) {
      const account = btn.querySelector('.user-button-account');
      if (account) {
        return account.textContent.replace(/[<>]/g, '').toLowerCase();
      }
    }
  }
  
  // 也尝试从全文中提取
  return '';
}

function getMailItemSender(item) {
  if (!item) return '';
  
  // 2925 邮箱列表页面的发件人结构
  // td.sender -> .ivu-tooltip-rel (显示名称) 和 .ivu-tooltip-inner (完整邮箱)
  const senderCell = item.querySelector('td.sender, .sender');
  if (senderCell) {
    const displayName = senderCell.querySelector('.ivu-tooltip-rel');
    const fullEmail = senderCell.querySelector('.ivu-tooltip-inner');
    
    return [
      displayName?.textContent || '',
      fullEmail?.textContent || '',
    ].join(' ').toLowerCase();
  }
  
  // 邮件详情页面的发件人结构（打开邮件后）
  const senderName = item.querySelector('.user-button-name, .sender-name, [class*="sender-name"]');
  const senderAccount = item.querySelector('.user-button-account, .sender-account, [class*="sender-email"]');
  
  return [
    senderName?.textContent || '',
    senderAccount?.textContent || '',
  ].join(' ').toLowerCase();
}

function getMailItemSubject(item) {
  if (!item) return '';
  
  const titleEl = item.querySelector('.mail-content-title');
  return (titleEl?.getAttribute('title') || titleEl?.textContent || '').toLowerCase();
}

function getMailItemTimeText(item) {
  const timeEl = item?.querySelector('.date-time-text, [class*="date-time"], [class*="time"], td.time');
  return (timeEl?.textContent || '').replace(/\s+/g, ' ').trim();
}

function isUnreadMailItem(item) {
  if (!item) return false;
  const className = typeof item.className === 'string' ? item.className : '';
  return /unread/i.test(className)
    || item.classList.contains('unread-mail')
    || item.querySelector('.unread, [class*="unread"]') !== null;
}

function matchesRecipient(item, recipientEmail) {
  if (!recipientEmail) return true; // 如果没有指定收件人，则不过滤
  
  // 从发件人的 bounce 地址中提取收件人
  // 格式：bounce+daddf7.b462b7-qiqi778698_7r=2925.com@tm1.openai.com
  // 收件人：qiqi778698_7r@2925.com (注意 = 要替换为 @)
  const sender = getMailItemSender(item);
  
  // 将收件人邮箱中的 @ 替换为 = 来匹配 bounce 地址
  const recipientInBounce = recipientEmail.replace('@', '=');
  
  if (sender.includes(recipientInBounce.toLowerCase())) {
    return true;
  }
  
  // 也尝试直接匹配（某些情况下可能直接包含收件人邮箱）
  const fullText = getMailItemText(item).toLowerCase();
  if (fullText.includes(recipientEmail.toLowerCase())) {
    return true;
  }
  
  return false;
}

function matchesMailFilters(item, senderFilters, subjectFilters, recipientEmail) {
  // 首先检查收件人是否匹配
  if (!matchesRecipient(item, recipientEmail)) {
    return false;
  }
  
  // 分别提取发件人和主题
  const sender = getMailItemSender(item);
  const subject = getMailItemSubject(item);
  
  // 如果列表项中没有发件人信息，使用全文匹配作为兜底
  const fullText = getMailItemText(item).toLowerCase();
  
  const senderMatch = senderFilters.some(f => 
    sender.includes(f.toLowerCase()) || fullText.includes(f.toLowerCase())
  );
  const subjectMatch = subjectFilters.some(f => 
    subject.includes(f.toLowerCase()) || fullText.includes(f.toLowerCase())
  );
  
  return senderMatch || subjectMatch;
}

function parseMailItemTimestamp(item) {
  const timeText = getMailItemTimeText(item);
  if (!timeText) return null;

  const now = new Date();
  const date = new Date(now);

  if (/刚刚/.test(timeText)) {
    return now.getTime();
  }

  let m = timeText.match(/(\d+)\s*分(?:钟)?前/);
  if (m) {
    return now.getTime() - Number(m[1]) * 60 * 1000;
  }

  m = timeText.match(/(\d+)\s*秒前/);
  if (m) {
    return now.getTime() - Number(m[1]) * 1000;
  }

  m = timeText.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    date.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return date.getTime();
  }

  // 格式: 今天 14:14
  m = timeText.match(/今天\s*(\d{1,2}):(\d{2})/);
  if (m) {
    date.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return date.getTime();
  }

  // 格式: 昨天 14:14
  m = timeText.match(/昨天\s*(\d{1,2}):(\d{2})/);
  if (m) {
    date.setDate(date.getDate() - 1);
    date.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return date.getTime();
  }

  // 格式: 04-05 14:14
  m = timeText.match(/(\d{1,2})-(\d{1,2})\s*(\d{1,2}):(\d{2})/);
  if (m) {
    date.setMonth(Number(m[1]) - 1, Number(m[2]));
    date.setHours(Number(m[3]), Number(m[4]), 0, 0);
    return date.getTime();
  }

  // 格式: 2026-04-05 14:14
  m = timeText.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s*(\d{1,2}):(\d{2})/);
  if (m) {
    const d = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      0,
      0
    );
    return d.getTime();
  }

  return null;
}

function isFreshTimestamp(itemTimestamp, filterAfterTimestamp) {
  if (!filterAfterTimestamp) return true;
  if (itemTimestamp === null) return false;
  return itemTimestamp + MAIL_TIME_GRACE_MS >= filterAfterTimestamp;
}

// ============================================================
// Delete Email
// ============================================================

async function deleteEmail(item, step) {
  const MAX_DELETE_RETRIES = 3;
  
  // 保存邮件的唯一标识，用于验证删除
  const itemId = item.getAttribute('data-id') || item.id || null;
  const itemText = getMailItemText(item).slice(0, 50); // 保存部分文本用于日志
  
  for (let attempt = 1; attempt <= MAX_DELETE_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        log(`Step ${step}: Delete retry ${attempt}/${MAX_DELETE_RETRIES}...`, 'info');
        
        // 重试前先检查是否已经删除（可能上次操作延迟生效）
        if (await verifyEmailDeleted(item, itemId)) {
          log(`Step ${step}: Email already deleted (verified on retry)`, 'ok');
          return true;
        }
      } else {
        log(`Step ${step}: Deleting email: ${itemText}...`);
      }

      // Strategy 1: Click delete button/icon in the mail item
      const strategy1Success = await tryDeleteWithButton(item, step);
      if (strategy1Success) {
        if (await verifyEmailDeleted(item, itemId, 3000)) {
          log(`Step ${step}: Email deleted successfully (strategy 1)`, 'ok');
          return true;
        }
      }

      // Strategy 2: Select checkbox then click toolbar delete button
      const strategy2Success = await tryDeleteWithCheckbox(item, step);
      if (strategy2Success) {
        if (await verifyEmailDeleted(item, itemId, 3000)) {
          log(`Step ${step}: Email deleted successfully (strategy 2)`, 'ok');
          return true;
        }
      }

      // Strategy 3: Right-click context menu
      const strategy3Success = await tryDeleteWithContextMenu(item, step);
      if (strategy3Success) {
        if (await verifyEmailDeleted(item, itemId, 3000)) {
          log(`Step ${step}: Email deleted successfully (strategy 3)`, 'ok');
          return true;
        }
      }

      // Final check after all strategies
      if (await verifyEmailDeleted(item, itemId, 2000)) {
        log(`Step ${step}: Email deleted successfully (delayed verification)`, 'ok');
        return true;
      }
      
      log(`Step ${step}: Delete attempt ${attempt} failed, email still visible`, 'warn');
      
    } catch (err) {
      log(`Step ${step}: Delete attempt ${attempt} error: ${err.message}`, 'warn');
    }
    
    // Wait before retry
    if (attempt < MAX_DELETE_RETRIES) {
      await sleepRandom(1000, 1500);
    }
  }
  
  log(`Step ${step}: Failed to delete email after ${MAX_DELETE_RETRIES} attempts`, 'error');
  return false;
}

/**
 * 验证邮件是否已删除（支持等待动画完成 + 刷新确认）
 */
async function verifyEmailDeleted(item, itemId, maxWaitMs = 2000) {
  const startTime = Date.now();
  const checkInterval = 200;
  
  // 第一阶段：等待 UI 动画完成
  while (Date.now() - startTime < maxWaitMs) {
    // 检查1: 元素是否还在 DOM 中
    if (!document.contains(item)) {
      break; // UI 上已删除，继续到刷新验证
    }
    
    // 检查2: 元素是否隐藏
    if (item.style.display === 'none' || item.offsetParent === null) {
      break; // UI 上已隐藏，继续到刷新验证
    }
    
    // 检查3: 元素是否有删除相关的类名（动画中）
    if (item.classList.contains('deleting') || 
        item.classList.contains('removing') || 
        item.classList.contains('fade-out')) {
      // 继续等待动画完成
      await sleepRandom(checkInterval, checkInterval + 100);
      continue;
    }
    
    // 检查4: 透明度是否为0（淡出动画）
    const opacity = window.getComputedStyle(item).opacity;
    if (opacity === '0') {
      // 等待一下确保动画完成
      await sleepRandom(300, 500);
      continue;
    }
    
    // 等待一小段时间再检查
    await sleepRandom(checkInterval, checkInterval + 100);
  }
  
  // 第二阶段：刷新收件箱，确认服务器端真的删除了
  log('Verifying deletion by refreshing inbox...');
  await refreshInbox();
  await sleepRandom(800, 1200);
  
  // 刷新后再次检查
  // 检查1: 元素是否还在 DOM 中
  if (!document.contains(item)) {
    return true;
  }
  
  // 检查2: 元素是否隐藏
  if (item.style.display === 'none' || item.offsetParent === null) {
    return true;
  }
  
  // 检查3: 如果有 ID，检查是否还能通过 ID 找到
  if (itemId) {
    const found = document.querySelector(`[data-id="${itemId}"], #${itemId}`);
    if (!found) {
      return true;
    }
    
    // 如果找到了，检查是否是同一个元素
    if (found !== item) {
      // 可能是新邮件复用了相同的 ID，检查内容是否相同
      const originalText = getMailItemText(item);
      const foundText = getMailItemText(found);
      if (originalText !== foundText) {
        // 内容不同，说明原邮件已删除
        return true;
      }
    }
  }
  
  // 检查4: 对比邮件内容，确认是否是同一封邮件
  // 保存原始邮件的部分文本用于对比
  const originalText = getMailItemText(item).slice(0, 100);
  const currentText = getMailItemText(item).slice(0, 100);
  
  if (originalText !== currentText) {
    // 内容变了，可能是新邮件，原邮件已删除
    return true;
  }
  
  // 所有检查都失败，邮件仍然存在
  return false;
}

/**
 * 策略1: 点击邮件项中的删除按钮（列表页或详情页）
 */
async function tryDeleteWithButton(item, step) {
  try {
    // 首先检查是否在邮件详情页面（通过检查页面上是否有详情页特有的删除按钮）
    const detailDeleteBtn = document.querySelector(
      'div.delete[data-t="删除"][title="删除"].tool-common'
    );
    
    if (detailDeleteBtn && detailDeleteBtn.offsetParent !== null) {
      // 在详情页面，直接点击详情页的删除按钮
      log(`Step ${step}: Found detail page delete button, clicking...`, 'info');
      simulateClick(detailDeleteBtn);
      await sleepRandom(500, 800);
      return true;
    }
    
    // 如果不在详情页，尝试列表页的删除按钮
    // Trigger hover to show action buttons
    item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await sleepRandom(300, 500);

    // Try various delete button selectors
    const deleteBtn = item.querySelector(
      'div.delete[title="删除"], div[title="删除"].tool-common, ' +
      '[class*="delete"]:not(input):not(label), [class*="Delete"]:not(input):not(label), ' +
      '[title*="删除"], [aria-label*="删除"], ' +
      '.el-icon-delete, .icon-delete, [class*="trash"], [class*="Trash"]'
    );
    
    if (deleteBtn && deleteBtn.offsetParent !== null) {
      simulateClick(deleteBtn);
      log(`Step ${step}: Clicked delete button in list`, 'info');
      await sleepRandom(500, 800);
      return true;
    }
    
    return false;
  } catch (err) {
    log(`Step ${step}: Strategy 1 error: ${err.message}`, 'warn');
    return false;
  }
}

/**
 * 策略2: 勾选复选框 + 点击工具栏删除
 */
async function tryDeleteWithCheckbox(item, step) {
  try {
    log(`Step ${step}: Trying checkbox + toolbar delete...`, 'info');
    
    // 查找复选框
    let checkbox = item.querySelector(
      'label.ivu-checkbox-wrapper .ivu-checkbox, ' +
      'label.ivu-checkbox-wrapper input[type="checkbox"]'
    );
    
    if (!checkbox) {
      checkbox = item.querySelector(
        '.ivu-checkbox, .ivu-checkbox-inner, ' +
        'input[type="checkbox"], .el-checkbox, [class*="checkbox"], [class*="Checkbox"]'
      );
    }
    
    if (!checkbox) {
      return false;
    }
    
    let clickTarget = checkbox;
    
    if (checkbox.classList.contains('ivu-checkbox-inner')) {
      clickTarget = checkbox.closest('.ivu-checkbox') || checkbox.parentElement;
    }
    
    if (clickTarget.classList.contains('ivu-checkbox')) {
      const label = clickTarget.closest('label.ivu-checkbox-wrapper');
      if (label) {
        clickTarget = label;
      }
    }
    
    simulateClick(clickTarget);
    log(`Step ${step}: Clicked checkbox`, 'info');
    await sleepRandom(300, 500);

    // Find toolbar delete button
    const toolbarBtns = document.querySelectorAll(
      'div.delete[title="删除"], div[title="删除"].tool-common, ' +
      'button, .el-button, .ivu-btn, [class*="btn"], [class*="Btn"]'
    );
    
    for (const btn of toolbarBtns) {
      if (btn.offsetParent === null) continue; // 跳过隐藏的按钮
      
      const btnText = btn.textContent || btn.getAttribute('title') || btn.getAttribute('aria-label') || '';
      if (/删除|delete/i.test(btnText)) {
        simulateClick(btn);
        log(`Step ${step}: Clicked toolbar delete`, 'info');
        await sleepRandom(500, 800);
        return true;
      }
    }
    
    return false;
  } catch (err) {
    log(`Step ${step}: Strategy 2 error: ${err.message}`, 'warn');
    return false;
  }
}

/**
 * 策略3: 右键菜单删除
 */
async function tryDeleteWithContextMenu(item, step) {
  try {
    log(`Step ${step}: Trying right-click context menu...`, 'info');
    
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await sleepRandom(500, 800);

    const contextMenuItems = document.querySelectorAll(
      '.context-menu-item, .menu-item, .ivu-dropdown-item, [class*="menuItem"], [class*="MenuItem"]'
    );
    
    for (const menuItem of contextMenuItems) {
      if (menuItem.offsetParent === null) continue; // 跳过隐藏的菜单项
      
      const menuText = menuItem.textContent || '';
      if (/删除|delete/i.test(menuText)) {
        simulateClick(menuItem);
        log(`Step ${step}: Clicked context menu delete`, 'info');
        await sleepRandom(500, 800);
        return true;
      }
    }
    
    return false;
  } catch (err) {
    log(`Step ${step}: Strategy 3 error: ${err.message}`, 'warn');
    return false;
  }
}

// ============================================================
// 刷新收件箱 / 返回列表
// ============================================================

async function refreshInbox() {
  // 优先点刷新按钮
  const refreshBtn = document.querySelector(
    '[class*="refresh"], [title*="刷新"], [aria-label*="刷新"], [class*="Refresh"]'
  );
  if (refreshBtn) {
    simulateClick(refreshBtn);
    await sleepRandom(700, 1200);
    return;
  }
  // 点击收件箱链接
  const inboxLink = document.querySelector(
    'a[href*="mailList"], [class*="inbox"], [class*="Inbox"], [title*="收件箱"]'
  );
  if (inboxLink) {
    simulateClick(inboxLink);
    await sleepRandom(700, 1200);
  }
}

/**
 * 检查是否在邮件详情页面
 */
function isInDetailView() {
  // 检查是否有详情页特有的元素
  const detailDeleteBtn = document.querySelector('div.delete[data-t="删除"][title="删除"].tool-common');
  const backBtn = document.querySelector('[class*="back"], [title*="返回"], [aria-label*="返回"]');
  
  // 如果有详情页删除按钮或返回按钮，说明在详情页
  return !!(detailDeleteBtn || backBtn);
}

/**
 * 从详情页返回列表
 */
async function returnToList() {
  log('Attempting to return to mail list...', 'info');
  
  // 尝试1: 点击返回按钮
  const backBtn = document.querySelector(
    '[class*="back"], [title*="返回"], [aria-label*="返回"], [class*="Back"]'
  );
  if (backBtn && backBtn.offsetParent !== null) {
    simulateClick(backBtn);
    await sleepRandom(500, 800);
    log('Clicked back button to return to list', 'info');
    return true;
  }
  
  // 尝试2: 点击收件箱链接
  const inboxLink = document.querySelector(
    'a[href*="mailList"], [class*="inbox"], [class*="Inbox"], [title*="收件箱"]'
  );
  if (inboxLink) {
    simulateClick(inboxLink);
    await sleepRandom(700, 1200);
    log('Clicked inbox link to return to list', 'info');
    return true;
  }
  
  // 尝试3: 按 ESC 键
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  await sleepRandom(300, 500);
  log('Pressed ESC to return to list', 'info');
  return true;
}

// ============================================================
// 验证码提取（复用与其他邮箱相同的逻辑）
// ============================================================

function extractVerificationCode(text, strictChatGPTCodeOnly = false) {
  if (strictChatGPTCodeOnly) {
    const strictMatch = text.match(/your\s+chatgpt\s+code\s+is\s+(\d{6})/i);
    return strictMatch ? strictMatch[1] : null;
  }

  const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  const matchChatGPT = text.match(/your\s+chatgpt\s+code\s+is\s+(\d{6})/i);
  if (matchChatGPT) return matchChatGPT[1];

  const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  const match6 = text.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
}

// ============================================================
// Email Polling
// ============================================================

async function handlePollEmail(step, payload) {
  const {
    senderFilters,
    subjectFilters,
    maxAttempts,
    intervalMs,
    filterAfterTimestamp,
    excludeCodes = [],
    strictChatGPTCodeOnly = false,
    recipientEmail = null,
  } = payload;
  const latestStabilizedKeys = new Set();

  log(`Step ${step}: Starting email poll on 2925 Mail (max ${maxAttempts} attempts)`);

  // 等待页面基本加载
  await sleepRandom(1800, 3200);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Polling 2925 Mail... attempt ${attempt}/${maxAttempts}`);

    if (attempt > 1) {
      await refreshInbox();
      await sleepRandom(900, 1500);
    }

    // 策略一：通过已知选择器找邮件列表项
    const items = findMailItems();
    if (items.length > 0) {
      log(`Step ${step}: Found ${items.length} mail items via selector`);

      // 优先取第一条（最新邮件）
      const latest = items[0];
      const latestText = getMailItemText(latest);
      const latestUnread = isUnreadMailItem(latest);
      const latestTimestamp = parseMailItemTimestamp(latest);
      const latestIsFresh = isFreshTimestamp(latestTimestamp, filterAfterTimestamp);
      if (!latestIsFresh) {
        if (filterAfterTimestamp && latestTimestamp === null) {
          log(`Step ${step}: Latest row timestamp could not be parsed: ${getMailItemTimeText(latest) || 'empty'}`, 'info');

          const latestCode = extractVerificationCode(latestText, strictChatGPTCodeOnly);
          const latestMatches = matchesMailFilters(latest, senderFilters, subjectFilters, recipientEmail);

          if (latestCode && latestMatches && !excludeCodes.includes(latestCode)) {
            // Step 7: even without a parsable timestamp, if the latest mail clearly contains a code,
            // wait 60s and verify again before using it.
            if (step === 7) {
              const latestKey = `no-ts|${latestCode}`;
              if (!latestStabilizedKeys.has(latestKey)) {
                latestStabilizedKeys.add(latestKey);
                log(`Step ${step}: Latest row has code but no parsed timestamp, waiting 60s before confirming...`, 'info');
                await sleep(60000);
                await refreshInbox();
                await sleepRandom(900, 1500);

                const afterWaitItems = findMailItems();
                if (afterWaitItems.length === 0) {
                  log(`Step ${step}: Mail list empty after 60s confirmation wait, continue polling...`, 'warn');
                  continue;
                }

                const confirmedLatest = afterWaitItems[0];
                const confirmedText = getMailItemText(confirmedLatest);
                const confirmedCode = extractVerificationCode(confirmedText, strictChatGPTCodeOnly);
                const confirmedMatches = matchesMailFilters(confirmedLatest, senderFilters, subjectFilters, recipientEmail);

                if (confirmedCode === latestCode && confirmedMatches && !excludeCodes.includes(confirmedCode)) {
                  log(`Step ${step}: Confirmed latest row code after 60s without parsed timestamp: ${confirmedCode}`, 'ok');
                  return { ok: true, code: confirmedCode, emailTimestamp: Date.now() };
                }

                log(`Step ${step}: Latest row changed after 60s confirmation wait, continue polling...`, 'info');
                continue;
              }
            }

            if (latestUnread) {
              log(`Step ${step}: Using latest row without parsed timestamp, code: ${latestCode}`, 'ok');
              return { ok: true, code: latestCode, emailTimestamp: Date.now() };
            }
          }
        } else {
          log(`Step ${step}: Latest row considered older (row=${latestTimestamp}, filter=${filterAfterTimestamp}), waiting for new mail...`, 'info');
        }
      } else {
        let latestCandidate = latest;
        let latestCandidateTimestamp = latestTimestamp;

        // Step 7: 已经通过删除旧邮件和时间戳过滤来确保获取最新验证码
        // 不再需要 60 秒等待确认机制

        const latestCode = extractVerificationCode(getMailItemText(latestCandidate), strictChatGPTCodeOnly);
        if (latestCode) {
          if (excludeCodes.includes(latestCode)) {
            log(`Step ${step}: Skipping excluded code from latest row: ${latestCode}`, 'info');
          } else {
            log(`Step ${step}: Code found in latest row: ${latestCode}`, 'ok');
            
            // Delete the email after extracting code
            const deleteSuccess = await deleteEmail(latestCandidate, step);
            if (!deleteSuccess) {
              log(`Step ${step}: Failed to delete email, but continuing with code: ${latestCode}`, 'warn');
            }
            await sleepRandom(900, 1500);
            
            return { ok: true, code: latestCode, emailTimestamp: latestCandidateTimestamp || Date.now() };
          }
        }
      }

      for (const item of items) {
        const itemTimestamp = parseMailItemTimestamp(item);
        const isFresh = isFreshTimestamp(itemTimestamp, filterAfterTimestamp);
        if (!isFresh) continue;

        if (matchesMailFilters(item, senderFilters, subjectFilters, recipientEmail)) {
          // 先从列表摘要里提取
          const text = getMailItemText(item);
          const code = extractVerificationCode(text, strictChatGPTCodeOnly);
          if (code) {
            if (excludeCodes.includes(code)) {
              log(`Step ${step}: Skipping excluded code in list item: ${code}`, 'info');
              continue;
            }
            log(`Step ${step}: Code found in list item: ${code}`, 'ok');
            
            // Delete the email after extracting code
            const deleteSuccess = await deleteEmail(item, step);
            if (!deleteSuccess) {
              log(`Step ${step}: Failed to delete email, but continuing with code: ${code}`, 'warn');
            }
            await sleepRandom(900, 1500);
            
            return { ok: true, code, emailTimestamp: itemTimestamp || Date.now() };
          }
          
          // 点击打开邮件，再从正文提取
          log(`Step ${step}: Opening email to check content...`, 'info');
          simulateClick(item);
          await sleepRandom(1200, 2200);
          
          // 检查是否成功进入详情页
          if (!isInDetailView()) {
            log(`Step ${step}: Failed to open email detail, skipping...`, 'warn');
            continue;
          }
          
          const bodyCode = extractVerificationCode(document.body?.textContent || '', strictChatGPTCodeOnly);
          if (bodyCode) {
            if (excludeCodes.includes(bodyCode)) {
              log(`Step ${step}: Skipping excluded code in opened email: ${bodyCode}`, 'info');
              
              // 删除不可用的邮件（在详情页删除）
              log(`Step ${step}: Deleting excluded email in detail view...`, 'info');
              const deleteSuccess = await deleteEmail(item, step);
              if (deleteSuccess) {
                log(`Step ${step}: Excluded email deleted successfully`, 'ok');
                // 删除成功后会自动返回列表，等待页面更新
                await sleepRandom(1000, 1500);
              } else {
                log(`Step ${step}: Failed to delete excluded email, returning to list...`, 'warn');
                await returnToList();
                await sleepRandom(800, 1200);
              }
              
              continue;
            }
            
            log(`Step ${step}: Code found in opened email: ${bodyCode}`, 'ok');
            
            // 在详情页删除邮件
            const deleteSuccess = await deleteEmail(item, step);
            if (deleteSuccess) {
              log(`Step ${step}: Email deleted successfully in detail view`, 'ok');
              // 删除成功后会自动返回列表
              await sleepRandom(1000, 1500);
            } else {
              log(`Step ${step}: Failed to delete email in detail view, returning to list...`, 'warn');
              await returnToList();
              await sleepRandom(800, 1200);
            }
            
            return { ok: true, code: bodyCode, emailTimestamp: itemTimestamp || Date.now() };
          } else {
            // 没有找到验证码，删除这封无用的邮件
            log(`Step ${step}: No code found in email, deleting...`, 'info');
            const deleteSuccess = await deleteEmail(item, step);
            if (deleteSuccess) {
              log(`Step ${step}: Useless email deleted in detail view`, 'ok');
              await sleepRandom(1000, 1500);
            } else {
              log(`Step ${step}: Failed to delete useless email, returning to list...`, 'warn');
              await returnToList();
              await sleepRandom(800, 1200);
            }
          }
        }
      }
    }

    // 策略二：全页面文本扫描（SPA 页面 DOM 可能不符合预期选择器）
    // 当要求时间过滤时，避免从全页文本误提取旧验证码
    if (!filterAfterTimestamp) {
      const pageText = document.body?.textContent || '';
      const anyFilter = [...senderFilters, ...subjectFilters].some(f =>
        pageText.toLowerCase().includes(f.toLowerCase())
      );
      if (anyFilter) {
        const code = extractVerificationCode(pageText, strictChatGPTCodeOnly);
        if (code) {
          log(`Step ${step}: Code found via page text scan: ${code}`, 'ok');
          return { ok: true, code, emailTimestamp: Date.now() };
        }
      }
    }

    if (attempt < maxAttempts) {
      await sleepRandom(intervalMs, intervalMs + 1200);
    }
  }

  throw new Error(
    `No matching email found on 2925 Mail after ${(maxAttempts * intervalMs / 1000).toFixed(0)}s. ` +
    'Check inbox manually. Email may be delayed or in spam folder.'
  );
}

} // end isTopFrame block

// ============================================================
// Helper Functions
// ============================================================

function simulateClick(element) {
  if (!element) return;
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sleepRandom(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return sleep(ms);
}

// 使用 utils.js 中的 log 函数（会发送到 background）
// function log 已在 utils.js 中定义

