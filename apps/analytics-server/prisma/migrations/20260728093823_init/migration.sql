-- CreateTable
CREATE TABLE `MetaEvent` (
    `event_key` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `display_name` VARCHAR(191) NULL,
    `description` TEXT NULL,
    `owner` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `is_preset` BOOLEAN NOT NULL DEFAULT false,
    `first_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `MetaEvent_project_name_status_idx`(`project_name`, `status`),
    UNIQUE INDEX `MetaEvent_event_key_project_name_key`(`event_key`, `project_name`),
    PRIMARY KEY (`event_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MetaEventProperty` (
    `id` VARCHAR(191) NOT NULL,
    `event_key` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `prop_key` VARCHAR(191) NOT NULL,
    `display_name` VARCHAR(191) NULL,
    `data_type` VARCHAR(191) NOT NULL DEFAULT 'String',
    `is_materialized` BOOLEAN NOT NULL DEFAULT false,
    `materialized_column` VARCHAR(191) NULL,
    `sample_value` TEXT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `MetaEventProperty_project_name_idx`(`project_name`),
    UNIQUE INDEX `MetaEventProperty_event_key_project_name_prop_key_key`(`event_key`, `project_name`, `prop_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MetaUserProperty` (
    `id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `prop_key` VARCHAR(191) NOT NULL,
    `display_name` VARCHAR(191) NULL,
    `data_type` VARCHAR(191) NOT NULL DEFAULT 'String',
    `is_materialized` BOOLEAN NOT NULL DEFAULT false,
    `materialized_column` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `MetaUserProperty_project_name_idx`(`project_name`),
    UNIQUE INDEX `MetaUserProperty_project_name_prop_key_key`(`project_name`, `prop_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MetaVirtualEvent` (
    `ve_id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `display_name` VARCHAR(191) NOT NULL,
    `definition_json` TEXT NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'visible',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `MetaVirtualEvent_project_name_idx`(`project_name`),
    PRIMARY KEY (`ve_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MetaPropertyDict` (
    `id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `prop_key` VARCHAR(191) NOT NULL,
    `dict_json` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MetaPropertyDict_project_name_prop_key_key`(`project_name`, `prop_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MetaFunnelTemplate` (
    `id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `definition_json` TEXT NOT NULL,
    `owner` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `MetaFunnelTemplate_project_name_idx`(`project_name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Dashboard` (
    `db_id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `layout_json` TEXT NULL,
    `owner` VARCHAR(191) NOT NULL,
    `share_token` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Dashboard_share_token_key`(`share_token`),
    INDEX `Dashboard_project_name_idx`(`project_name`),
    PRIMARY KEY (`db_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Card` (
    `card_id` VARCHAR(191) NOT NULL,
    `db_id` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `dsl_json` TEXT NOT NULL,
    `chart_type` VARCHAR(191) NOT NULL DEFAULT 'line',
    `refresh_policy` VARCHAR(191) NOT NULL DEFAULT 'auto',
    `position_x` INTEGER NOT NULL DEFAULT 0,
    `position_y` INTEGER NOT NULL DEFAULT 0,
    `width` INTEGER NOT NULL DEFAULT 6,
    `height` INTEGER NOT NULL DEFAULT 4,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `Card_db_id_idx`(`db_id`),
    PRIMARY KEY (`card_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SqlReport` (
    `id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `sql_text` TEXT NOT NULL,
    `field_map_json` TEXT NOT NULL,
    `owner` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `SqlReport_project_name_idx`(`project_name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `MetaEventProperty` ADD CONSTRAINT `MetaEventProperty_event_key_project_name_fkey` FOREIGN KEY (`event_key`, `project_name`) REFERENCES `MetaEvent`(`event_key`, `project_name`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Card` ADD CONSTRAINT `Card_db_id_fkey` FOREIGN KEY (`db_id`) REFERENCES `Dashboard`(`db_id`) ON DELETE CASCADE ON UPDATE CASCADE;
