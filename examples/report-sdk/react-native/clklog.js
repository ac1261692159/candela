/*!
 * ClkLog React Native 上报 SDK（纯 JS，零运行时依赖，可直接 import 进 RN 工程）
 * =============================================================================
 * ⚠️ 打包验证范围（诚实说明，勿夸大）：
 *   本机没有 React Native 运行时/Android/iOS 工具链，**RN 原生壳未打包验证**。
 *   本文件是被验证的 **RN 可直接使用的传输/队列核心**：同一份文件在 Node 24 下由
 *   `node run-on-node.mjs` 注入内存 storage + 伪 AppState 跑通完整 5 步链并落 ClickHouse，
 *   传输路径与 RN 运行时一致（全局 fetch + 表单字符串 body + 手写 urlencode + 纯 JS base64）。
 *   需要在真机/模拟器补验的部分：Metro 打包与 AsyncStorage 原生模块、AppState 真实切后台时机、
 *   后台态网络策略、以及 iOS/Android 各自的 fetch 实现对超时/keep-alive 的表现。
 *
 * 为什么不用 URLSearchParams / btoa / Buffer（RN 专属坑）：
 *   - RN 的 URLSearchParams 是残缺 polyfill，`toString()` 直接抛 "not implemented"；
 *   - Hermes 没有 `btoa`，早期版本也没有 `TextEncoder`，更没有 Node 的 `Buffer`；
 *   - 所以本文件自带纯 JS 的 UTF-8 → base64，并用 `encodeURIComponent` 手写表单编码。
 *   若把未转义的 base64 直接塞进表单：'+' 会被服务端解码成空格、'=' 会被当成 key/value 分隔，
 *   data 直接损坏（HTTP 仍可能 200）。见 Claude 规范 §1.3。
 *
 * 用法：
 *   import ClkLog from './clklog.js';                    // 或 const ClkLog = require('./clklog.js')
 *   const clk = ClkLog.init({
 *     token: '<项目token>',                               // 从环境/配置注入，禁止硬编码入库
 *     project: 'clklogapp',
 *     storage: AsyncStorage,                             // 默认即用 AsyncStorage，可换成 MMKV 等
 *   });
 *   clk.bindAppStateFlush(AppState);                     // 切后台补发（RN 没有 sendBeacon）
 *   clk.track('PageView', { screen: 'Home' });
 *   clk.login('uid-1001');                               // track_signup 绑定当前匿名ID
 *   clk.profileSet({ vip_level: 3 });
 *
 * storage 契约：对象或类实例，提供 getItem(key) / setItem(key, value) / removeItem(key)，
 *   同步或返回 Promise 均可（AsyncStorage 是异步的，SDK 内部全部 await）。
 *
 * 规范文档：仓库根目录《数据上报规范与流程.md》§1（协议 / 编码硬要求）、§2、§3（用户标识口径）。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(); // RN / Node（Metro 与 Node 都走这里）
  } else {
    root.ClkLog = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var LIB = 'react-native';  // lib.$lib（Lang 口径：react-native）
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
    autoCollectSystemInfo: true,
    debug: false
  };

  // ------------------------------------------------------------------ 宿主能力（懒加载 + 可注入）

  /** 默认存储：AsyncStorage（需 `npm i @react-native-async-storage/async-storage`）。 */
  function resolveAsyncStorage() {
    try {
      // eslint-disable-next-line global-require
      var mod = require('@react-native-async-storage/async-storage');
      return mod && (mod.default || mod);
    } catch (e) {
      return null; // Node 自测 / 未安装该包：交给调用方注入 storage
    }
  }

  /** 内存存储兜底（未注入 storage 且 AsyncStorage 不可用时使用，并给出告警）。 */
  function memoryStorage() {
    var map = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
      setItem: function (k, v) { map[k] = String(v); },
      removeItem: function (k) { delete map[k]; }
    };
  }

  /** RN 设备信息（RN 工程里可解析到 react-native；Node 下失败则用注入值）。 */
  function resolveDeviceProps() {
    try {
      // eslint-disable-next-line global-require
      var RN = require('react-native');
      var props = {};
      if (RN.Platform && RN.Platform.OS) props.$os = String(RN.Platform.OS);
      if (RN.Platform && RN.Platform.Version) props.$os_version = String(RN.Platform.Version);
      if (RN.Dimensions && typeof RN.Dimensions.get === 'function') {
        var win = RN.Dimensions.get('window') || {};
        if (win.width) props.$screen_width = Number(win.width);
        if (win.height) props.$screen_height = Number(win.height);
      }
      if (RN.Platform && RN.Platform.constants && RN.Platform.constants.Model) props.$model = String(RN.Platform.constants.Model);
      if (RN.Platform && RN.Platform.constants && RN.Platform.constants.Brand) props.$brand = String(RN.Platform.constants.Brand);
      return props;
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------ 基础工具

  /** UTF-8 字节（纯 JS，不依赖 TextEncoder/Buffer）。 */
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

  /** base64（纯 JS：Hermes 没有 btoa，也没有 Buffer）。 */
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

  /** 表单字段编码（手写，避开 RN 残缺的 URLSearchParams.toString）。 */
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

  // ------------------------------------------------------------------ SDK 主体

  /**
   * @param {object} options 见 DEFAULTS；额外支持：
   *   storage            自定义存储（getItem/setItem/removeItem，可异步）；缺省用 AsyncStorage
   *   systemProperties   设备预置属性（如 { $os: Platform.OS }）；缺省尝试从 react-native 自动采集
   *   onEvent            回调 ({level, message, data})
   */
  function ClkLog(options) {
    if (!(this instanceof ClkLog)) return new ClkLog(options);
    var opts = {};
    var key;
    for (key in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) opts[key] = DEFAULTS[key];
    for (key in options) if (Object.prototype.hasOwnProperty.call(options, key)) opts[key] = options[key];

    if (!opts.token) {
      throw new Error('[clklog] init 缺少 token（从环境变量/配置注入，禁止硬编码入库）');
    }
    this.options = opts;
    this.endpoint = opts.endpoint;
    this.project = opts.project;
    this.token = opts.token;
    this.batchSize = opts.batchSize > 0 ? Math.min(opts.batchSize, opts.maxEventsPerRequest) : 1;
    this.storage = opts.storage || resolveAsyncStorage() || memoryStorage();
    this.storageKeyPrefix = opts.storageKeyPrefix;
    this.queue = [];
    this.loginId = null;
    this.distinctId = opts.distinctId || null;
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    this._systemProps = null;
    this._inflight = null;
    this._appStateBound = null;
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

  /** 纯函数表单编码（发送与自检共用，便于核对 base64 → urlencode 真生效）。 */
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

  ClkLog.prototype._collectSystemProps = function () {
    if (!this.options.autoCollectSystemInfo) return {};
    if (this._systemProps) return this._systemProps;
    var injected = this.options.systemProperties || {};
    var props = {};
    var k;
    for (k in injected) if (Object.prototype.hasOwnProperty.call(injected, k)) props[k] = injected[k];
    var auto = resolveDeviceProps();
    if (auto) for (k in auto) if (Object.prototype.hasOwnProperty.call(auto, k) && props[k] === undefined) props[k] = auto[k];
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
   * RN 全局 fetch 发送表单。
   * body 必须是**已编码的字符串**并显式声明 content-type：RN 里只传字符串 body 时
   * fetch 默认按 text/plain 发出，服务端 @RequestParam 解析不到 data（HTTP 仍 200）。
   */
  ClkLog.prototype._post = function (body) {
    var self = this;
    var timeoutMs = this.options.timeoutMs;
    return new Promise(function (resolve, reject) {
      var timer = null;
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var settled = false;
      var finish = function (fn, arg) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(arg);
      };
      if (controller) {
        timer = setTimeout(function () { controller.abort(); }, timeoutMs);
      } else {
        // 老版本 RN 没有 AbortController：用超时竞速兜底（请求可能仍在后台完成）
        timer = setTimeout(function () { finish(reject, new Error('timeout after ' + timeoutMs + 'ms')); }, timeoutMs);
      }
      fetch(self.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*' },
        body: body,
        signal: controller ? controller.signal : undefined
      }).then(function (resp) {
        var status = resp.status;
        return Promise.resolve(typeof resp.text === 'function' ? resp.text() : null).then(function () {
          finish(resolve, status);
        });
      }, function (err) {
        finish(reject, err && err.name === 'AbortError' ? new Error('timeout after ' + timeoutMs + 'ms') : err);
      });
    });
  };

  /**
   * 切后台补发（RN 没有 sendBeacon）：传入 AppState（默认从 react-native 解析）。
   * 可注入：bindAppStateFlush({ addEventListener: (event, cb) => subscription }) —— 便于测试。
   */
  ClkLog.prototype.bindAppStateFlush = function (appState) {
    if (this._appStateBound) return this._appStateBound;
    var state = appState || null;
    if (!state) {
      try {
        // eslint-disable-next-line global-require
        state = require('react-native').AppState;
      } catch (e) {
        state = null;
      }
    }
    if (!state || typeof state.addEventListener !== 'function') return null;
    var self = this;
    var subscription = state.addEventListener('change', function (next) {
      if (next !== 'background' && next !== 'inactive') return;
      self.flush().catch(function (err) { self._emit('error', 'AppState 补发失败：' + err.message); });
    });
    this._appStateBound = subscription || true;
    return this._appStateBound;
  };

  ClkLog.prototype.queueLength = function () {
    return this.queue.length;
  };

  ClkLog.VERSION = LIB_VERSION;
  ClkLog.DEFAULTS = DEFAULTS;
  ClkLog.memoryStorage = memoryStorage;

  return ClkLog;
});
