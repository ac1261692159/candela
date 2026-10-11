-- CreateTable
CREATE TABLE `MetaSavedMetric` (
    `metric_id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `owner` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `display_name` VARCHAR(191) NOT NULL,
    `remark` TEXT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `definition_json` TEXT NOT NULL,
    `format` VARCHAR(191) NOT NULL DEFAULT 'number',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MetaSavedMetric_project_name_name_key`(`project_name`, `name`),
    INDEX `MetaSavedMetric_project_name_kind_idx`(`project_name`, `kind`),
    PRIMARY KEY (`metric_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
