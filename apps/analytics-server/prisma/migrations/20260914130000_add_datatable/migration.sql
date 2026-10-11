-- 数据表（维度表）v1 元数据：表 / 字段 / 关联属性 / 导入审计
-- 见 docs/architecture/clklog-analytics-design-datatable-v1.md §5.3

CREATE TABLE `datatable` (
    `id`             VARCHAR(191) NOT NULL,
    `project_name`   VARCHAR(191) NOT NULL,
    `table_key`      VARCHAR(191) NOT NULL,
    `remark`         VARCHAR(191) NULL,
    `row_count`      INTEGER NOT NULL DEFAULT 0,
    `column_count`   INTEGER NOT NULL DEFAULT 0,
    `version_seq`    INTEGER NOT NULL DEFAULT 0,
    `active_version` INTEGER NOT NULL DEFAULT 0,
    `status`         VARCHAR(191) NOT NULL DEFAULT 'active',
    `created_by`     VARCHAR(191) NOT NULL,
    `updated_by`     VARCHAR(191) NOT NULL,
    `created_at`     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at`     DATETIME(3) NOT NULL,
    UNIQUE INDEX `datatable_project_name_table_key_key` (`project_name`, `table_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `datatablecolumn` (
    `id`           VARCHAR(191) NOT NULL,
    `datatable_id` VARCHAR(191) NOT NULL,
    `field_key`    VARCHAR(191) NOT NULL,
    `data_type`    VARCHAR(191) NOT NULL,
    `display_name` VARCHAR(191) NULL,
    `is_primary`   BOOLEAN NOT NULL DEFAULT false,
    `sort_order`   INTEGER NOT NULL,
    UNIQUE INDEX `datatablecolumn_datatable_id_field_key_key` (`datatable_id`, `field_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `datatablebinding` (
    `id`           VARCHAR(191) NOT NULL,
    `datatable_id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `target_type`  VARCHAR(191) NOT NULL,
    `target_prop`  VARCHAR(191) NOT NULL,
    `granularity`  VARCHAR(191) NULL,
    `status`       VARCHAR(191) NOT NULL DEFAULT 'active',
    `created_by`   VARCHAR(191) NOT NULL,
    `created_at`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `datatablebinding_datatable_id_target_type_target_prop_key` (`datatable_id`, `target_type`, `target_prop`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `datatableimport` (
    `id`           VARCHAR(191) NOT NULL,
    `datatable_id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `mode`         VARCHAR(191) NOT NULL,
    `from_version` INTEGER NULL,
    `to_version`   INTEGER NULL,
    `total_rows`   INTEGER NOT NULL,
    `success_rows` INTEGER NOT NULL,
    `dropped_rows` INTEGER NOT NULL,
    `dropped_json` TEXT NULL,
    `result`       VARCHAR(191) NOT NULL,
    `error`        TEXT NULL,
    `operator`     VARCHAR(191) NOT NULL,
    `created_at`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `datatableimport_datatable_id_created_at_idx` (`datatable_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
