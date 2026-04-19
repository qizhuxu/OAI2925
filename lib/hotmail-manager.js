/**
 * Hotmail 邮箱管理器
 * 负责邮箱数据的存储、查询和使用次数管理
 */

class HotmailManager {
  constructor() {
    this.dbName = 'OAI2925_Hotmail_DB';
    this.dbVersion = 1;
    this.storeName = 'hotmail_accounts';
    this.db = null;
  }

  /**
   * 初始化数据库
   */
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        if (!db.objectStoreNames.contains(this.storeName)) {
          const objectStore = db.createObjectStore(this.storeName, { keyPath: 'email' });
          objectStore.createIndex('usageCount', 'usageCount', { unique: false });
          objectStore.createIndex('lastUsed', 'lastUsed', { unique: false });
        }
      };
    });
  }

  /**
   * 解析邮箱信息字符串
   * 格式: 邮箱----密码----client_id----refresh_token
   */
  parseEmailLine(line) {
    const parts = line.trim().split('----');
    if (parts.length !== 4) {
      throw new Error(`无效的邮箱格式: ${line}`);
    }

    return {
      email: parts[0].trim(),
      password: parts[1].trim(),
      clientId: parts[2].trim(),
      refreshToken: parts[3].trim(),
      usageCount: 0,
      lastUsed: null,
      createdAt: new Date().toISOString()
    };
  }

  /**
   * 添加单个邮箱
   */
  async addEmail(emailData) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const objectStore = transaction.objectStore(this.storeName);
      
      const request = objectStore.put(emailData);
      request.onsuccess = () => resolve(emailData);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 批量导入邮箱
   */
  async importEmails(emailLines) {
    const results = {
      success: [],
      failed: [],
      skipped: []
    };

    for (const line of emailLines) {
      if (!line.trim()) continue;

      try {
        const emailData = this.parseEmailLine(line);
        
        const existing = await this.getEmail(emailData.email);
        if (existing) {
          results.skipped.push({
            email: emailData.email,
            reason: '邮箱已存在'
          });
          continue;
        }

        await this.addEmail(emailData);
        results.success.push(emailData.email);
      } catch (error) {
        results.failed.push({
          line: line,
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * 从 JSON 文件导入
   */
  async importFromJSON(jsonData) {
    const emailLines = [];
    
    if (Array.isArray(jsonData)) {
      for (const item of jsonData) {
        const line = `${item.email}----${item.password}----${item.clientId}----${item.refreshToken}`;
        emailLines.push(line);
      }
    } else if (typeof jsonData === 'object') {
      for (const [email, data] of Object.entries(jsonData)) {
        const line = `${email}----${data.password}----${data.clientId}----${data.refreshToken}`;
        emailLines.push(line);
      }
    }

    return await this.importEmails(emailLines);
  }

  /**
   * 获取单个邮箱信息
   */
  async getEmail(email) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readonly');
      const objectStore = transaction.objectStore(this.storeName);
      
      const request = objectStore.get(email);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 获取所有邮箱
   */
  async getAllEmails() {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readonly');
      const objectStore = transaction.objectStore(this.storeName);
      
      const request = objectStore.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 获取可用邮箱（使用次数 < 6）
   */
  async getAvailableEmails() {
    const allEmails = await this.getAllEmails();
    return allEmails.filter(email => email.usageCount < 6);
  }

  /**
   * 获取下一个可用邮箱
   */
  async getNextAvailableEmail() {
    const availableEmails = await this.getAvailableEmails();
    
    if (availableEmails.length === 0) {
      throw new Error('没有可用的 Hotmail 邮箱，请导入新的邮箱信息');
    }

    availableEmails.sort((a, b) => a.usageCount - b.usageCount);
    return availableEmails[0];
  }

  /**
   * 生成邮箱别名
   * 主邮箱: abc@hotmail.com (usageCount = 0)
   * 别名 1: abc+01@hotmail.com (usageCount = 1)
   * 别名 2: abc+02@hotmail.com (usageCount = 2)
   * ...
   */
  generateAlias(email, usageCount) {
    if (usageCount === 0) {
      return email;
    }

    const [localPart, domain] = email.split('@');
    const aliasNumber = String(usageCount).padStart(2, '0');
    return `${localPart}+${aliasNumber}@${domain}`;
  }

  /**
   * 增加邮箱使用次数
   */
  async incrementUsage(email) {
    const emailData = await this.getEmail(email);
    if (!emailData) {
      throw new Error(`邮箱不存在: ${email}`);
    }

    if (emailData.usageCount >= 6) {
      throw new Error(`邮箱已达使用上限: ${email}`);
    }

    emailData.usageCount += 1;
    emailData.lastUsed = new Date().toISOString();

    return await this.addEmail(emailData);
  }

  /**
   * 删除邮箱
   */
  async deleteEmail(email) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const objectStore = transaction.objectStore(this.storeName);
      
      const request = objectStore.delete(email);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 清空所有邮箱
   */
  async clearAll() {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const objectStore = transaction.objectStore(this.storeName);
      
      const request = objectStore.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 导出所有邮箱数据
   */
  async exportEmails() {
    const allEmails = await this.getAllEmails();
    return allEmails.map(email => ({
      email: email.email,
      password: email.password,
      clientId: email.clientId,
      refreshToken: email.refreshToken,
      usageCount: email.usageCount,
      lastUsed: email.lastUsed
    }));
  }

  /**
   * 获取统计信息
   */
  async getStats() {
    const allEmails = await this.getAllEmails();
    const availableEmails = allEmails.filter(e => e.usageCount < 6);
    const fullEmails = allEmails.filter(e => e.usageCount >= 6);

    return {
      total: allEmails.length,
      available: availableEmails.length,
      full: fullEmails.length,
      totalUsage: allEmails.reduce((sum, e) => sum + e.usageCount, 0),
      maxPossibleUsage: allEmails.length * 6
    };
  }
}
