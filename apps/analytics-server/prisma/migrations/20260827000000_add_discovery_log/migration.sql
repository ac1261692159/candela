-- CreateTable: meta_discovery_log (元数据自动发现审计日志)
-- 记录：新增事件 / 新增属性 / 属性类型变更，用于在数据质量页展示变化。

CREATE TABLE `metadiscoverylog` (
    `id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `event_key` VARCHAR(191) NOT NULL,
    `prop_key` VARCHAR(191) NULL,
    `change_type` VARCHAR(191) NOT NULL,
    `from_value` VARCHAR(191) NULL,
    `to_value` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `MetaDiscoveryLog_project_name_created_at_idx` ON `metadiscoverylog`(`project_name`, `created_at`);

-- CreateIndex
CREATE INDEX `MetaDiscoveryLog_project_name_event_key_idx` ON `metadiscoverylog`(`project_name`, `event_key`);
