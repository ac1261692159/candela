# 参与 Candela

Candela is an AGPL-3.0 analytics platform that runs beside ClkLog Community Edition.
Issues and pull requests are welcome. User-visible text must be added for every shipped locale.

## 开始之前

1. 阅读 [`README.md`](README.md) 的部署与本地开发章节。部署脚本不会猜目标机：必须设置 `HOST=user@your-server`。
2. 行为分析相关的改动，先有 [`docs/product/`](docs/product/) 与 [`docs/architecture/`](docs/architecture/) 里的阶段文档（含 phase id、范围、验收标准、非目标），再改 `apps/`。规则在 [`AGENTS.md`](AGENTS.md)。
3. 不要提交 `.env`、目标机上的 `candela.env` / `deploy.env`、生产地址或业务埋点表。

## 本地检查

需要 Node.js 24。

```bash
cd apps/analytics-server && npm ci && npx prisma generate && npm test -- --runInBand
cd apps/analytics-web && npm ci && npx vitest run
python3 scripts/i18n_check.py && python3 scripts/i18n_scan.py --check
python3 scripts/arch_ratchet.py
node scripts/license-check.mjs
```

公开仓库的 GitHub Actions（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）跑同一组门禁。它不启动 MySQL / ClickHouse；单测不依赖外部服务。

## 界面文案

用户能看见的文字走 i18n，不要在组件或错误信息里写死一种语言。新增键要补齐全部已上线语言。术语见 [`docs/architecture/i18n-glossary.md`](docs/architecture/i18n-glossary.md)。

## 许可

贡献按 [AGPL-3.0-only](LICENSE) 授权。仓库包含 ClkLog 社区版的配置副本，不能把项目改成宽松许可证。详见 [`NOTICE`](NOTICE)。

## 安全问题

不要开公开 issue 贴利用细节。见 [`SECURITY.md`](SECURITY.md)。
