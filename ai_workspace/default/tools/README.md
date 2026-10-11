# 管理员辅助工具

管理员可在初始化 Workspace 页面维护脚本，并将整个目录标记为递归只读。脚本不得包含密钥，也不能绕过 ClkLog 查询守卫。

| 任务 | 首选文件/工具 |
|---|---|
| 四类分析纵切、合成预期 | `analysis-playbook.md` |
| SQL 口径、埋点质量、新旧事件切换诊断 | `thinkingdata-sop.md` |
| 分析证据与核验状态 | `evidence-template.md` |
| 当前 DSL 能力 | `clklog_get_analysis_capabilities` |
| SQL 结果图表字段绑定 | `clklog_propose_sql_chart` |
| 当前事件及目标事件属性 | `clklog_get_schema`（keyword、page、event_key） |
| 已有分析资产 | `clklog_list_cards`、`clklog_get_card` |
| 项目历史候选资料（若已迁入） | `files/knowledge/thinkingdata/README.md` |

本目录从 thinkingdata 提炼工作方法，没有迁入其 API 客户端、账号、原始分析结果或固定巡检计划。历史资料只用于帮助检索，运行时 SSOT 始终是当前平台权限、字典与工具校验。
