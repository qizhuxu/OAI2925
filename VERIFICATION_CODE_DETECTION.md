# 验证码检测逻辑重构说明

## 问题背景

### 旧版本的问题

1. **固定等待时间不可靠**
   - 只等待 1.5-2 秒就检查结果
   - OpenAI 页面跳转通常需要 3-5 秒
   - 导致在页面还在处理时就误判为失败

2. **检测逻辑过于简单**
   ```javascript
   // 旧逻辑：只要输入框还在就认为失败
   const stillOnCodePage = document.querySelector('input[name="code"]');
   if (stillOnCodePage) {
     throw new Error('验证码错误');
   }
   ```
   - 没有区分"处理中"和"真正失败"
   - 没有考虑页面跳转延迟
   - 容易误判正确的验证码

3. **错误检测过于宽泛**
   ```javascript
   // 旧正则：会匹配"重新发送"等正常按钮
   /try again|重新发送/
   ```

## 新版本的改进

### 1. 多维度状态监听

使用 `Promise.race()` 同时监听多个状态变化：

```javascript
const result = await Promise.race([
  waitForNavigation(10000),        // 监听 URL 变化
  waitForElementDisappear(...),    // 监听输入框消失
  waitForErrorMessage(10000),      // 监听错误消息
  sleep(10000)                     // 超时保护
]);
```

### 2. 智能判断逻辑

根据不同的结果类型做出判断：

#### 情况 A：页面跳转（成功）
```javascript
if (result.type === 'navigation') {
  // URL 变化，说明验证成功并跳转到下一页
  reportComplete(step);
}
```

#### 情况 B：输入框消失（成功）
```javascript
if (result.type === 'disappeared') {
  // 输入框从 DOM 中移除或隐藏，说明验证成功
  reportComplete(step);
}
```

#### 情况 C：错误消息出现（失败）
```javascript
if (result.type === 'error') {
  // 页面显示明确的错误提示
  throw new Error('CODE_ERROR: 验证码错误');
}
```

#### 情况 D：超时（需要最终检查）
```javascript
if (result.type === 'timeout') {
  // 10秒后仍未检测到明确结果
  // 进行最终检查：
  // 1. 是否有错误消息？
  // 2. 输入框是否仍然可见且可用？
  // 3. 如果都不是，假设成功
}
```

### 3. 精确的错误检测

新的错误检测正则：

```javascript
/invalid.*code|incorrect.*code|wrong.*code|
 code.*invalid|code.*incorrect|
 验证码.*错误|错误.*验证码|
 验证码.*无效|无效.*验证码|
 验证码.*不正确|不正确.*验证码/
```

**只匹配真正的错误信息**，不会误判：
- ✅ "invalid code" → 错误
- ✅ "验证码错误" → 错误
- ❌ "重新发送验证码" → 不是错误
- ❌ "请输入验证码" → 不是错误

### 4. 新增的工具函数

#### `waitForNavigation(timeout)`
监听页面 URL 变化：
```javascript
const checkInterval = setInterval(() => {
  if (location.href !== startUrl) {
    resolve({ type: 'navigation', url: location.href });
  }
}, 100);
```

#### `waitForElementDisappear(selector, timeout)`
监听元素消失（从 DOM 移除或隐藏）：
```javascript
const observer = new MutationObserver(() => {
  const el = document.querySelector(selector);
  if (!el || el.offsetParent === null) {
    resolve({ type: 'disappeared' });
  }
});
```

#### `waitForErrorMessage(timeout)`
监听错误消息出现：
```javascript
const observer = new MutationObserver(() => {
  const bodyText = document.body?.innerText || '';
  if (errorPattern.test(bodyText)) {
    resolve({ type: 'error', message: ... });
  }
});
```

## 时序对比

### 旧版本
```
提交验证码
  ↓
等待 1.5-2 秒
  ↓
检查输入框是否存在
  ↓
存在 → 报错（误判！）
不存在 → 成功
```

### 新版本
```
提交验证码
  ↓
同时监听多个状态（最长 10 秒）：
  - URL 变化
  - 输入框消失
  - 错误消息出现
  ↓
任一状态触发 → 立即判断
  ↓
超时 → 最终检查
  ↓
根据实际状态决定成功/失败
```

## 优势

1. **更可靠**：不依赖固定等待时间，而是监听实际状态变化
2. **更快速**：一旦检测到状态变化立即响应，不需要等待完整超时
3. **更智能**：区分"处理中"、"成功"、"失败"三种状态
4. **更容错**：即使某个检测方法失败，还有其他方法兜底

## 测试场景

### 场景 1：验证码正确，快速跳转（2秒）
- ✅ 旧版本：可能成功（运气好）
- ✅ 新版本：2秒后检测到 URL 变化，立即报告成功

### 场景 2：验证码正确，慢速跳转（5秒）
- ❌ 旧版本：2秒后误判为失败
- ✅ 新版本：5秒后检测到 URL 变化，报告成功

### 场景 3：验证码错误，立即显示错误（1秒）
- ✅ 旧版本：2秒后检测到错误
- ✅ 新版本：1秒后立即检测到错误消息

### 场景 4：网络卡顿，页面无响应（10秒+）
- ❌ 旧版本：2秒后误判为失败
- ✅ 新版本：10秒超时后进行最终检查，根据实际状态判断

## 兼容性

- ✅ Chrome/Edge 90+
- ✅ Firefox 88+
- ✅ Safari 14+

所有使用的 API（MutationObserver, Promise.race）都是标准 Web API。

## 回滚方案

如果新版本出现问题，可以回滚到旧版本：

1. 恢复 `OAI2925/content/signup-page.js` 中的 `fillVerificationCode()` 函数
2. 移除 `OAI2925/content/utils.js` 中新增的工具函数

但建议先尝试调整超时时间或检测逻辑，而不是完全回滚。

## 未来优化方向

1. **自适应超时**：根据历史成功时间动态调整超时
2. **更多状态监听**：监听按钮状态变化（loading → normal）
3. **机器学习**：根据历史数据预测最可能的成功/失败模式
