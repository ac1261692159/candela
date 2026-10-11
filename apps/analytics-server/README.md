# analytics-server

> NestJS + TypeScript 后端，负责：
> - ingestor：消费 CKafka，写入 ClickHouse
> - meta：埋点管理（元事件/属性/虚拟事件）
> - query：事件/漏斗/留存分析 DSL → SQL
> - report：看板/卡片/自定义 SQL
> - ai-assistant：受限 DeepSeek Harness 会话与只读分析工具

## 目录结构

```
src/
├── main.ts                    NestJS 应用入口
├── app.module.ts              根模块，聚合所有业务模块
├── config/                    配置加载（env → config 对象）
├── common/                    公共基础设施
│   ├── filters/               全局异常过滤
│   ├── interceptors/          项目注入、响应包装
│   ├── pipes/                 参数校验
│   ├── guards/                认证/权限
│   ├── decorators/            自定义装饰器
│   └── utils/                 通用工具
├── modules/                   业务模块
│   ├── shared/                ClickHouse / Redis / Kafka / Prisma 连接
│   ├── ingestor/              Kafka 消费 + 解析 + 写入
│   ├── meta/                  埋点管理
│   ├── query/                 分析查询引擎
│   ├── report/                报表看板
│   └── ai-assistant/          Harness 运行时、上下文脱敏、对话 API 与工具 profile
└── types/                     全局 TS 类型
```

## 分层说明

```
HTTP Request
    ↓
Controller  （接收请求、参数校验、返回响应）
    ↓
Service     （业务逻辑编排）
    ↓
Repository  （MySQL 数据访问）
    ↓
Shared Service / Client
    ↓
ClickHouse / Redis / Kafka / MySQL
```

## 启动模式

- `npm run start:dev`：启动 HTTP API 服务（开发）
- `npm run start:ingestor`：启动独立 ingestor 进程
- 生产环境可在同一容器内跑两个进程，或拆成两个容器。

## 阶段1（P0 数据补齐）启动步骤

1. 确保已建立 SSH 端口转发（见 `config_dev.yaml` 顶部注释）。
2. 初始化 MySQL：`npx prisma migrate dev --name init`
3. 初始化 ClickHouse：`npm run db:init`
4. 启动后端 API：`../../run_dev.sh server`
5. 启动 ingestor：`ENABLE_INGESTOR=true npx ts-node src/scripts/run-ingestor.ts`
6. 验证：`curl http://localhost:3100/sa/api/health`

## AI 数据分析助手

**模型供应商与密钥不在配置文件、也不在环境变量里**：启动后在平台「设置 → AI Workspace
管理 → 模型供应商」添加供应商（接口地址、协议、密钥、模型清单，含「支持图片输入」开关），
密钥以 AES-256-GCM 密文入库、只回显末 4 位。没有配置任何供应商时，用户开助手会得到
「尚未配置模型供应商」的明确提示，而不是一个没有模型的会话。

`deepseek_harness.enabled=false` 时服务照常启动，只有 AI 接口返回 503；供应商与容量预设
的边界见 `docs/architecture/clklog-ai-analytics-design-model-providers-v1.md`。

每个用户、项目和登录 token 使用隔离的 Harness 运行时。内置 Shell、文件、Web、
子 Agent 和任意 SQL 工具均关闭，并由插件白名单再次拦截；真实供应商密钥只由服务端
模型出口网关持有，不下发浏览器、不进容器、不进 dsh-home。默认单轮超时 50 秒，以适配
当前 nginx 的 60 秒读取超时。
