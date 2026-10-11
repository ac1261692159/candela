# apps/ — ClkLog 分析平台源码

> phase: clklog-analytics-v1
> 技术栈：前后端统一 TypeScript，后端 NestJS，前端 React。

## 目录

```
apps/
├── analytics-server/   NestJS + TypeScript 后端（ingestor + meta + query + report）
└── analytics-web/      React + TypeScript + Ant Design + ECharts 前端
```

## 后端架构

- **框架**：NestJS（模块化 + 依赖注入），DeepSeek Harness 通过隔离子进程提供 AI 分析
- **数据库**：MySQL（Prisma ORM）用于元数据/看板；ClickHouse 用于分析数据；Redis 用于缓存
- **消息队列**：KafkaJS 消费 CKafka `clklog` topic
- **分层**：
  - Controller：接收 HTTP 请求，参数校验，返回响应
  - Service：业务逻辑编排
  - Repository：MySQL 数据访问（Prisma Client）
  - Shared Service：ClickHouse / Redis / Kafka 连接封装
  - AI Assistant：上下文脱敏、Harness 会话隔离、只读分析工具白名单

## 前端架构

- **框架**：React 18 + TypeScript
- **UI 组件库**：Ant Design 5
- **图表**：ECharts（react-echarts）
- **状态管理**：Zustand
- **路由**：React Router 6
- **分层**：
  - pages/：页面级组件，组合 features
  - features/：业务功能模块（meta/query/report/debug）
  - components/：跨业务公共组件（时间选择器、筛选编辑器、图表等）
  - services/：API 请求封装
  - stores/：全局状态

## 开发约定

- 伪代码阶段：所有实现文件先以 `// TODO:` 注释描述原子任务，不填实现。
- 全部 TODO 准备完毕后，再按模块逐个实现代码。
- 后端所有 `/sa/api/**` 接口必须带 `project_name` 过滤（由 `ProjectInterceptor` 注入）。
- 前端所有 DSL 构建通过 `dsl-builder.ts` 统一生成，禁止页面直接拼接 DSL。
