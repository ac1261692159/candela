# analytics-web

> React + TypeScript + Ant Design + ECharts 前端。

## 目录结构

```
src/
├── main.tsx                   应用入口
├── App.tsx                    根组件
├── routes.tsx                 路由配置
├── layouts/                   布局组件
│   └── MainLayout.tsx         顶部导航 + 左侧菜单
├── components/                跨业务公共组件
│   ├── ProjectSelector.tsx    项目选择器
│   ├── TimeRangePicker.tsx    时间范围选择器
│   ├── FilterEditor.tsx       筛选条件编辑器
│   ├── GroupEditor.tsx        分组选择器
│   ├── MetricEditor.tsx       指标编辑器
│   ├── ChartRenderer.tsx      ECharts 图表渲染
│   ├── DataTable.tsx          通用表格
│   └── SqlEditor.tsx          SQL 编辑器
├── features/                  业务功能模块
│   ├── meta/                  埋点管理
│   ├── query/                 事件/漏斗/留存分析
│   ├── report/                看板与卡片
│   └── debug/                 Debug 查询
├── pages/                     页面
│   ├── Meta/                  埋点管理页面
│   ├── Analysis/              分析页面
│   ├── Report/                报表页面
│   ├── Sql/                   自定义 SQL
│   └── Debug/                 Debug 页面
├── services/                  API 请求封装
├── stores/                    Zustand 全局状态
├── types/                     TS 类型
└── utils/                     工具函数
```

## 页面路由

```
/sa/
  /events                  元事件列表
  /events/:eventKey        事件详情（抽屉或独立页）
  /user-properties         用户属性
  /virtual-events          虚拟事件
  /debug                   Debug 实时查询
  /quality                 数据质量报告
  /analysis/event          事件分析
  /analysis/funnel         漏斗分析
  /analysis/retention      留存分析
  /dashboards              看板列表
  /dashboards/:id          看板详情/编辑
  /sql                     自定义 SQL
```

## 状态管理

- `projectStore`：当前项目、项目列表
- `analysisStore`：当前分析 DSL、分析结果缓存
- `dashboardStore`：当前看板、卡片布局
