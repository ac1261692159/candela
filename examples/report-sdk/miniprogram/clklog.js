/*!
 * ClkLog 微信小程序上报 SDK（零依赖，不 import 任何 npm 包）
 * =============================================================================
 * 引入方式（微信开发者工具）：
 *   1) 把本文件拷进小程序项目（如 utils/clklog.js）；
 *   2) const ClkLog = require('./utils/clklog.js');
 *   3) const clk = ClkLog.init({ token: '<项目token>', project: 'clklogapp' });
 *      clk.track('PageView', { page: 'index' });
 *      clk.login('uid-1001');        // 上报 track_signup 并绑定当前匿名ID
 *      clk.profileSet({ vip_level: 3 });
 *      clk.bindAppHideFlush();       // 小程序切后台时补发（小程序没有 sendBeacon）
 *
 * 宿主 API：wx.request / wx.getStorageSync / wx.setStorageSync / wx.getSystemInfoSync /
 *          wx.onAppHide（均为内置能力，不依赖 npm 包）。
 *
 * 规范文档：仓库根目录《数据上报规范与流程.md》§1（协议 / 编码硬要求）、§2、§3（用户标识口径）。
 * 关键点：data = base64(JSON 数组) → urlencode 表单字段；登录ID 走 identities.user_key，
 *        绑定匿名ID 走 properties.$track_signup_original_id（ClkLog 不吃神策顶层 login_id/original_id）。
 *
 * ⚠️ 实测层级（诚实说明，勿夸大）：
 *  - 已实测：本文件被 `node run-on-node.mjs` 用 **wx 垫片**（Node 24 内置 fetch 实现的
 *    wx.request/getStorageSync/setStorageSync/getSystemInfoSync）加载，跑通完整 5 步链并落 ClickHouse。
 *    垫片严格按官方文档语义实现（见 run-on-node.mjs 顶部注释），并断言 SDK 传的是**预编码字符串**。
 *  - 需真机/开发者工具：真机 wx.request 的 TLS/域名白名单（request 合法域名必须配置
 *    上报入口）、真机 storage 配额、真机 `wx.onAppHide` 触发时机、
 *    以及基础库对 `timeout` 字段的支持（2.10.0+）。这些本机无微信开发者工具，无法实测。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(); // 小程序（CommonJS）
  } else {
    root.ClkLog = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var LIB = 'miniprogram';   // lib.$lib（Lang 口径：miniprogram）
  var LIB_VERSION = '1.0.0';

  var DEFAULTS = {
    endpoint: 'https://example.com/receiver/api/gp',
    project: 'clklogapp',
    token: '',                 // 必填；禁止硬编码入库（AGENTS.md 红线 3）
    batchSize: 10,
    maxEventsPerRequest: 50,   // 规范 §10.3：单条 data ≤ 50 事件
    maxBodyBytes: 1048576,     // 规范 §10.3：body ≤ 1MB
    timeoutMs: 10000,
    maxAttempts: 3,
    retryBaseMs: 500,
    maxQueueLength: 500,
    storageKeyPrefix: 'clklog.',
    flushOnInit: true,
    autoCollectSystemInfo: true, // 自动附带 $os/$os_version/$model/$brand/$screen_* 预置属性（§4.3）
    debug: false
  };

  // ------------------------------------------------------------------ 基础工具

  /** UTF-8 字节（纯 JS：小程序基础库没有 Buffer/TextEncoder，不能依赖宿主提供）。 */
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00); i++; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  /** base64（纯 JS：小程序没有 btoa / Buffer）。 */
  function base64(str) {
    var bytes = utf8Bytes(str);
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i];
      var b1 = bytes[i + 1];
      var b2 = bytes[i + 2];
      out += B64.charAt(b0 >> 2);
      out += B64.charAt(((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4));
      out += b1 === undefined ? '=' : B64.charAt(((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6));
      out += b2 === undefined ? '=' : B64.charAt(b2 & 63);
    }
    return out;
  }

  /** 表单字段编码：手写 encodeURIComponent（不依赖 URLSearchParams——它不是处处可用）。 */
  function enc(value) {
    return encodeURIComponent(String(value));
  }

  function byteLength(str) {
    return utf8Bytes(str).length;
  }

  function now() {
    return Date.now(); // 毫秒
  }

  function safeParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  /** wx 存储适配器（同步 API）；wx 不可用时退化为内存，保证文件可被 Node 直接 require。 */
  function wxStorage() {
    var hasWxStorage = typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function';
    if (!hasWxStorage) {
      var mem = {};
      return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; }
      };
    }
    return {
      // 注意：wx.getStorageSync 缺 key 时返回 ''（不是 null），统一归一。
      getItem: function (k) {
        try { var v = wx.getStorageSync(k); return v === '' || v === undefined ? null : v; } catch (e) { return null; }
      },
      setItem: function (k, v) { try { wx.setStorageSync(k, v); } catch (e) { /* 配额/隐私设置：忽略写入 */ } },
      removeItem: function (k) { try { wx.removeStorageSync(k); } catch (e) { /* ignore */ } }
    };
  }

  // ------------------------------------------------------------------ SDK 主体

  /**
   * @param {object} options 见 DEFAULTS；额外支持 storage（注入式）、onEvent（观察发送结果）
   */
  function ClkLog(options) {
    if (!(this instanceof ClkLog)) return new ClkLog(options);
    var opts = {};
    var key;
    for (key in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) opts[key] = DEFAULTS[key];
    for (key in options) if (Object.prototype.hasOwnProperty.call(options, key)) opts[key] = options[key];

    if (!opts.token) {
      throw new Error('[clklog] init 缺少 token（从后台配置/接口下发，禁止硬编码入库）');
    }
    this.options = opts;
    this.endpoint = opts.endpoint;
    this.project = opts.project;
    this.token = opts.token;
    this.batchSize = opts.batchSize > 0 ? Math.min(opts.batchSize, opts.maxEventsPerRequest) : 1;
    this.storage = opts.storage || wxStorage();
    this.storageKeyPrefix = opts.storageKeyPrefix;
    this.queue = [];
    this.loginId = null;
    this.distinctId = opts.distinctId || null;
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    this._systemProps = null;
    this._inflight = null;
    this._appHideBound = false;
    this._ready = this._restore();
  }

  ClkLog.init = function (options) {
    if (!ClkLog.instance) ClkLog.instance = new ClkLog(options);
    return ClkLog.instance;
  };

  ClkLog.getDefault = function () {
    return ClkLog.instance || null;
  };

  ClkLog.base64 = base64;

  /**
   * 纯函数表单编码（发送与自检共用同一实现，便于离线核对 base64 → urlencode 是否真生效）。
   * @returns {string} application/x-www-form-urlencoded 的 body
   */
  ClkLog.formBody = function (events, project, token) {
    return 'project=' + enc(project) + '&token=' + enc(token) + '&data=' + enc(base64(JSON.stringify(events)));
  };

  ClkLog.prototype._emit = function (level, message, data) {
    if (this.onEvent) this.onEvent({ level: level, message: message, data: data });
    if (this.options.debug && typeof console !== 'undefined' && console.log) {
      console.log('[clklog][' + level + '] ' + message, data === undefined ? '' : data);
    }
  };

  ClkLog.prototype._key = function (name) {
    return this.storageKeyPrefix + name + '.' + this.project;
  };

  ClkLog.prototype._read = function (name) {
    return Promise.resolve()
      .then(function () { return this.storage.getItem(this._key(name)); }.bind(this))
      .then(function (v) { return v === undefined || v === '' ? null : v; })
      .catch(function () { return null; });
  };

  ClkLog.prototype._write = function (name, value) {
    try {
      var r = this.storage.setItem(this._key(name), value);
      if (r && typeof r.then === 'function') r.catch(function () {});
    } catch (e) {
      this._emit('error', 'storage 写入失败：' + e.message);
    }
  };

  ClkLog.prototype._remove = function (name) {
    try {
      var r = this.storage.removeItem(this._key(name));
      if (r && typeof r.then === 'function') r.catch(function () {});
    } catch (e) { /* ignore */ }
  };

  ClkLog.prototype._persistQueue = function () {
    if (this.queue.length === 0) this._remove('queue');
    else this._write('queue', JSON.stringify(this.queue));
  };

  ClkLog.prototype._restore = function () {
    var self = this;
    return self._read('distinct_id')
      .then(function (v) { if (!self.distinctId && typeof v === 'string') self.distinctId = v; })
      .then(function () { return self._read('queue'); })
      .then(function (raw) {
        var arr = typeof raw === 'string' ? safeParse(raw) : raw;
        if (Array.isArray(arr) && arr.length) {
          self.queue = arr.slice(-self.options.maxQueueLength);
          self._emit('info', '恢复离线队列 ' + self.queue.length + ' 条');
        }
        if (self.options.flushOnInit && self.queue.length) return self._flushQueue();
        return null;
      })
      .catch(function (err) { self._emit('error', 'restore 失败：' + err.message); });
  };

  ClkLog.prototype._ensureDistinctId = function () {
    if (!this.distinctId) {
      this.distinctId = this.options.distinctId ||
        ('anon-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
      this._write('distinct_id', this.distinctId);
      this._emit('info', '生成匿名ID：' + this.distinctId);
    }
    return this.distinctId;
  };

  ClkLog.prototype.getDistinctId = function () {
    var self = this;
    return Promise.resolve(this._ready).then(function () { return self._ensureDistinctId(); });
  };

  ClkLog.prototype.setDistinctId = function (id) {
    var self = this;
    return Promise.resolve(this._ready).then(function () {
      self.distinctId = id;
      self._write('distinct_id', id);
      return id;
    });
  };

  /** 设备预置属性（只取一次）：$os / $os_version / $model / $brand / $screen_width / $screen_height。 */
  ClkLog.prototype._collectSystemProps = function () {
    if (!this.options.autoCollectSystemInfo) return {};
    if (this._systemProps) return this._systemProps;
    var props = {};
    try {
      if (typeof wx !== 'undefined' && typeof wx.getSystemInfoSync === 'function') {
        var info = wx.getSystemInfoSync() || {};
        if (info.platform) props.$os = String(info.platform);
        if (info.system) props.$os_version = String(info.system);
        if (info.model) props.$model = String(info.model);
        if (info.brand) props.$brand = String(info.brand);
        if (info.screenWidth) props.$screen_width = Number(info.screenWidth);
        if (info.screenHeight) props.$screen_height = Number(info.screenHeight);
      }
    } catch (e) {
      this._emit('error', 'getSystemInfoSync 失败：' + e.message);
    }
    this._systemProps = props;
    return props;
  };

  ClkLog.prototype._mergeProps = function (properties) {
    var out = {};
    var sys = this._collectSystemProps();
    var k;
    for (k in sys) if (Object.prototype.hasOwnProperty.call(sys, k)) out[k] = sys[k];
    for (k in properties) if (Object.prototype.hasOwnProperty.call(properties, k)) out[k] = properties[k];
    return out;
  };

  ClkLog.prototype._libInfo = function () {
    return { $lib: LIB, $lib_method: 'code', $lib_version: LIB_VERSION };
  };

  /** 登录后所有事件自动携带 identities.user_key（§3 规则 3）。 */
  ClkLog.prototype._withIdentity = function (event) {
    if (this.loginId !== null && event.identities === undefined) {
      event.identities = { user_key: this.loginId };
    }
    return event;
  };

  ClkLog.prototype._enqueue = function (event) {
    this.queue.push(event);
    var max = this.options.maxQueueLength;
    if (this.queue.length > max) this.queue.splice(0, this.queue.length - max);
    this._persistQueue();
  };

  /** 行为事件（track）。 */
  ClkLog.prototype.track = function (event, properties, options) {
    var self = this;
    var opts = options || {};
    return Promise.resolve(this._ready).then(function () {
      var e = {
        type: 'track',
        event: event,
        distinct_id: opts.distinctId || self._ensureDistinctId(),
        time: now(),
        lib: self._libInfo(),
        properties: self._mergeProps(properties || {})
      };
      self._enqueue(self._withIdentity(e));
      self._emit('info', 'track ' + event, e);
      return self._autoFlush();
    });
  };

  /** 用户属性（覆盖写，user_set）。 */
  ClkLog.prototype.profileSet = function (properties, options) {
    var self = this;
    var opts = options || {};
    return Promise.resolve(this._ready).then(function () {
      var e = {
        type: 'user_set',
        distinct_id: opts.distinctId || self._ensureDistinctId(),
        time: now(),
        lib: self._libInfo(),
        properties: self._mergeProps(properties || {})
      };
      self._enqueue(self._withIdentity(e));
      self._emit('info', 'user_set', e);
      return self._autoFlush();
    });
  };

  /**
   * 登录关联（ClkLog 口径，§3）：distinct_id=登录ID、identities.user_key=登录ID、
   * properties.$track_signup_original_id=匿名ID；之后事件自动带 user_key，distinct_id 仍为匿名ID。
   */
  ClkLog.prototype.login = function (loginId, anonymousId) {
    var self = this;
    return Promise.resolve(this._ready).then(function () {
      var original = anonymousId || self._ensureDistinctId();
      self.loginId = loginId;
      self._enqueue({
        type: 'track_signup',
        event: '$SignUp',
        distinct_id: loginId,
        time: now(),
        identities: { user_key: loginId },
        lib: self._libInfo(),
        properties: { $track_signup_original_id: original }
      });
      self._emit('info', 'login 绑定 ' + loginId + ' ← ' + original);
      return self._autoFlush();
    });
  };

  /** 退出登录：停止携带 identities.user_key（§3 规则 4）。 */
  ClkLog.prototype.logout = function () {
    this.loginId = null;
    this._emit('info', 'logout');
    return Promise.resolve();
  };

  ClkLog.prototype._autoFlush = function () {
    if (this.queue.length >= this.batchSize) return this._flushQueue();
    return Promise.resolve(0);
  };

  ClkLog.prototype._buildBody = function (batch) {
    return ClkLog.formBody(batch, this.project, this.token);
  };

  /** 批次：≤50 事件且编码后 body ≤1MB（超出折半收缩）。 */
  ClkLog.prototype._takeBatch = function () {
    var batch = this.queue.slice(0, this.options.maxEventsPerRequest);
    while (batch.length > 1 && byteLength(this._buildBody(batch)) > this.options.maxBodyBytes) {
      batch = batch.slice(0, Math.ceil(batch.length / 2));
    }
    this.queue.splice(0, batch.length);
    return batch;
  };

  ClkLog.prototype.flush = function () {
    var self = this;
    return Promise.resolve(this._ready).then(function () { return self._flushQueue(); });
  };

  ClkLog.prototype._flushQueue = function () {
    if (this._inflight) return this._inflight;
    var self = this;
    this._inflight = (function loop() {
      if (self.queue.length === 0) { self._persistQueue(); return Promise.resolve(0); }
      var batch = self._takeBatch();
      return self._postWithRetry(self._buildBody(batch))
        .then(function () {
          self._persistQueue();
          self._emit('info', 'flushed ' + batch.length + ' events OK');
          return loop().then(function (n) { return n + batch.length; });
        })
        .catch(function (err) {
          self.queue = batch.concat(self.queue); // 失败回滚，保序不丢数据
          self._persistQueue();
          self._emit('error', 'flush 失败：' + err.message, { kept: batch.length });
          throw err;
        });
    })();
    var done = function () { self._inflight = null; };
    this._inflight.then(done, done);
    return this._inflight;
  };

  ClkLog.prototype._postWithRetry = function (body) {
    var self = this;
    var attempts = this.options.maxAttempts;
    var tryOnce = function (attempt) {
      return self._post(body).then(function (status) {
        if (status === 200) return null;
        throw new Error('http ' + status);
      }).catch(function (err) {
        if (attempt >= attempts) throw new Error('flush failed after ' + attempts + ' attempts: ' + err.message);
        self._emit('error', '第 ' + attempt + ' 次发送失败（' + err.message + '），退避重试');
        var wait = self.options.retryBaseMs * attempt + Math.floor(Math.random() * 100);
        return new Promise(function (resolve) { setTimeout(resolve, wait); }).then(function () { return tryOnce(attempt + 1); });
      });
    };
    return tryOnce(1);
  };

  /**
   * wx.request 发送表单。
   * 要点：body 必须是**已编码好的字符串**并显式声明 content-type；
   * 若把 base64 直接塞进对象 data 交给基础库序列化，各版本对 '+'/'=' 的转义行为不一致，容易丢数据。
   */
  ClkLog.prototype._post = function (body) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (typeof wx === 'undefined' || typeof wx.request !== 'function') {
        reject(new Error('wx.request 不可用'));
        return;
      }
      wx.request({
        url: self.endpoint,
        method: 'POST',
        header: { 'content-type': 'application/x-www-form-urlencoded' },
        data: body,                       // 预编码字符串，避免基础库二次序列化
        timeout: self.options.timeoutMs,  // 基础库 2.10.0+ 支持；老版本靠失败回调兜底
        success: function (res) { resolve(res && res.statusCode); },
        fail: function (err) { reject(new Error((err && (err.errMsg || err.errno)) || 'wx.request fail')); }
      });
    });
  };

  /** 小程序切后台没有 sendBeacon：用 wx.onAppHide 触发补发。 */
  ClkLog.prototype.bindAppHideFlush = function () {
    if (this._appHideBound || typeof wx === 'undefined' || typeof wx.onAppHide !== 'function') return this._appHideBound;
    var self = this;
    wx.onAppHide(function () {
      self.flush().catch(function (err) { self._emit('error', 'onAppHide flush 失败：' + err.message); });
    });
    this._appHideBound = true;
    return true;
  };

  ClkLog.prototype.queueLength = function () {
    return this.queue.length;
  };

  ClkLog.VERSION = LIB_VERSION;
  ClkLog.DEFAULTS = DEFAULTS;

  return ClkLog;
});
