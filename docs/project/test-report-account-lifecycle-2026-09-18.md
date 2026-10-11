# 测试报告：账号生命周期 v1 / v2(+v1.1) / v3（2026-09-18）

> 覆盖 phase：`clklog-analytics-account-lifecycle-v1`、`clklog-analytics-account-lifecycle-v2`（含增补 v1.1 网页 SMTP 配置）、`clklog-analytics-account-lifecycle-v3`。
> 提交链：`e8307b6`（v1）→ `2a09be1` + `3b0d72e`（v2 + CI 修复）→ `d53c068`（v2.1）→ `b4cd355`（v3）。
> 生产构建：pipeline 17343（v1）、17369（v2）、17378（v2.1）、17385（v3）。

---

## 1. 测试流程（四层门禁，逐层放行才进下一层）

```
① 静态门禁      arch_ratchet + i18n_check(键集×13×16) + i18n_scan --check + nest build + vite build
② 单元/组件测试  jest(后端, 全 mock) + vitest(前端)；后端另跑 env -i 空环境（复刻 CI 测试环境）
③ 全栈实测      本地 MySQL 迁移 + 起服务 + SMTP 调试接收端(aiosmtpd) + 浏览器（登录/页面/链路）
④ 生产验证      迁移落库记录 + 新列/新表可查 + 端点 401/404/201/409 签名 + supervisor 进程
```

任何一层红即停。`3b0d72e` 前 CI 红过一次（详见 §6 事件复盘①）。

## 2. 自动化测试基线（交付时执行）

| 层 | 命令 | 结果 |
|---|---|---|
| 结构棘轮 | `python3 scripts/arch_ratchet.py` | passed |
| i18n 键集 | `python3 scripts/i18n_check.py` | 13 语言 × 16 命名空间，3539 键，一致 |
| i18n 覆盖率棘轮 | `python3 scripts/i18n_scan.py --check` | 通过（基线 1350；上调原因见 §6②，已写入对应提交说明） |
| 后端构建 | `npm run build`（nest） | 通过 |
| 前端构建 | `npm run build`（vite） | 通过 |
| 后端单测 | `npx jest`（常规环境） | **753/753，100 套件** |
| 后端单测（CI 复刻） | `env -i PATH HOME npx jest` | **753/753**（修复后建立的双轨自检） |
| 前端组件测试 | `npm test -- --run`（vitest） | **448/448，98 套件** |

### 2.1 本专题新增单测锚点（与 PRD 验收条目映射）

| 文件 | 覆盖 |
|---|---|
| `auth/password-policy.spec.ts` | AL-2：长度/黑名单/含用户名/临时密码形态 |
| `auth/auth.service.spec.ts` | AL-3/4/5/6/7：锁定计数与 15 分钟窗、禁中拒登、重置一次性密码+吊销会话+强制改密、自我保护 409、资产阻塞删除、审计动作名 |
| `auth/auth-token.service.spec.ts` | AM-1/3/4：签发即作废旧令牌、单用、过期/用途隔离、60s 限流、并发双消费 |
| `iam/iam-invite.spec.ts` | AM-5/6/7：直连入会幂等 409、未注册签发 7 天、邮箱不匹配 403、注册落地入会、占位作废无效、角色禁放 |
| `auth/auth-mail.service.spec.ts` | AM-11/12/13：AES-GCM 密文可解、pass 保留、主密钥缺失 400、DB 优先 env 兜底、损坏密文降级、视图不落明文 |
| `iam/iam-expiry.spec.ts` | AL3-1/3/5/6：到期失效、未到期生效、owner 禁设、非法时间 400、会话吊销全分支 |

## 3. 全栈实测用例矩阵（手工执行，日期 2026-09-17/18）

| 用例（PRD 条目） | 方法 | 结果 | 证据 |
|---|---|---|---|
| 建号含 email + created_by 留痕（AL-1） | 浏览器创建 btest1 | 通过 | 列表行 `btest1 / 邮箱 / 创建人 admin` |
| 弱口令/短密码拦截（AL-2） | 表单提交 `12345678` | 通过 | toast「密码过于常见」，400 不带出表单 |
| 锁定 5 次→15 分钟（AL-3） | 单测锁定窗口断言 | 通过 | `auth.service.spec.ts` |
| 管理员重置=一次性临时密码+吊销会话+强制改密（AL-4/5） | 浏览器全流程：重置→临时密码登录→强制改密页→改后放行 | 通过 | 弹窗一次性展示、`must_change_password:false` 落 store |
| 禁用/启用、编辑、删除+资产阻塞（AL-6/7） | 单测 + 页面 | 通过、操作者自身按钮禁用 | 用户管理行图 |
| 审计全动作落账（AL-8） | 页面「账号审计」区 | 通过 | 登录/建号/重置/禁用/邀请/配置均有行，详情无明文 |
| 个人资料编辑、last_login_at（AL-9） | 页面保存显示名/邮箱 | 通过 | 个人设置「基本资料」卡 |
| 忘记密码邮件闭环（AM-1） | SMTP sink 收信→打开链接→设新密码→登录 | 通过 | sink 截获 **【ClkLog】重置密码** 邮件，token 30 分钟，登录成功 |
| 枚举安全（AM-2） | 不存在账号与存在账号返回逐字节相同 | 通过 | 两次响应均为 `{ok:true}` |
| 60s 限流（AM-3） | 连续两次提交 | 通过 | 第二次 429 `auth.mail.tooOften` |
| 建号设密邮件（AM-4） | 界面选「发送设密邮件」创建 | 通过 | 令牌表 72h 行 + toast「设密邮件已发送」 |
| 邮箱邀请未注册→注册落地入会（AM-5） | 成员页输邮箱→sink 收邀请→注册→`iam/me` 校验 | 通过 | `member:true, role_key:analyst`；链接复用 404 |
| 已注册直连+重复 409（AM-6） | API 连发 | 通过 | `{added:true}` → 409 `iam.invite.alreadyMember` |
| 已登录邮箱不匹配（AM-7） | admin 打开 binvite 链接 | 通过 | 提示账号不匹配 + 换账号出口 |
| 模板按收件人语言（AM-8） | 同一收件人 zh/en 各发一封 | 通过 | sink 截获中文/英文 Subject 各一 |
| 邀请审计（AM-9） | 审计区筛 auth_invite_* | 通过 | create/accept/revoke + `email_hash` |
| 未配 SMTP 降级（AM-10） | 无 AUTH_* 起服务 | 通过 | 建号弹窗自动隐「发送设密邮件」 |
| 网页保存 SMTP+测试邮件+不落明文（AM-11） | 用户管理「邮件通道」卡 | 通过 | 保存后 sink 收 `[ClkLog] Email channel test`；GET 仅 `has_password:true` |
| 库内优先/回落 env（AM-12） | 单测两分支 | 通过 | `auth-mail.service.spec.ts` |
| 主密钥缺失拒保存（AM-13） | 不带 ALERT_CONFIG_KEY 起服务，UI 保存 | 通过 | toast 明确提示并拒绝落库 |
| 成员到期失效（AL3-1） | PATCH 昨天→`iam/me` | 通过 | `member:false, role_key:null` |
| 续约恢复（AL3-2） | PATCH null→再测 | 通过 | `member:true, role_key:analyst` |
| owner 禁设（AL3-3） | PATCH owner 行 | 通过 | 403 `iam.member.ownerRoleForbidden` |
| 休眠标记（AL3-4） | 用户管理列 | 通过 | 90 天口径 Tag（页面图） |
| 本人会话管理（AL3-5） | Profile 设备卡 + 吊销当前 409 + 批量留当前 | 通过 | 页面图 + curl 409 |
| 管理员会话吊销保护（AL3-6） | 吊销自己当前会话 | 通过 | 409 `auth.session.revokeCurrent` |
| 有效期审计（AL3-7） | 审计区 auth_member_expiry | 通过 | 写期与清期两行落账 |

页面证据截图保留在会话工件目录：`~/.zcode/cli/artifacts/sess_332e3fd4-*/`（用户管理页、创建弹窗、强制改密页、成员页、登录设备卡、邮件通道卡）。

## 4. 生产部署验证记录

| pipeline | 迁移落库 | 端点签名 | 进程 |
|---|---|---|---|
| 17343（v1） | `_prisma_migrations` 含 v1 行 | unlock/audit 401 | 新构建重启 |
| 17369（v2） | v2 行；`sainvitation/saauthtoken` 可查（0 行） | forgot 201、invite-info 404、invitations 401 | 同上 |
| 17378（v2.1） | v1.1 行；`saauthmailconfig` 可查 | mail-config 401 | 同上 |
| 17385（v3） | v3 行；`saprojectmember.expires_at` 列在位 | sessions 401 | 同上 |

验证口径：未授权访问新端点应 401（守卫存在）而非 404（路由不存在）；迁移以 `_prisma_migrations` 表为准（升级脚本 migrate 输出历史上出现过「no pending」误读，一律以库记录为真相）。

## 5. 已知边界与遗留

1. **生产邮件通道尚未启用**：需注入 `ALERT_CONFIG_KEY`（若告警平台配置已用则已具备）+ 超管在「用户管理 → 邮件通道」网页填 SMTP；未配即 v1 降级，无报错。
2. 本地 dev 库 admin 密码被测试重置为 `ClK-test-2026`（上线后请自行改回）；dev 库实测账号 btest1/bmail1/binvite1 与临时 token 已清理。
3. 会话抽屉/UI 自动化在测试浏览器里存在点击怪癖（Playwright actionability），用 React props 直调绕过——属测试工具行为，非产品缺陷；页面由截图证据覆盖。
4. 会话行无设备指纹（UA/IP 识别列为 v3 非目标）。
5. i18n 文案作者为模型自译（13 门），术语表已对齐既有 `iam:role.*` 等口径，正式对外前建议对法/德/西/葡/越/泰/印尼抽查一轮语感。

## 6. 事件复盘

**① CI 测试失败（pipeline 红，2026-09-17）**：`auth-mail.service.ts` 顶层静态 `import { appConfig }`，configuration 模块加载即读环境变量，CI 测试进程无 `CLICKHOUSE_PASSWORD` 导致 5 套件连坐。本地因 shell profile 自带该变量被掩盖。修复：`3b0d72e` 改 `AUTH_MAIL_CONFIG` DI 注入（服务不再 import configuration），并用 `env -i` 空环境全量自检建立双轨。**教训写进 design v2 §1**：领域服务一律不直接 import configuration，配置只在装配层注入。

**② i18n 棘轮三次上调**（1318→1336→1343→1350）：均为新 domainError 按契约必须带中文兜底文案所致，无新增违规；每次均在提交说明中写明原因。

**③ 升级脚本「No pending migrations」误读**：migrate 输出曾在首个次次升级时造成「迁移未应用」错觉；现验证口径统一改为直接查 `_prisma_migrations` 表（§4）。
