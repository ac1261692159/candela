-- CreateTable
CREATE TABLE `MetaUserCohort` (
    `cohort_id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `owner` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `display_name` VARCHAR(191) NOT NULL,
    `remark` TEXT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `definition_json` TEXT NOT NULL,
    `schedule` VARCHAR(191) NOT NULL DEFAULT 'manual',
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `member_count` INTEGER NOT NULL DEFAULT 0,
    `batch_id` VARCHAR(191) NOT NULL DEFAULT '',
    `last_computed_at` DATETIME(3) NULL,
    `compute_error` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MetaUserCohort_project_name_name_key`(`project_name`, `name`),
    INDEX `MetaUserCohort_project_name_status_idx`(`project_name`, `status`),
    PRIMARY KEY (`cohort_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
