/**
 * Hotmail 邮箱交互脚本（通过小苹果 API）
 * 不需要直接访问 Hotmail 网站，通过 API 获取邮件
 */

// 导入小苹果 API（在 background.js 中使用）
// 此文件主要用于定义 Hotmail 相关的辅助函数

/**
 * 验证 Hotmail 邮箱格式
 */
function isHotmailEmail(email) {
  const hotmailDomains = [
    '@hotmail.com',
    '@outlook.com',
    '@live.com',
    '@msn.com'
  ];
  
  return hotmailDomains.some(domain => email.toLowerCase().endsWith(domain));
}

/**
 * 解析 Hotmail 别名
 * abc+01@hotmail.com -> { base: 'abc@hotmail.com', alias: '01' }
 */
function parseHotmailAlias(email) {
  const match = email.match(/^([^+@]+)(\+(\d+))?@(.+)$/);
  if (!match) {
    return { base: email, alias: null };
  }

  const [, localPart, , alias, domain] = match;
  return {
    base: `${localPart}@${domain}`,
    alias: alias || null,
    full: email
  };
}

/**
 * 生成 Hotmail 别名
 */
function generateHotmailAlias(baseEmail, aliasNumber) {
  if (aliasNumber === 0) {
    return baseEmail;
  }

  const [localPart, domain] = baseEmail.split('@');
  const aliasStr = String(aliasNumber).padStart(2, '0');
  return `${localPart}+${aliasStr}@${domain}`;
}

// 导出函数供 background.js 使用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isHotmailEmail,
    parseHotmailAlias,
    generateHotmailAlias
  };
}
