/*!
 * ClkLog Web / H5 上报 SDK（UMD，零依赖）
 * =============================================================================
 * 用法（浏览器 <script> 直接引入，无需打包器）：
 *   <script src="./clklog.js"></script>
 *   <script>
 *     var clk = ClkLog.init({ token: '<项目token>', project: 'clklogapp' });
 *     clk.track('PageView', { $title: '首页' });
 *     clk.login('uid-1001');            // 上报 track_signup 并绑定当前匿名ID
 *     clk.profileSet({ vip_level: 3 });
 *     clk.flush();
 *   </script>
 *
 * 规范文档：仓库根目录《数据上报规范与流程.md》§1（协议 / 编码硬要求）、§2（事件 JSON）、§3（用户标识口径）。
 * 关键点（照做，勿简化）：
 *  1. POST 表单字段 data = JSON 数组 → base64 → urlencode（§1.2/§1.3）。
 *     直接 POST 原始 JSON 会 HTTP 200 但数据静默丢失。
 *  2. ClkLog 不解析神策顶层 login_id/original_id：登录ID 走 identities.user_key，
 *     登录绑定匿名ID 走 properties.$track_signup_original_id（§3，与神策原生口径不同）。
 *  3. `time` 必须是毫秒时间戳。
 *
 * 实测层级（诚实说明，勿夸大）：
 *  - 已实测：本文件在 Node 24 下以 `cd examples/report-sdk/js && node run-on-node.mjs` 跑通完整 5 步链
 *    并落 ClickHouse；同一份核心逻辑（URL 编码 / base64 / 分批 / 重试 / 队列）因此得到真实网络与
 *    真实 receiver 验证。index.html 的三按钮逻辑另经「最小 DOM 垫片」冒烟（非浏览器渲染）。
 *  - 已实测（HTTP 层）：receiver 的 CORS 预检对本机 http 源回显 Access-Control-Allow-Origin
 *    （见 run-on-node.mjs --cors-check），data 字段用的 content-type 属 CORS 安全列表，浏览器可直发。
 *  - 需真机/浏览器核对（本机无浏览器自动化环境）：`navigator.sendBeacon` 页面卸载兜底路径、
 *    localStorage 在隐私模式下的降级行为、以及 index.html 的真实浏览器渲染与点击。
 *    这三项在代码里都做了特性探测与降级，但**没有真实浏览器执行证据**。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(); // Node / 打包器
  } else {
    root.ClkLog = factory(); // 浏览器全局 ClkLog
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIB = 'js';            // lib.$lib
  var LIB_VERSION = '1.0.0'; // lib.$lib_version

  var DEFAULTS = {
    endpoint: 'https://example.com/receiver/api/gp',
    project: 'clklogapp',
    token: '',                 // 必填；禁止硬编码入库（AGENTS.md 红线 3）
    batchSize: 10,             // 攒批阈值，达到即自动 flush
    maxEventsPerRequest: 50,   // 规范 §10.3：单条 data ≤ 50 事件
    maxBodyBytes: 1048576,     // 规范 §10.3：body ≤ 1MB
    timeoutMs: 10000,          // 单次请求超时
    maxAttempts: 3,            // 失败重试次数（含首次）
    retryBaseMs: 500,          // 线性退避基数：attempt * retryBaseMs
    maxQueueLength: 500,       // 离线队列上限，超出丢最旧（防止 localStorage 写爆）
    storageKeyPrefix: 'clklog.',
    flushOnInit: true,         // 启动时补发上次未发出的队列（离线队列）
    debug: false
  };

  // ------------------------------------------------------------------ 基础工具

  /** UTF-8 字节序列（纯 JS 实现：浏览器 / Node / 小程序 / RN 都能用，不依赖 TextEncoder）。 */
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          i++;
        }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  /** base64 编码（纯 JS，不依赖 btoa / Buffer —— RN 的 Hermes 与部分小程序基础库没有 btoa）。 */
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

  /** application/x-www-form-urlencoded 的字段编码（手写而非 URLSearchParams：RN 的 toString 未实现）。 */
  function enc(value) {
    return encodeURIComponent(String(value));
  }

  /** 字符串的 UTF-8 字节长度（用于 1MB body 判定）。 */
  function byteLength(str) {
    return utf8Bytes(str).length;
  }

  function now() {
    return Date.now(); // 毫秒（秒级会导致时间错乱）
  }

  function safeParse(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  /** 默认存储：浏览器 localStorage；不可用时退化为内存实现（隐私模式 / SSR）。 */
  function defaultStorage() {
    try {
      var ls = typeof localStorage !== 'undefined' ? localStorage : null;
      if (ls) {
        ls.setItem('clklog.__probe', '1');
        ls.removeItem('clklog.__probe');
        return ls;
      }
    } catch (e) {
      /* localStorage 被禁用（Safari 隐私模式等），走内存兜底 */
    }
    var mem = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
      setItem: function (k, v) { mem[k] = String(v); },
      removeItem: function (k) { delete mem[k]; }
    };
  }

  // ------------------------------------------------------------------ SDK 主体

  /**
   * @param {object} options 见 DEFAULTS；额外支持：
   *   storage  自定义存储（需 getItem/setItem/removeItem；允许返回 Promise，便于 RN 注入 AsyncStorage）
   *   distinctId 指定初始匿名ID（缺省从 storage 读取或生成）
   *   onEvent  回调 ({level, message, data})，供演示页/调试观察发送结果
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
    this.storage = opts.storage || defaultStorage();
    this.storageKeyPrefix = opts.storageKeyPrefix;
    this.queue = [];
    this.loginId = null;
    this.distinctId = opts.distinctId || null;
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    this._inflight = null;
    this._unloadBound = null;
    this._ready = this._restore();
  }

  /** 单例入口：ClkLog.init({...}) 后再调 ClkLog.getDefault()。 */
  ClkLog.init = function (options) {
    if (!ClkLog.instance) ClkLog.instance = new ClkLog(options);
    return ClkLog.instance;
  };

  ClkLog.getDefault = function () {
    return ClkLog.instance || null;
  };

  ClkLog.base64 = base64; // 便于单测/自检

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
    // 兼容同步（localStorage）与异步（AsyncStorage）存储。
    return Promise.resolve()
      .then(function () { return this.storage.getItem(this._key(name)); }.bind(this))
      .then(function (v) { return v === undefined || v === '' ? null : v; })
      .catch(function () { return null; });
  };

  /** 启动恢复：匿名ID + 上次未发出的离线队列。 */
  ClkLog.prototype._restore = function () {
    var self = this;
    return self._read('distinct_id')
      .then(function (v) {
        if (!self.distinctId && typeof v === 'string') self.distinctId = v;
      })
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

  /** 行为事件（track）；登录后自动带 identities.user_key。 */
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
        properties: properties || {}
      };
      self._enqueue(self._withIdentity(e));
      self._emit('info', 'track ' + event, e);
      return self._autoFlush();
    });
  };

  /** 用户属性（覆盖写，user_set）；登录后自动带 identities.user_key。 */
  ClkLog.prototype.profileSet = function (properties, options) {
    var self = this;
    var opts = options || {};
    return Promise.resolve(this._ready).then(function () {
      var e = {
        type: 'user_set',
        distinct_id: opts.distinctId || self._ensureDistinctId(),
        time: now(),
        lib: self._libInfo(),
        properties: properties || {}
      };
      self._enqueue(self._withIdentity(e));
      self._emit('info', 'user_set', e);
      return self._autoFlush();
    });
  };

  /**
   * 登录关联（ClkLog 口径，§3）：
   *   distinct_id = 登录ID；identities.user_key = 登录ID；properties.$track_signup_original_id = 匿名ID。
   * 调用后所有事件自动携带 identities.user_key，distinct_id 仍保持匿名ID不变。
   */
  ClkLog.prototype.login = function (loginId, anonymousId) {
    var self = this;
    return Promise.resolve(this._ready).then(function () {
      var original = anonymousId || self._ensureDistinctId();
      self.loginId = loginId;
      var e = {
        type: 'track_signup',
        event: '$SignUp',
        distinct_id: loginId,
        time: now(),
        identities: { user_key: loginId },
        lib: self._libInfo(),
        properties: { $track_signup_original_id: original }
      };
      self._enqueue(e);
      self._emit('info', 'login 绑定 ' + loginId + ' ← ' + original);
      return self._autoFlush();
    });
  };

  /** 退出登录：停止携带 identities.user_key，不需要上报事件（§3 规则 4）。 */
  ClkLog.prototype.logout = function () {
    this.loginId = null;
    this._emit('info', 'logout');
    return Promise.resolve();
  };

  ClkLog.prototype._autoFlush = function () {
    if (this.queue.length >= this.batchSize) return this._flushQueue();
    return Promise.resolve(0);
  };

  /** 组一个待发批次：≤50 事件，且编码后 body ≤1MB（超出则折半收缩）。 */
  ClkLog.prototype._takeBatch = function () {
    var batch = this.queue.slice(0, this.options.maxEventsPerRequest);
    while (batch.length > 1 && byteLength(this._buildBody(batch)) > this.options.maxBodyBytes) {
      batch = batch.slice(0, Math.ceil(batch.length / 2));
    }
    this.queue.splice(0, batch.length);
    return batch;
  };

  /** 表单 body：project / token / data（data = base64(JSON 数组)），全字段 urlencode。 */
  ClkLog.prototype._buildBody = function (batch) {
    return ClkLog.formBody(batch, this.project, this.token);
  };

  /**
   * 纯函数版表单编码（发送路径与自检路径共用同一实现，便于离线核对「base64 → urlencode」是否真被执行）。
   * @param {object[]} events 事件数组
   * @param {string} project 项目名
   * @param {string} token 项目 token
   * @returns {string} application/x-www-form-urlencoded 的 body
   */
  ClkLog.formBody = function (events, project, token) {
    return 'project=' + enc(project) + '&token=' + enc(token) + '&data=' + enc(base64(JSON.stringify(events)));
  };

  /** 发送全部队列，返回实际发送条数；失败抛错（队列已回滚，不丢数据）。 */
  ClkLog.prototype.flush = function () {
    var self = this;
    return Promise.resolve(this._ready).then(function () { return self._flushQueue(); });
  };

  ClkLog.prototype._flushQueue = function () {
    if (this._inflight) return this._inflight; // 并发调用共用一次发送
    var self = this;
    this._inflight = (function loop() {
      if (self.queue.length === 0) {
        self._persistQueue();
        return Promise.resolve(0);
      }
      var batch = self._takeBatch();
      return self._postWithRetry(self._buildBody(batch))
        .then(function () {
          self._persistQueue();
          self._emit('info', 'flushed ' + batch.length + ' events OK');
          return loop().then(function (n) { return n + batch.length; });
        })
        .catch(function (err) {
          self.queue = batch.concat(self.queue); // 回滚该批次，保序不丢数据
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
    var delay = function (attempt) {
      return self.options.retryBaseMs * attempt + Math.floor(Math.random() * 100);
    };
    var tryOnce = function (attempt) {
      return self._post(body).then(function (status) {
        if (status === 200) return null;
        throw new Error('http ' + status);
      }).catch(function (err) {
        if (attempt >= attempts) throw new Error('flush failed after ' + attempts + ' attempts: ' + err.message);
        self._emit('error', '第 ' + attempt + ' 次发送失败（' + err.message + '），退避重试');
        return new Promise(function (resolve) { setTimeout(resolve, delay(attempt)); }).then(function () {
          return tryOnce(attempt + 1);
        });
      });
    };
    return tryOnce(1);
  };

  ClkLog.prototype._post = function (body) {
    var self = this;
    var timeoutMs = this.options.timeoutMs;
    return new Promise(function (resolve, reject) {
      var timer = null;
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      if (controller) timer = setTimeout(function () { controller.abort(); }, timeoutMs);
      var finish = function (fn, arg) {
        if (timer) clearTimeout(timer);
        fn(arg);
      };
      fetch(self.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*' },
        body: body,
        signal: controller ? controller.signal : undefined
      }).then(function (resp) {
        var status = resp.status;
        // 释放响应体，避免连接无法复用
        return Promise.resolve(typeof resp.text === 'function' ? resp.text() : null).then(function () {
          finish(resolve, status);
        });
      }, function (err) {
        finish(reject, err);
      });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') throw new Error('timeout after ' + timeoutMs + 'ms');
      throw err;
    });
  };

  /**
   * 页面卸载兜底：用 navigator.sendBeacon 抢发队列（等价于 flush，但无返回值可等待）。
   * 注意：sendBeacon 传**字符串**时浏览器会标成 text/plain，receiver 按表单解析会读不到 data；
   * 因此优先传 URLSearchParams（会带 application/x-www-form-urlencoded），退化时传 Blob 并显式指定 type。
   */
  ClkLog.prototype.flushBeacon = function () {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return false;
    if (this.queue.length === 0) return true;
    var batch = this.queue.slice(0, this.options.maxEventsPerRequest);
    var encoded = base64(JSON.stringify(batch));
    var body = this._formBody(encoded);
    var payload;
    try {
      payload = typeof URLSearchParams === 'function' ? new URLSearchParams(this._formPairs(encoded)) : null;
    } catch (e) {
      payload = null;
    }
    if (!payload) {
      try {
        payload = new Blob([body], { type: 'application/x-www-form-urlencoded' });
      } catch (e2) {
        return false;
      }
    }
    var ok = false;
    try {
      ok = navigator.sendBeacon(this.endpoint, payload) === true;
    } catch (e3) {
      ok = false;
    }
    if (ok) {
      this.queue.splice(0, batch.length);
      this._persistQueue();
      this._emit('info', 'sendBeacon 发出 ' + batch.length + ' 条');
    } else {
      this._persistQueue(); // 队列留在本地，下次启动 flushOnInit 补发
      this._emit('error', 'sendBeacon 失败，已保留队列待下次补发');
    }
    return ok;
  };

  ClkLog.prototype._formPairs = function (encoded) {
    var pairs = [];
    pairs.push(['project', this.project]);
    pairs.push(['token', this.token]);
    pairs.push(['data', encoded]);
    return pairs;
  };

  ClkLog.prototype._formBody = function (encoded) {
    var pairs = this._formPairs(encoded);
    var out = [];
    for (var i = 0; i < pairs.length; i++) out.push(enc(pairs[i][0]) + '=' + enc(pairs[i][1]));
    return out.join('&');
  };

  /** 绑定页面卸载钩子（pagehide / visibilitychange），返回解绑函数。 */
  ClkLog.prototype.bindPageUnload = function () {
    if (this._unloadBound || typeof document === 'undefined') return this._unloadBound;
    var self = this;
    var onHide = function () {
      if (typeof document.visibilityState === 'string' && document.visibilityState !== 'hidden') return;
      self.flushBeacon();
    };
    var onPageHide = function () { self.flushBeacon(); };
    var doc = document;
    doc.addEventListener('visibilitychange', onHide);
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('pagehide', onPageHide);
    this._unloadBound = function () {
      doc.removeEventListener('visibilitychange', onHide);
      if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('pagehide', onPageHide);
      self._unloadBound = null;
    };
    return this._unloadBound;
  };

  ClkLog.prototype.queueLength = function () {
    return this.queue.length;
  };

  ClkLog.VERSION = LIB_VERSION;
  ClkLog.DEFAULTS = DEFAULTS;

  return ClkLog;
});
