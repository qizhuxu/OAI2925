/**
 * 小苹果取件 API 封装
 * API 文档: https://apple.882263.xyz/api.html
 */

class AppleMailAPI {
  constructor() {
    this.baseURL = 'https://apple.882263.xyz';
  }

  /**
   * 获取最新一封邮件
   */
  async getLatestMail(params) {
    const { refreshToken, clientId, email, mailbox = 'INBOX', responseType = 'json' } = params;

    const url = new URL(`${this.baseURL}/api/mail-new`);
    url.searchParams.append('refresh_token', refreshToken);
    url.searchParams.append('client_id', clientId);
    url.searchParams.append('email', email);
    url.searchParams.append('mailbox', mailbox);
    url.searchParams.append('response_type', responseType);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`API 请求失败: ${response.status}`);
    }
    return await response.json();
  }

  /**
   * 获取全部邮件
   */
  async getAllMails(params) {
    const { refreshToken, clientId, email, mailbox = 'INBOX' } = params;

    const url = new URL(`${this.baseURL}/api/mail-all`);
    url.searchParams.append('refresh_token', refreshToken);
    url.searchParams.append('client_id', clientId);
    url.searchParams.append('email', email);
    url.searchParams.append('mailbox', mailbox);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`API 请求失败: ${response.status}`);
    }
    return await response.json();
  }

  /**
   * 清空收件箱
   */
  async clearInbox(params) {
    const { refreshToken, clientId, email } = params;

    const url = new URL(`${this.baseURL}/api/process-inbox`);
    url.searchParams.append('refresh_token', refreshToken);
    url.searchParams.append('client_id', clientId);
    url.searchParams.append('email', email);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`API 请求失败: ${response.status}`);
    }
    return await response.json();
  }

  /**
   * 清空垃圾箱
   */
  async clearJunk(params) {
    const { refreshToken, clientId, email } = params;

    const url = new URL(`${this.baseURL}/api/process-junk`);
    url.searchParams.append('refresh_token', refreshToken);
    url.searchParams.append('client_id', clientId);
    url.searchParams.append('email', email);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`API 请求失败: ${response.status}`);
    }
    return await response.json();
  }

  /**
   * 清空所有邮箱（收件箱 + 垃圾箱）
   */
  async clearAllMailboxes(params) {
    await this.clearInbox(params);
    await this.clearJunk(params);
    return { success: true, message: '已清空收件箱和垃圾箱' };
  }

  /**
   * 从邮件中提取验证码
   */
  extractVerificationCode(mailContent) {
    if (!mailContent) return null;

    const patterns = [
      /\b(\d{6})\b/,
      /code[:\s]+(\d{6})/i,
      /verification code[:\s]+(\d{6})/i,
      /验证码[：:\s]+(\d{6})/,
    ];

    for (const pattern of patterns) {
      const match = mailContent.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * 获取验证码（智能检测收件箱和垃圾箱）
   */
  async getVerificationCode(params, maxRetries = 10, retryDelay = 3000) {
    const { refreshToken, clientId, email } = params;

    for (let i = 0; i < maxRetries; i++) {
      try {
        console.log(`[AppleAPI] 尝试 ${i + 1}/${maxRetries} - 检查收件箱...`);
        
        // 先检查收件箱
        let mail = await this.getLatestMail({
          refreshToken,
          clientId,
          email,
          mailbox: 'INBOX'
        });

        console.log('[AppleAPI] 收件箱响应:', mail);

        if (mail) {
          // 尝试从不同字段提取验证码
          const mailContent = mail.body || mail.content || mail.text || JSON.stringify(mail);
          const code = this.extractVerificationCode(mailContent);
          if (code) {
            console.log(`[AppleAPI] ✅ 在收件箱找到验证码: ${code}`);
            return { code, mailbox: 'INBOX', mail };
          }
        }

        console.log(`[AppleAPI] 尝试 ${i + 1}/${maxRetries} - 检查垃圾箱...`);
        
        // 再检查垃圾箱
        mail = await this.getLatestMail({
          refreshToken,
          clientId,
          email,
          mailbox: 'Junk'
        });

        console.log('[AppleAPI] 垃圾箱响应:', mail);

        if (mail) {
          const mailContent = mail.body || mail.content || mail.text || JSON.stringify(mail);
          const code = this.extractVerificationCode(mailContent);
          if (code) {
            console.log(`[AppleAPI] ✅ 在垃圾箱找到验证码: ${code}`);
            return { code, mailbox: 'Junk', mail };
          }
        }

        if (i < maxRetries - 1) {
          console.log(`[AppleAPI] 未找到验证码，等待 ${retryDelay / 1000} 秒后重试...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      } catch (error) {
        console.error(`[AppleAPI] 获取验证码失败 (尝试 ${i + 1}/${maxRetries}):`, error);
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }

    throw new Error('获取验证码超时');
  }

  /**
   * 等待新邮件（基于时间戳）
   */
  async waitForNewMail(params, afterTimestamp, maxWaitTime = 60000, checkInterval = 3000) {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      const inboxMail = await this.getLatestMail({
        ...params,
        mailbox: 'INBOX'
      });

      if (inboxMail && inboxMail.date) {
        const mailTime = new Date(inboxMail.date).getTime();
        if (mailTime > afterTimestamp) {
          const code = this.extractVerificationCode(inboxMail.body);
          if (code) {
            return { code, mailbox: 'INBOX', mail: inboxMail };
          }
        }
      }

      const junkMail = await this.getLatestMail({
        ...params,
        mailbox: 'Junk'
      });

      if (junkMail && junkMail.date) {
        const mailTime = new Date(junkMail.date).getTime();
        if (mailTime > afterTimestamp) {
          const code = this.extractVerificationCode(junkMail.body);
          if (code) {
            return { code, mailbox: 'Junk', mail: junkMail };
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    throw new Error('等待新邮件超时');
  }
}
