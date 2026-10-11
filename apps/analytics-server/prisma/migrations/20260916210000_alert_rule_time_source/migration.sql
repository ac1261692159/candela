-- 告警规则的时间范围来源（phase: clklog-analytics-metric-v2）
-- metric = 跟随指标自带的查询时间；rule = 由本规则窗口指定（存量规则保持 rule，行为不变）
ALTER TABLE `alertrule` ADD COLUMN `time_source` VARCHAR(16) NOT NULL DEFAULT 'rule';
