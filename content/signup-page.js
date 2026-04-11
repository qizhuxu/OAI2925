// content/signup-page.js — Content script for OpenAI auth pages (steps 2, 3, 4-receive, 5)
// Injected on: auth0.openai.com, auth.openai.com, accounts.openai.com

console.log('[MultiPage:signup-page] Content script loaded on', location.href);

// ========== 全局错误监测器 ==========
// 监测 OpenAI 的"糟糕，出错了"页面，自动点击"重试"按钮
let errorMonitorInterval = null;

function startErrorMonitor() {
  if (errorMonitorInterval) return; // 避免重复启动
  
  log('Global error monitor started');
  
  errorMonitorInterval = setInterval(() => {
    try {
      // 检测"糟糕，出错了"标题
      const errorHeadings = document.querySelectorAll('h1');
      let hasError = false;
      
      for (const heading of errorHeadings) {
        const text = heading.textContent?.trim() || '';
        if (text.includes('糟糕，出错了') || text.includes('出错了') || 
            text.toLowerCase().includes('something went wrong') || 
            text.toLowerCase().includes('error')) {
          hasError = true;
          break;
        }
      }
      
      if (hasError) {
        log('Detected OpenAI error page: "糟糕，出错了"', 'warn');
        
        // 查找"重试"按钮
        const retryButton = document.querySelector('button[data-dd-action-name="Try again"]') ||
                           Array.from(document.querySelectorAll('button')).find(btn => {
                             const text = btn.textContent?.trim() || '';
                             return text === '重试' || text.toLowerCase() === 'try again' || text.toLowerCase() === 'retry';
                           });
        
        if (retryButton) {
          log('Found retry button, clicking...', 'info');
          retryButton.click();
          log('Clicked retry button, page should reload', 'ok');
        } else {
          log('Retry button not found, will try again in next check', 'warn');
        }
      }
    } catch (err) {
      // 静默失败，避免干扰主流程
      console.error('[Error Monitor] Exception:', err);
    }
  }, 2000); // 每 2 秒检测一次
}

function stopErrorMonitor() {
  if (errorMonitorInterval) {
    clearInterval(errorMonitorInterval);
    errorMonitorInterval = null;
    log('Global error monitor stopped');
  }
}

// 页面加载时启动监测器
startErrorMonitor();

// 页面卸载时停止监测器
window.addEventListener('beforeunload', () => {
  stopErrorMonitor();
});
// ========== 全局错误监测器结束 ==========

// Listen for commands from Background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXECUTE_STEP' || message.type === 'FILL_CODE' || message.type === 'STEP8_FIND_AND_CLICK' || message.type === 'GET_PAGE_STATE') {
    handleCommand(message).then((result) => {
      // 对于 STEP8_FIND_AND_CLICK 和 GET_PAGE_STATE，需要返回结果对象
      if (message.type === 'STEP8_FIND_AND_CLICK' || message.type === 'GET_PAGE_STATE') {
        sendResponse(result);
      } else {
        sendResponse({ ok: true });
      }
    }).catch(err => {
      reportError(message.step, err.message);
      sendResponse({ error: err.message });
    });
    return true;
  }
});

async function handleCommand(message) {
  switch (message.type) {
    case 'EXECUTE_STEP':
      switch (message.step) {
        case 2: return await step2_clickRegister();
        case 3: return await step3_fillEmailPassword(message.payload);
        case 5: return await step5_fillNameBirthday(message.payload);
        case 6: return await step6_login(message.payload);
        case 41:
        case 71:
          return await stepResendVerificationEmail(message.step);
        default: throw new Error(`signup-page.js does not handle step ${message.step}`);
      }
    case 'FILL_CODE':
      // Step 4 = signup code, Step 7 = login code (same handler)
      return await fillVerificationCode(message.step, message.payload);
    case 'STEP8_FIND_AND_CLICK':
      // Step 8: 查找按钮位置，返回坐标给 background 用于 debugger 点击
      return await step8_findAndClick();
    case 'GET_PAGE_STATE':
      // 获取当前页面状态（用于验证点击效果）
      return getPageState();
  }
}

function getActionElementText(el) {
  return [
    el?.textContent || '',
    el?.value || '',
    el?.getAttribute?.('aria-label') || '',
    el?.getAttribute?.('data-dd-action-name') || '',
    el?.getAttribute?.('title') || '',
  ].join(' ').replace(/\s+/g, ' ').trim();
}

function findActionElement(pattern) {
  const selectors = 'button, a, [role="button"], input[type="submit"], input[type="button"]';
  const candidates = document.querySelectorAll(selectors);
  for (const el of candidates) {
    if (pattern.test(getActionElementText(el))) {
      return el;
    }
  }
  return null;
}

function waitForActionElement(pattern, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const existing = findActionElement(pattern);
    if (existing) {
      resolve(existing);
      return;
    }

    const observer = new MutationObserver(() => {
      const el = findActionElement(pattern);
      if (el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for action element ${pattern} on ${location.href}`));
    }, timeout);
  });
}

async function activateActionElement(el, label) {
  if (!el) throw new Error(`No element provided for ${label}`);

  const target = el.closest('button, a, [role="button"], input[type="submit"], input[type="button"]') || el;
  target.scrollIntoView({ block: 'center', inline: 'nearest' });
  await sleepRandom(120, 240);
  if ('focus' in target) target.focus();
  await sleepRandom(120, 240);

  if ('click' in target) {
    target.click();
    log(`${label}: Clicked via native click()`);
  }
  simulateClick(target);

  const form = target.form || target.closest('form');
  if (form) {
    try {
      form.requestSubmit(target.tagName === 'BUTTON' || target.tagName === 'INPUT' ? target : undefined);
      log(`${label}: Triggered form.requestSubmit()`);
    } catch {
      try {
        form.submit();
        log(`${label}: Triggered form.submit()`);
      } catch {}
    }
  }
}

// ============================================================
// Step 2: Click Register
// ============================================================

async function step2_clickRegister() {
  log('Step 2: Waiting for page to render...');
  await sleepRandom(1200, 2200);
  log('Step 2: Looking for Register/Sign up button...');

  let registerBtn = null;
  try {
    registerBtn = await waitForElementByText(
      'a, button, [role="button"], [role="link"]',
      /sign\s*up|register|create\s*account|注册/i,
      10000
    );
  } catch {
    // Some pages may have a direct link
    try {
      registerBtn = await waitForElement('a[href*="signup"], a[href*="register"]', 5000);
    } catch {
      throw new Error(
        'Could not find Register/Sign up button. ' +
        'Check auth page DOM in DevTools. URL: ' + location.href
      );
    }
  }

  reportComplete(2);
  simulateClick(registerBtn);
  log('Step 2: Clicked Register button');
}

// ============================================================
// Step 3: Fill Email & Password
// ============================================================

async function step3_fillEmailPassword(payload) {
  const { email } = payload;
  if (!email) throw new Error('No email provided. Paste email in Side Panel first.');

  log('Step 3: Waiting for signup form to render...');
  await sleepRandom(1200, 2200);
  log(`Step 3: Filling email: ${email}`);

  // Find email input
  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email"], input[placeholder*="Email"]',
      10000
    );
  } catch {
    throw new Error('Could not find email input field on signup page. URL: ' + location.href);
  }

  fillInput(emailInput, email);
  log('Step 3: Email filled');

  // Check if password field is on the same page (wait a bit for it to appear)
  let passwordInput = await waitForPasswordField(3000);

  if (!passwordInput) {
    // Need to submit email first to get to password page
    log('Step 3: No password field yet, submitting email first...');
    const submitBtn = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);

    if (submitBtn) {
      simulateClick(submitBtn);
      log('Step 3: Submitted email, waiting for password field...');
      await sleepRandom(1800, 2500);
    }

    try {
      passwordInput = await waitForElement('input[type="password"]', 10000);
    } catch {
      throw new Error('Could not find password input after submitting email. URL: ' + location.href);
    }
  }

  if (!payload.password) throw new Error('No password provided. Step 3 requires a generated password.');
  fillInput(passwordInput, payload.password);
  log('Step 3: Password filled');

  // Submit the form first
  await sleepRandom(450, 900);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|sign\s*up|submit|注册|创建|create/i, 5000).catch(() => null);

  if (submitBtn) {
    simulateClick(submitBtn);
    log('Step 3: Form submitted, waiting for response...');
  }
  
  // Wait and check for errors (e.g., "account already exists")
  await sleepRandom(1500, 2500);
  
  // Check for error messages indicating account already exists
  const errorSelectors = [
    '[role="alert"]',
    '.error',
    '.error-message',
    '[class*="error"]',
    '[class*="Error"]',
    '[data-testid*="error"]'
  ];
  
  for (const selector of errorSelectors) {
    const errorElements = document.querySelectorAll(selector);
    for (const elem of errorElements) {
      const errorText = elem.textContent || '';
      // Check for various "account exists" messages in English and Chinese
      if (
        errorText.includes('already exists') ||
        errorText.includes('already registered') ||
        errorText.includes('already in use') ||
        errorText.includes('already taken') ||
        errorText.includes('与此电子邮件地址相关联的帐户已存在') ||
        errorText.includes('账户已存在') ||
        errorText.includes('邮箱已被注册') ||
        errorText.includes('该邮箱已注册')
      ) {
        log('Step 3: Account already exists error detected!');
        throw new Error('EMAIL_EXISTS: 与此电子邮件地址相关联的帐户已存在，需要重新生成邮箱');
      }
    }
  }
  
  // Report complete after checking for errors
  reportComplete(3, { email });
  log('Step 3: Completed successfully');
}

// ============================================================
// Fill Verification Code (used by step 4 and step 7)
// ============================================================

async function fillVerificationCode(step, payload) {
  const { code } = payload;
  if (!code) throw new Error('No verification code provided.');

  log(`Step ${step}: Waiting for verification code page to render...`);
  await sleepRandom(1200, 2200);
  log(`Step ${step}: Filling verification code: ${code}`);

  // Find code input — could be a single input or multiple separate inputs
  let codeInput = null;
  try {
    codeInput = await waitForElement(
      'input[name="code"], input[name="otp"], input[type="text"][maxlength="6"], input[aria-label*="code"], input[placeholder*="code"], input[placeholder*="Code"], input[inputmode="numeric"]',
      10000
    );
  } catch {
    // Check for multiple single-digit inputs (common pattern)
    const singleInputs = document.querySelectorAll('input[maxlength="1"]');
    if (singleInputs.length >= 6) {
      log(`Step ${step}: Found single-digit code inputs, filling individually...`);
      for (let i = 0; i < 6 && i < singleInputs.length; i++) {
        fillInput(singleInputs[i], code[i]);
        await sleep(100);
      }
      await sleepRandom(900, 1500);
      reportComplete(step);
      return;
    }
    throw new Error('Could not find verification code input. URL: ' + location.href);
  }

  fillInput(codeInput, code);
  log(`Step ${step}: Code filled`);

  // Report complete BEFORE submit (page may navigate away)
  reportComplete(step);

  // Submit
  await sleepRandom(450, 900);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /verify|confirm|submit|continue|确认|验证/i, 5000).catch(() => null);

  if (submitBtn) {
    simulateClick(submitBtn);
    log(`Step ${step}: Verification submitted`);
  }
}

async function stepResendVerificationEmail(step) {
  log(`Step ${step}: Waiting for resend verification email button...`);
  await sleepRandom(1200, 2200);

  let resendBtn = document.querySelector(
    'button[name="intent"][value="resend"][type="submit"], input[name="intent"][value="resend"][type="submit"]'
  );
  if (!resendBtn) {
    const resendPattern = /重新发送电子邮件|重新发送|再次发送|重发|resend|send again|verification email|验证电子邮件/i;
    resendBtn = await waitForActionElement(resendPattern, 15000).catch(() => null);
  }
  if (!resendBtn) {
    throw new Error('Could not find resend verification email button on auth page.');
  }

  const disabled = resendBtn.disabled
    || resendBtn.getAttribute('aria-disabled') === 'true'
    || resendBtn.getAttribute('disabled') !== null;
  if (disabled) {
    throw new Error('Resend verification email button is disabled.');
  }

  await activateActionElement(resendBtn, `Step ${step} resend`);
  log(`Step ${step}: Resend verification email requested`);
}

// ============================================================
// Step 6: Login with registered account (on OAuth auth page)
// ============================================================

async function step6_login(payload) {
  const { email, password } = payload;
  if (!email) throw new Error('No email provided for login.');

  log(`Step 6: Waiting for login page to render...`);
  await sleepRandom(1800, 3200);
  log(`Step 6: Logging in with ${email}...`);

  // Wait for email input on the auth page
  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email" i], input[placeholder*="Email"]',
      15000
    );
  } catch {
    throw new Error('Could not find email input on login page. URL: ' + location.href);
  }

  fillInput(emailInput, email);
  log('Step 6: Email filled');

  // Submit email
  await sleepRandom(450, 900);
  const submitBtn1 = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);
  if (submitBtn1) {
    simulateClick(submitBtn1);
    log('Step 6: Submitted email');
  }

  // Wait for password field to appear (with timeout)
  const passwordInput = await waitForLoginPasswordField();
  if (passwordInput) {
    log('Step 6: Password field found, filling password...');
    fillInput(passwordInput, password);

    await sleepRandom(450, 900);
    const submitBtn2 = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|log\s*in|submit|sign\s*in|登录|继续/i, 5000).catch(() => null);

    // Report complete BEFORE submit in case page navigates
    reportComplete(6, { needsOTP: true });

    if (submitBtn2) {
      simulateClick(submitBtn2);
      log('Step 6: Submitted password, may need verification code (step 7)');
    }
    return;
  }

  // No password field — OTP flow
  log('Step 6: No password field. OTP flow or auto-redirect.');
  reportComplete(6, { needsOTP: true });
}

async function waitForLoginPasswordField(timeout = 25000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const passwordInput = findVisiblePasswordInput();
    if (passwordInput) {
      return passwordInput;
    }

    await sleep(250);
  }

  log(`Step 6: Password field did not appear within ${Math.round(timeout / 1000)}s.`, 'warn');
  return null;
}

function findVisiblePasswordInput() {
  const inputs = document.querySelectorAll('input[type="password"]');
  for (const input of inputs) {
    if (isElementVisible(input)) {
      return input;
    }
  }
  return null;
}

function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

async function waitForPasswordField(timeout = 3000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const passwordInput = findVisiblePasswordInput();
    if (passwordInput) {
      return passwordInput;
    }

    await sleep(250);
  }

  return null;
}

// ============================================================
// Step 8: Find "继续" on OAuth consent page for debugger click
// ============================================================
// After login + verification, page shows:
// "使用 ChatGPT 登录到 Codex" with a "继续" submit button.
// Background performs the actual click through the debugger Input API.

async function step8_findAndClick() {
  log('Step 8: Looking for OAuth consent "继续" button...');

  const continueBtn = await findContinueButton();
  await waitForButtonEnabled(continueBtn);

  await sleepRandom(350, 900);
  
  // 滚动到按钮位置
  continueBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(500);  // 等待滚动动画完成
  
  // 聚焦按钮
  continueBtn.focus();
  await sleep(250);
  
  // 再次检查按钮是否在视口内
  const initialRect = continueBtn.getBoundingClientRect();
  log(`Step 8: Button position after scroll: top=${initialRect.top}, left=${initialRect.left}, width=${initialRect.width}, height=${initialRect.height}`);
  
  // 如果按钮不在视口内，再次滚动
  if (initialRect.top < 0 || initialRect.top > window.innerHeight) {
    log('Step 8: Button not fully visible, scrolling again...', 'warn');
    continueBtn.scrollIntoView({ behavior: 'auto', block: 'center' });
    await sleep(500);
  }

  const rect = getSerializableRect(continueBtn);
  log('Step 8: Found "继续" button and prepared debugger click coordinates.');
  
  return {
    rect,
    buttonText: (continueBtn.textContent || '').trim(),
    url: location.href,
  };
}

async function findContinueButton() {
  try {
    return await waitForElement(
      'button[type="submit"][data-dd-action-name="Continue"], button[type="submit"]._primary_3rdp0_107',
      10000
    );
  } catch {
    try {
      return await waitForElementByText('button', /继续|Continue/, 5000);
    } catch {
      throw new Error('Could not find "继续" button on OAuth consent page. URL: ' + location.href);
    }
  }
}

async function waitForButtonEnabled(button, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (isButtonEnabled(button)) return;
    await sleep(150);
  }
  throw new Error('"继续" button stayed disabled for too long. URL: ' + location.href);
}

function isButtonEnabled(button) {
  return Boolean(button)
    && !button.disabled
    && button.getAttribute('aria-disabled') !== 'true';
}

function getSerializableRect(el) {
  const rect = el.getBoundingClientRect();
  
  // 添加详细的调试日志
  console.log('[Step 8] Button rect:', {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.right,
    bottom: rect.bottom,
  });
  
  if (!rect.width || !rect.height) {
    throw new Error('"继续" button has no clickable size after scrolling. URL: ' + location.href);
  }

  // 计算中心点坐标
  const centerX = rect.left + (rect.width / 2);
  const centerY = rect.top + (rect.height / 2);
  
  // 验证坐标是否有效
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
    throw new Error(
      `Invalid button coordinates: centerX=${centerX}, centerY=${centerY}. ` +
      `Rect: left=${rect.left}, top=${rect.top}, width=${rect.width}, height=${rect.height}`
    );
  }
  
  // 验证坐标是否在视口内
  if (centerX < 0 || centerY < 0 || centerX > window.innerWidth || centerY > window.innerHeight) {
    log(`Warning: Button center (${centerX}, ${centerY}) is outside viewport (${window.innerWidth}x${window.innerHeight})`, 'warn');
  }

  const result = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    centerX: centerX,
    centerY: centerY,
  };
  
  console.log('[Step 8] Calculated button center:', result);
  
  return result;
}

/**
 * 获取当前页面状态（用于验证 Step 8 点击效果）
 */
function getPageState() {
  try {
    // 查找"继续"按钮
    let continueBtn = null;
    try {
      continueBtn = document.querySelector(
        'button[type="submit"][data-dd-action-name="Continue"], button[type="submit"]._primary_3rdp0_107'
      );
      if (!continueBtn) {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (/继续|Continue/i.test(btn.textContent)) {
            continueBtn = btn;
            break;
          }
        }
      }
    } catch (e) {
      console.log('[getPageState] Error finding button:', e);
    }
    
    return {
      url: location.href,
      buttonExists: !!continueBtn,
      buttonDisabled: continueBtn ? (continueBtn.disabled || continueBtn.getAttribute('aria-disabled') === 'true') : null,
      buttonText: continueBtn ? continueBtn.textContent.trim() : null,
      buttonVisible: continueBtn ? (continueBtn.offsetParent !== null) : null,
    };
  } catch (err) {
    return {
      error: err.message,
      url: location.href,
    };
  }
}

// ============================================================
// Step 5: Fill Name & Birthday
// ============================================================

// Helper to set a spinbutton value via focus + keyboard input
async function setSpinButton(el, value) {
  el.focus();
  await sleep(100);

  // Select all existing text
  document.execCommand('selectAll', false, null);
  await sleep(50);

  // Type the new value digit by digit
  const valueStr = String(value);
  for (const char of valueStr) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: `Digit${char}`, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: `Digit${char}`, bubbles: true }));
    // Also use InputEvent for React Aria
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true }));
    el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
    await sleep(50);
  }

  el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', code: 'Tab', bubbles: true }));
  el.blur();
  await sleep(100);
}

async function step5_fillNameBirthday(payload) {
  const { firstName, lastName, year, month, day } = payload;
  if (!firstName || !lastName) throw new Error('No name data provided.');

  log('Step 5: Waiting for name/birthday page to render...');
  await sleepRandom(1800, 3200);

  const fullName = `${firstName} ${lastName}`;
  log(`Step 5: Filling name: ${fullName}, Birthday: ${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`);

  // Actual DOM structure:
  // - Full name: <input name="name" placeholder="全名" type="text">
  // - Birthday: React Aria DateField with 3 spinbutton divs (year/month/day)
  //   + <input type="hidden" name="birthday" value="2026-04-05">

  // --- Full Name (single field, not first+last) ---
  let nameInput = null;
  try {
    nameInput = await waitForElement(
      'input[name="name"], input[placeholder*="全名"], input[autocomplete="name"]',
      10000
    );
  } catch {
    throw new Error('Could not find name input. URL: ' + location.href);
  }
  fillInput(nameInput, fullName);
  log(`Step 5: Name filled: ${fullName}`);

  // --- Birthday/Age field ---
  // OpenAI may show either:
  // 1. Birthday field with spinbuttons (year/month/day)
  // 2. Age field (simple number input)
  
  // First, check if there's an age input field
  const ageInput = document.querySelector('input[name="age"], input[id*="age"]');
  
  if (ageInput) {
    // Use age field instead of birthday
    log('Step 5: Found age input field, calculating age from birthday...');
    
    const currentYear = new Date().getFullYear();
    const age = currentYear - year;
    
    log(`Step 5: Setting age to ${age} (born in ${year})`);
    
    // Fill the age input
    ageInput.value = String(age);
    ageInput.dispatchEvent(new Event('input', { bubbles: true }));
    ageInput.dispatchEvent(new Event('change', { bubbles: true }));
    ageInput.dispatchEvent(new Event('blur', { bubbles: true }));
    
    // Try React native setter
    try {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(ageInput, String(age));
        ageInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (e) {
      log(`Step 5: React native setter failed: ${e.message}`, 'warn');
    }
    
    log(`Step 5: Age set to ${age}`);
  } else {
    // Try birthday field with spinbuttons (old flow)
    log('Step 5: Age field not found, trying birthday spinbuttons...');
    
    // Try multiple selector strategies for spinbuttons
    let yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    let monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    let daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');
    
    // Alternative selectors if first attempt fails
    if (!yearSpinner || !monthSpinner || !daySpinner) {
      const allSpinbuttons = document.querySelectorAll('[role="spinbutton"]');
      if (allSpinbuttons.length === 3) {
        log('Step 5: Found 3 spinbuttons without data-type, assuming order: month, day, year');
        monthSpinner = allSpinbuttons[0];
        daySpinner = allSpinbuttons[1];
        yearSpinner = allSpinbuttons[2];
      }
    }

    if (yearSpinner && monthSpinner && daySpinner) {
      log('Step 5: Found React Aria DateField spinbuttons');

      await setSpinButton(yearSpinner, year);
      log(`Step 5: Year set: ${year}`);

      await setSpinButton(monthSpinner, String(month).padStart(2, '0'));
      log(`Step 5: Month set: ${month}`);

      await setSpinButton(daySpinner, String(day).padStart(2, '0'));
      log(`Step 5: Day set: ${day}`);

      // Also update the hidden input directly as a safety measure
      const hiddenBirthday = document.querySelector('input[type="hidden"][name="birthday"]');
      if (hiddenBirthday) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        hiddenBirthday.value = dateStr;
        hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
        log(`Step 5: Hidden birthday input set: ${dateStr}`);
      }
    } else {
      // Fallback: try setting hidden input directly and trigger UI update
      log('Step 5: Spinbuttons not found, trying alternative methods...');
      
      // First, try to find and focus on the date field to make spinbuttons appear
      const dateFieldContainer = document.querySelector('[role="group"][aria-label*="生日"], [role="group"][aria-label*="Birthday"], [role="group"]');
      if (dateFieldContainer) {
        log('Step 5: Found date field container, clicking to activate...');
        dateFieldContainer.click();
        await sleepRandom(300, 600);
        
        // Try to find spinbuttons again after clicking
        yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
        monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
        daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');
        
        if (!yearSpinner || !monthSpinner || !daySpinner) {
          const allSpinbuttons = document.querySelectorAll('[role="spinbutton"]');
          if (allSpinbuttons.length === 3) {
            log('Step 5: Found 3 spinbuttons after click, assuming order: month, day, year');
            monthSpinner = allSpinbuttons[0];
            daySpinner = allSpinbuttons[1];
            yearSpinner = allSpinbuttons[2];
          }
        }
        
        if (yearSpinner && monthSpinner && daySpinner) {
          log('Step 5: Spinbuttons now available after click');
          await setSpinButton(yearSpinner, year);
          log(`Step 5: Year set: ${year}`);
          await setSpinButton(monthSpinner, String(month).padStart(2, '0'));
          log(`Step 5: Month set: ${month}`);
          await setSpinButton(daySpinner, String(day).padStart(2, '0'));
          log(`Step 5: Day set: ${day}`);
        }
      }
      
      const hiddenBirthday = document.querySelector('input[name="birthday"]');
      if (hiddenBirthday) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        
        // Try multiple methods to set the value
        hiddenBirthday.value = dateStr;
        
        // Trigger various events to ensure React/framework picks up the change
        hiddenBirthday.dispatchEvent(new Event('input', { bubbles: true }));
        hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
        hiddenBirthday.dispatchEvent(new Event('blur', { bubbles: true }));
        
        // Try to trigger React's internal state update
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(hiddenBirthday, dateStr);
          hiddenBirthday.dispatchEvent(new Event('input', { bubbles: true }));
        }
        
        log(`Step 5: Birthday set via hidden input: ${dateStr}`);
      } else {
        log('Step 5: WARNING - Could not find birthday fields. May need to adjust selectors.', 'warn');
      }
    }
  }

  // Korean consent page: only click "allCheckboxes" once to accept all required consents.
  await sleepRandom(250, 450);
  const allConsentInput = document.querySelector(
    'input[name="allCheckboxes"], input[id$="-allCheckboxes"]'
  );
  if (allConsentInput) {
    if (!allConsentInput.checked) {
      const clickable = allConsentInput.closest('label') || allConsentInput;
      clickable.scrollIntoView({ block: 'center', inline: 'nearest' });
      await sleepRandom(80, 180);
      // Use native click for checkbox frameworks that rely on internal handlers.
      clickable.click();
      await sleepRandom(150, 300);

      if (!allConsentInput.checked) {
        // Fallback: force state and emit events for reactive forms.
        allConsentInput.checked = true;
        allConsentInput.dispatchEvent(new Event('input', { bubbles: true }));
        allConsentInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      log('Step 5: Clicked "我同意以下所有各项" checkbox');
    } else {
      log('Step 5: "我同意以下所有各项" already checked');
    }
  }

  // Verify and retry filling if needed (max 3 attempts)
  const maxVerifyAttempts = 3;
  let verifySuccess = false;
  
  for (let attempt = 1; attempt <= maxVerifyAttempts; attempt++) {
    await sleepRandom(250, 450);
    log(`Step 5: Verification attempt ${attempt}/${maxVerifyAttempts}...`);
    
    // Check name field
    const nameValue = nameInput.value.trim();
    const nameOk = nameValue && nameValue.length >= 2;
    
    if (!nameOk) {
      log(`Step 5: Name field empty or invalid (got: "${nameValue}"), refilling...`, 'warn');
      fillInput(nameInput, fullName);
      await sleepRandom(300, 600);
      continue;
    }
    
    // Check age or birthday field
    const ageInputCheck = document.querySelector('input[name="age"], input[id*="age"]');
    let ageOrBirthdayOk = false;
    
    if (ageInputCheck) {
      // Verify age field
      const currentYear = new Date().getFullYear();
      const expectedAge = currentYear - year;
      const actualAge = parseInt(ageInputCheck.value) || 0;
      
      ageOrBirthdayOk = actualAge === expectedAge;
      
      if (!ageOrBirthdayOk) {
        log(`Step 5: Age field mismatch (expected: ${expectedAge}, got: ${actualAge}), refilling...`, 'warn');
        
        // Refill age
        ageInputCheck.value = String(expectedAge);
        ageInputCheck.dispatchEvent(new Event('input', { bubbles: true }));
        ageInputCheck.dispatchEvent(new Event('change', { bubbles: true }));
        ageInputCheck.dispatchEvent(new Event('blur', { bubbles: true }));
        
        // Try React native setter
        try {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(ageInputCheck, String(expectedAge));
            ageInputCheck.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } catch (e) {
          log(`Step 5: React native setter failed: ${e.message}`, 'warn');
        }
        
        await sleepRandom(300, 600);
        continue;
      }
    } else {
      // Verify birthday field (old flow)
      const hiddenBirthday = document.querySelector('input[type="hidden"][name="birthday"], input[name="birthday"]');
      const expectedDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      
      if (hiddenBirthday) {
        const actualDate = hiddenBirthday.value;
        ageOrBirthdayOk = actualDate === expectedDate;
        
        if (!ageOrBirthdayOk) {
          log(`Step 5: Birthday field mismatch (expected: "${expectedDate}", got: "${actualDate}"), refilling...`, 'warn');
          
          // Try to activate date field first
          const dateFieldContainer = document.querySelector('[role="group"][aria-label*="生日"], [role="group"][aria-label*="Birthday"], [role="group"]');
          if (dateFieldContainer) {
            dateFieldContainer.click();
            await sleepRandom(200, 400);
            log('Step 5: Clicked date field to activate spinbuttons');
          }
          
          // Try to refill using spinbuttons first
          let yearSpinnerRetry = document.querySelector('[role="spinbutton"][data-type="year"]');
          let monthSpinnerRetry = document.querySelector('[role="spinbutton"][data-type="month"]');
          let daySpinnerRetry = document.querySelector('[role="spinbutton"][data-type="day"]');
          
          // Alternative selectors
          if (!yearSpinnerRetry || !monthSpinnerRetry || !daySpinnerRetry) {
            const allSpinbuttons = document.querySelectorAll('[role="spinbutton"]');
            if (allSpinbuttons.length === 3) {
              log('Step 5: Using alternative spinbutton order: month, day, year');
              monthSpinnerRetry = allSpinbuttons[0];
              daySpinnerRetry = allSpinbuttons[1];
              yearSpinnerRetry = allSpinbuttons[2];
            }
          }
          
          if (yearSpinnerRetry && monthSpinnerRetry && daySpinnerRetry) {
            log('Step 5: Refilling via spinbuttons...');
            await setSpinButton(monthSpinnerRetry, String(month).padStart(2, '0'));
            await setSpinButton(daySpinnerRetry, String(day).padStart(2, '0'));
            await setSpinButton(yearSpinnerRetry, year);
            log('Step 5: Spinbuttons refilled');
          } else {
            log('Step 5: Spinbuttons still not found, using hidden input only', 'warn');
          }
          
          // Update hidden input with multiple event triggers
          hiddenBirthday.value = expectedDate;
          hiddenBirthday.dispatchEvent(new Event('input', { bubbles: true }));
          hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
          hiddenBirthday.dispatchEvent(new Event('blur', { bubbles: true }));
          
          // Try React native setter
          try {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            if (nativeInputValueSetter) {
              nativeInputValueSetter.call(hiddenBirthday, expectedDate);
              hiddenBirthday.dispatchEvent(new Event('input', { bubbles: true }));
            }
          } catch (e) {
            log(`Step 5: React native setter failed: ${e.message}`, 'warn');
          }
          
          await sleepRandom(300, 600);
          continue;
        }
      } else {
        // Check spinbutton values as fallback
        const yearSpinnerCheck = document.querySelector('[role="spinbutton"][data-type="year"]');
        const monthSpinnerCheck = document.querySelector('[role="spinbutton"][data-type="month"]');
        const daySpinnerCheck = document.querySelector('[role="spinbutton"][data-type="day"]');
        
        if (yearSpinnerCheck && monthSpinnerCheck && daySpinnerCheck) {
          const yearValue = yearSpinnerCheck.textContent?.trim();
          const monthValue = monthSpinnerCheck.textContent?.trim();
          const dayValue = daySpinnerCheck.textContent?.trim();
          
          ageOrBirthdayOk = yearValue === String(year) && 
                           monthValue === String(month).padStart(2, '0') && 
                           dayValue === String(day).padStart(2, '0');
          
          if (!ageOrBirthdayOk) {
            log(`Step 5: Birthday spinbuttons mismatch (expected: ${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}, got: ${yearValue}-${monthValue}-${dayValue}), refilling...`, 'warn');
            
            await setSpinButton(yearSpinnerCheck, year);
            await setSpinButton(monthSpinnerCheck, String(month).padStart(2, '0'));
            await setSpinButton(daySpinnerCheck, String(day).padStart(2, '0'));
            await sleepRandom(300, 600);
            continue;
          }
        } else {
          log('Step 5: WARNING - Could not verify age/birthday fields', 'warn');
          ageOrBirthdayOk = true; // Assume OK if we can't verify
        }
      }
    }
    
    // Both fields verified successfully
    if (nameOk && ageOrBirthdayOk) {
      log(`Step 5: All fields verified successfully on attempt ${attempt}`);
      verifySuccess = true;
      break;
    }
  }
  
  if (!verifySuccess) {
    throw new Error(`Step 5: Failed to verify name/age/birthday fields after ${maxVerifyAttempts} attempts`);
  }

  // Click "完成帐户创建" button
  await sleepRandom(450, 900);
  const completeBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /完成|create|continue|finish|done|agree/i, 5000).catch(() => null);

  if (completeBtn) {
    simulateClick(completeBtn);
    log('Step 5: Clicked "完成帐户创建", waiting for page navigation...');
    
    // Wait for page to navigate to OAuth login page
    // The page should either:
    // 1. Navigate to a different URL (OAuth login page)
    // 2. Show OAuth consent elements
    // 3. Show add-phone page (which is handled in Step 8)
    const currentUrl = location.href;
    const navigationTimeout = 30000; // 30 seconds
    const startTime = Date.now();
    
    while (Date.now() - startTime < navigationTimeout) {
      // Check if URL has changed (navigated away)
      if (location.href !== currentUrl) {
        log(`Step 5: Page navigated to ${location.href}`);
        break;
      }
      
      // Check if OAuth consent elements appeared (sometimes no URL change)
      const oauthElements = document.querySelector('[data-dd-action-name="Continue"]') 
        || document.querySelector('button[type="submit"]._primary_3rdp0_107')
        || document.querySelector('button:not([disabled])');
      
      if (oauthElements && location.href !== currentUrl) {
        log('Step 5: OAuth consent page detected');
        break;
      }
      
      await sleep(500);
    }
    
    // Give the new page a moment to stabilize
    await sleepRandom(800, 1500);
    
    // Report complete AFTER navigation is confirmed
    reportComplete(5);
    log('Step 5: Navigation confirmed, step complete');
  } else {
    throw new Error('Could not find "完成帐户创建" button');
  }
}
