-- 告警可运维性（phase: clklog-analytics-alerting-v3）
-- 新增第 7 条内置规则：磁盘预计用尽（预测线告警）
-- 观测值 = 由 disk_used:/data 采样线性外推得到的「距用尽天数」，比较符 lt，单位「天」
-- 语义与阈值来源见 docs/architecture/clklog-analytics-design-alerting-v3.md §6
INSERT IGNORE INTO `alertrule` (`code`, `name`, `threshold`, `enabled`, `updated_at`)
VALUES ('disk_forecast_full', '磁盘预计用尽', 30, 1, NOW(3));

-- 兜底：若行已存在（重放/手工建过），统一比较符、单位与级别
UPDATE `alertrule`
SET `comparator` = 'lt', `unit` = '天', `severity` = 'warning'
WHERE `code` = 'disk_forecast_full';
