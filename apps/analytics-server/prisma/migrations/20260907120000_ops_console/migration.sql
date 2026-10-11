-- 运维面板（phase: clklog-analytics-ops-console-v1）
-- 纯新增表，不触碰任何现有表（红线 6：DDL 先演练；新增表无破坏性）

-- 主机指标采样（切片 3：磁盘使用量趋势预估的数据源）
CREATE TABLE `hostmetricsample` (
    `id`         BIGINT       NOT NULL AUTO_INCREMENT,
    `metric_key` VARCHAR(191) NOT NULL,
    `value`      DOUBLE       NOT NULL,
    `sampled_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    INDEX `hostmetricsample_metric_key_sampled_at_idx` (`metric_key`, `sampled_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 告警规则（内置 6 条；可启停与调阈值，不可增删——PRD 决策 D6）
CREATE TABLE `alertrule` (
    `id`         BIGINT       NOT NULL AUTO_INCREMENT,
    `code`       VARCHAR(191) NOT NULL,
    `name`       VARCHAR(191) NOT NULL,
    `threshold`  DOUBLE       NOT NULL,
    `enabled`    BOOLEAN      NOT NULL DEFAULT true,
    `updated_at` DATETIME(3)  NOT NULL,
    UNIQUE INDEX `alertrule_code_key` (`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 告警事件
CREATE TABLE `alertevent` (
    `id`           BIGINT       NOT NULL AUTO_INCREMENT,
    `rule_code`    VARCHAR(191) NOT NULL,
    `value`        DOUBLE       NOT NULL,
    `status`       VARCHAR(191) NOT NULL DEFAULT 'firing',
    `fired_at`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_seen_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolved_at`  DATETIME(3)  NULL,
    INDEX `alertevent_rule_code_status_idx` (`rule_code`, `status`),
    INDEX `alertevent_fired_at_idx` (`fired_at`),
    PRIMARY KEY (`id`),
    CONSTRAINT `alertevent_rule_code_fkey` FOREIGN KEY (`rule_code`) REFERENCES `alertrule` (`code`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 内置 6 条告警规则（INSERT IGNORE 幂等；阈值语义见 alert-detector.service.ts）
-- 依据：慢查询阈值参考 2026-09-07 事故实测（每分钟 2~8 次 Timeout）
INSERT IGNORE INTO `alertrule` (`code`, `name`, `threshold`, `enabled`, `updated_at`)
VALUES ('slow_query_spike', '慢查询次数突增', 20, 1, NOW(3)),
       ('query_fail_rate', '查询失败率过高', 50, 1, NOW(3)),
       ('card_cache_fail', '卡片缓存刷新连续失败', 3, 1, NOW(3)),
       ('clickhouse_down', 'ClickHouse 不可达', 2, 1, NOW(3)),
       ('disk_space_low', '磁盘可用空间不足', 10, 1, NOW(3)),
       ('data_link_stale', '数据链路停滞', 30, 1, NOW(3));
