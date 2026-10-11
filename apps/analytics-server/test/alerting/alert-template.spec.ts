/**
 * 告警通知模板引擎（phase: clklog-analytics-alerting-v4，PRD B-2/B-3/B-4/B-5）。
 *
 * 引擎是自研的 Go template 子集：只承诺 `{{.变量}}` / `{{if}}…{{else}}…{{end}}`
 * 与 eq/ne/or/and/not/gt/ge/lt/le/contains；超出子集的写法必须**报错**而不是静默渲染错。
 */
import {
  DEFAULT_TEMPLATES,
  type AlertChannel,
  type AlertKind,
  TEMPLATE_VARS,
  collapseForSms,
  defaultTemplate,
  renderForChannel,
  renderTemplate,
  sampleContext,
  sampleFor,
  validateTemplate,
} from '../../src/modules/alerting/alert-template';
import { serverT } from '../../src/i18n/messages';

const CTX = {
  rule_name: '今日上报量过低',
  level_fmt: '紧急',
  status: '触发',
  status_code: 'fire',
  value: '1,204',
  unit: '次',
  comparator_fmt: '大于',
  threshold: '1,000次',
  metric_name: '今日上报次数',
  window_fmt: '今天',
  project: 'clklogapp',
  time: '2026-09-15 21:03:11',
};

describe('模板引擎：变量与条件', () => {
  it('替换变量并保留普通文本', () => {
    expect(renderTemplate('【{{.level_fmt}}】{{.status}} {{.rule_name}}', CTX)).toBe('【紧急】触发 今日上报量过低');
  });

  it('未定义变量渲染为空串（不报错、不出 <no value>）', () => {
    expect(renderTemplate('值={{.not_defined}};', CTX)).toBe('值=;');
  });

  it('if/else 按条件渲染（腾讯云同形：or + eq + 字符串字面量）', () => {
    const tpl = '{{if or (eq .status_code "resolve") (eq .status_code "repeat")}}异常态{{else}}正常态{{end}}';
    expect(renderTemplate(tpl, CTX)).toBe('正常态');
    expect(renderTemplate(tpl, { ...CTX, status_code: 'resolve' })).toBe('异常态');
    expect(renderTemplate(tpl, { ...CTX, status_code: 'repeat' })).toBe('异常态');
  });

  it('支持嵌套 if、括号、not/and/gt 与数字比较', () => {
    const nested = '{{if eq .status_code "fire"}}{{if gt .value_raw 100}}大{{else}}小{{end}}{{end}}';
    expect(renderTemplate(nested, { ...CTX, value_raw: 500 })).toBe('大');
    expect(renderTemplate(nested, { ...CTX, value_raw: 5 })).toBe('小');
    expect(renderTemplate('{{if and (not (eq .status_code "resolve")) (contains .rule_name "上报")}}Y{{end}}', CTX)).toBe('Y');
  });

  it('空白裁剪 {{- -}} 生效（短信要紧凑）', () => {
    expect(renderTemplate('A\n{{- if eq .status "触发" -}}\n  B  {{- end -}}\nC', CTX)).toBe('ABC');
  });

  it('无 if 的纯文本原样输出', () => {
    expect(renderTemplate('【告警】{{.rule_name}}', CTX)).toBe('【告警】今日上报量过低');
  });
});

describe('模板引擎：语法错误必须报错（不能静默）', () => {
  it('未闭合 if → 报错', () => {
    expect(validateTemplate('{{if eq .status "触发"}}缺失 end')).toContain('未闭合');
  });

  it('多余的 end / else → 报错', () => {
    expect(validateTemplate('文本{{end}}')).toContain('{{end}}');
    expect(validateTemplate('文本{{else}}')).toContain('{{else}}');
  });

  it('不支持的动作（range/with/管道/赋值）→ 明确报错', () => {
    expect(validateTemplate('{{range .items}}x{{end}}')).toContain('不支持的动作');
    expect(validateTemplate('{{.rule_name | upper}}')).toContain('不支持');
    expect(validateTemplate('{{$x := 1}}')).toContain('不支持的动作');
  });

  it('空条件、未知函数、括号不配对 → 报错', () => {
    expect(validateTemplate('{{if}}x{{end}}')).toContain('缺少条件表达式');
    expect(validateTemplate('{{if unknown .a}}x{{end}}')).toContain('无法识别');
    expect(validateTemplate('{{if eq (.a "x"}}y{{end}}')).toContain('右括号');
    expect(validateTemplate('{{if eq .a}}y{{end}}')).toContain('至少需要 2 个参数');
  });

  it('空模板报错（避免把通知内容清空）', () => {
    expect(validateTemplate('')).toBe('模板内容不能为空');
    expect(validateTemplate('   ')).toBe('模板内容不能为空');
  });

  it('合法的模板校验返回 null', () => {
    expect(validateTemplate('{{if eq .status_code "resolve"}}✅{{else}}🚨{{end}}{{.rule_name}}')).toBeNull();
  });
});

describe('默认模板（预填充占位符）', () => {
  it('六个组合都存在且预填充了占位符', () => {
    for (const kind of ['fire', 'resolve'] as const) {
      for (const channel of ['chat', 'email', 'sms'] as const) {
        const tpl = defaultTemplate(kind, channel);
        expect(tpl.body).toContain('{{');
        expect(validateTemplate(tpl.body)).toBeNull();
        expect(validateTemplate(tpl.subject)).toBeNull();
      }
    }
  });

  it('默认模板渲染后不再残留未替换的花括号', () => {
    for (const kind of ['fire', 'resolve'] as const) {
      for (const channel of ['chat', 'email', 'sms'] as const) {
        const rendered = renderForChannel(kind, channel, defaultTemplate(kind, channel), sampleContext());
        expect(rendered.body).not.toContain('{{');
        expect(rendered.subject).not.toContain('{{');
        expect(rendered.body).toContain('今日上报量过低');
      }
    }
  });

  it('默认模板不得在 value/threshold 后再拼 unit（会渲染成「1,204次次」）', () => {
    for (const kind of ['fire', 'resolve'] as const) {
      for (const channel of ['chat', 'email', 'sms'] as const) {
        const tpl = defaultTemplate(kind, channel);
        // 结构断言：紧随 {{.value}} / {{.threshold}} 之后不能再出现 {{.unit}}
        expect(tpl.body).not.toMatch(/\{\{\s*\.(value|threshold)\s*\}\}\s*\{\{\s*\.unit\s*\}\}/);
        // 渲染断言：单位只出现一次
        const rendered = renderForChannel(kind, channel, tpl, sampleContext());
        expect(rendered.body).not.toContain('次次');
        expect(rendered.body).not.toContain('%%');
        if (channel !== 'sms') expect(rendered.body).toContain('1,204次');
      }
    }
  });

  it('触发与恢复各有一份默认模板，内容不同（用户反馈修正）', () => {
    for (const channel of ['chat', 'email', 'sms'] as const) {
      const fire = defaultTemplate('fire', channel);
      const resolve = defaultTemplate('resolve', channel);
      expect(fire.body).not.toEqual(resolve.body);
      expect(fire.subject).not.toEqual(resolve.subject);
      // 触发模板写「触发」态，恢复模板写「恢复」
      const fireText = renderForChannel('fire', channel, fire, sampleContext({ status: '触发', status_code: 'fire' })).body;
      const resolveText = renderForChannel('resolve', channel, resolve, sampleContext({ status: '恢复', status_code: 'resolve' })).body;
      expect(fireText).toContain('触发');
      expect(resolveText).toContain('恢复');
      // 触发模板里不再需要 if 分支（两份各管一态）
      expect(fire.body).not.toContain('{{if');
      expect(resolve.body).not.toContain('{{if');
    }
  });

  it('短信通道按 40 字符截断（与投递侧一致，预览即所见）', () => {
    const rendered = renderForChannel('fire', 'sms', defaultTemplate('fire', 'sms'), sampleContext());
    expect(rendered.body.length).toBeLessThanOrEqual(40);
    expect(collapseForSms('a\n\n  b   c')).toBe('a b c');
  });
});

describe('占位符清单', () => {
  it('每个变量都有名称/说明/示例，且都能被渲染', () => {
    expect(TEMPLATE_VARS.length).toBeGreaterThan(10);
    for (const item of TEMPLATE_VARS) {
      expect(item.name).toMatch(/^[a-z_]+$/);
      expect(item.label.length).toBeGreaterThan(0);
      expect(renderTemplate(`{{.${item.name}}}`, sampleContext())).toBe(item.sample);
    }
  });

  it('默认模板只使用清单内的变量（避免文档与实际不一致）', () => {
    const known = new Set(TEMPLATE_VARS.map((item) => item.name));
    const used = new Set<string>();
    for (const locale of Object.keys(DEFAULT_TEMPLATES)) {
      for (const kind of Object.keys(DEFAULT_TEMPLATES[locale]) as AlertKind[]) {
        for (const channel of Object.keys(DEFAULT_TEMPLATES[locale][kind]) as AlertChannel[]) {
          const content = defaultTemplate(kind, channel, locale);
          for (const match of `${content.subject}\n${content.body}`.matchAll(/\{\{\s*\.([a-z_]+)/g)) {
            used.add(match[1]);
          }
        }
      }
    }
    expect(used.size).toBeGreaterThan(5);
    for (const name of used) expect(known.has(name)).toBe(true);
  });

  it('每种语言都提供完整的 kind × channel 默认模板矩阵（i18n v1）', () => {
    const locales = Object.keys(DEFAULT_TEMPLATES);
    const reference = Object.entries(DEFAULT_TEMPLATES['zh-CN'])
      .map(([kind, channels]) => `${kind}:${Object.keys(channels).sort().join(',')}`)
      .sort();
    for (const locale of locales) {
      const matrix = Object.entries(DEFAULT_TEMPLATES[locale])
        .map(([kind, channels]) => `${kind}:${Object.keys(channels).sort().join(',')}`)
        .sort();
      expect({ locale, matrix }).toEqual({ locale, matrix: reference });
      for (const [kind, channels] of Object.entries(DEFAULT_TEMPLATES[locale])) {
        for (const channel of Object.keys(channels)) {
          const content = defaultTemplate(kind as AlertKind, channel as AlertChannel, locale);
          expect({ key: `${locale}/${kind}/${channel}`, ok: content.body.trim().length > 0 }).toEqual({
            key: `${locale}/${kind}/${channel}`,
            ok: true,
          });
        }
      }
    }
  });

  it('未知语言回退 zh-CN 默认模板，而不是抛错', () => {
    const fallback = defaultTemplate('fire', 'chat', 'ja-JP');
    expect(fallback.body).toBe(DEFAULT_TEMPLATES['zh-CN'].fire.chat.body);
    const english = defaultTemplate('fire', 'chat', 'en-US');
    expect(english.body).not.toBe(DEFAULT_TEMPLATES['zh-CN'].fire.chat.body);
    expect(english.body).toContain('[{{.level_fmt}}]');
  });
});

/**
 * 示例值本地化（i18n v1）：占位符 Tooltip 与预览用的示例值按**操作者语言**渲染，
 * 中文路径必须与迁移前逐字一致（`sample` 原值）。
 */
describe('示例值本地化（i18n v1）', () => {
  it('中文沿用原 sample（逐字不变）', () => {
    const zh = sampleContext();
    expect(zh.rule_name).toBe('今日上报量过低');
    expect(zh.value).toBe('1,204次');
    expect(zh.unit).toBe('次');
    expect(zh.metric_kind).toBe('事件指标');
    expect(zh.status).toBe('触发');
    expect(zh.level_fmt).toBe('紧急');
    expect(zh.comparator_fmt).toBe('大于');
    expect(zh.threshold).toBe('1,000次');
    expect(zh.window_fmt).toBe('今天');
    expect(zh.contact_name).toBe('运维群');
  });

  it('英文用服务端文案（单位/级别/状态/比较符/指标类型）', () => {
    const en = sampleContext({}, 'en-US');
    expect(en.rule_name).toBe('Low event volume today');
    expect(en.value).toBe('1,204 times');
    expect(en.unit).toBe('times');
    expect(en.threshold).toBe('1,000 times');
    expect(en.metric_kind).toBe('Event metric');
    expect(en.status).toBe('Triggered');
    expect(en.level_fmt).toBe('Critical');
    expect(en.comparator_fmt).toBe('greater than');
    expect(en.window_fmt).toBe('Today');
    expect(en.contact_name).toBe('Ops group');
  });

  it('未上线语言 / 缺 sample_key 回退中文原值（不吐键名）', () => {
    // ja-JP/ko-KR 自 2026-09-17 起已是上线语言（返回本地化示例）；未上线语言（如 fr-FR）才回退中文原值
    expect(sampleContext({}, 'ja-JP').value).toBe('1,204回');
    expect(sampleContext({}, 'ko-KR').value).toBe('1,204회');
    expect(sampleContext({}, 'xx-XX').value).toBe('1,204次');
    expect(sampleFor({ name: 'x', label: 'X', label_key: 'alerting:templateVar.project', sample: '原值' }, 'en-US'))
      .toBe('原值');
  });

  it('每条变量都有 sample_key；zh 文案与 sample 逐字一致，en 文案不含中文', () => {
    for (const item of TEMPLATE_VARS) {
      expect({ name: item.name, sample_key: item.sample_key }).toEqual({
        name: item.name,
        sample_key: expect.stringMatching(/^alert\.varSample\./),
      });
      // zh-CN 走的是 `sample` 原值；messages 里的 zh 文案也必须与之一致（防两份中文漂移）
      expect({ name: item.name, zhMessage: serverT('zh-CN', item.sample_key as string) }).toEqual({
        name: item.name,
        zhMessage: item.sample,
      });
      expect({ name: item.name, hasCjk: /[\u4e00-\u9fff]/.test(sampleFor(item, 'en-US')) }).toEqual({
        name: item.name,
        hasCjk: false,
      });
    }
  });

  it('英文示例 + 英文默认模板渲染后不含中文（通知不再是「中式英文」）', () => {
    for (const kind of ['fire', 'resolve'] as const) {
      for (const channel of ['chat', 'email', 'sms'] as const) {
        const rendered = renderForChannel(
          kind,
          channel,
          defaultTemplate(kind, channel, 'en-US'),
          sampleContext({}, 'en-US'),
        );
        expect({ kind, channel, body: rendered.body }).toEqual({
          kind,
          channel,
          body: expect.not.stringMatching(/[\u4e00-\u9fff]/),
        });
      }
    }
  });
});
