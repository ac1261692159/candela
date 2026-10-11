# 实现方案：埋点管理详情编辑 v1

> phase: clklog-analytics-meta-detail-v1
> 上游：`docs/product/prd-clklog-analytics-meta-detail-v1.md`
> API 仍用现有 `PUT /meta/event-attributes/:propKey`、`PUT /meta/user-properties/:id`、`PUT|DELETE /meta/virtual-events/:id`

---

## 1. 阶段目标与范围

与 PRD 相同。只改前端交互与文案；不新增接口。

## 2. 验收标准

与 PRD §2 MD-1~MD-8 对应。单测至少覆盖：

- 虚拟事件编辑器：无 `onDelete` 时不渲染删除按钮；有 `onDelete` 时渲染。
- 事件属性详情：关闭抽屉不调用更新接口（组件测试或等价：保存函数仅绑定「保存」）。

## 3. 非目标

与 PRD §3 相同。

## 4. 前端

| 文件 | 改动 |
|------|------|
| `pages/Meta/EventAttributesPage.tsx` | 去掉行内备注编辑与「编辑」；详情 Form 受控，`footer` 保存；`destroyOnClose` |
| `pages/Meta/UserPropertiesPage.tsx` | 自建列表 + 详情抽屉；显示名保存走 `updateUserProperty`；物化 Tooltip；用户物化走 `/meta/user-properties/:id/materialize` |
| `pages/Meta/VirtualEventsPage.tsx` | 列表仅「详情」；删除在详情；`getEvents({ pageSize: 500, exclude_hidden: true })` |
| `features/meta/VirtualEventEditor.tsx` | 可选 `onDelete`；提交带上 `ve_id` |
| `features/meta/PropertyList.tsx` | 「已物化」列问号说明（事件详情 Tab 仍用本组件） |
| `services/meta.service.ts` | `materializeUserProperty` |

详情 Form 禁止 `onBlur`/`onChange` 直接 `PUT`。虚拟事件删除：`Modal.confirm` 后再 `deleteVirtualEvent`。

## 5. 物化口径（与产品文案一致）

`materialize*Property` 仍只返回 DDL（`columnName` + `ddl`），不执行 `ALTER TABLE`，不改社区版表。前端成功态按现有接口返回展示，文案不承诺「已改表」。
