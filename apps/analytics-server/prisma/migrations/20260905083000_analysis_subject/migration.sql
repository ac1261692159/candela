-- CreateTable
CREATE TABLE `MetaAnalysisSubject` (
    `subject_id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `display_name` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `source_json` TEXT NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_preset` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MetaAnalysisSubject_project_name_name_key`(`project_name`, `name`),
    INDEX `MetaAnalysisSubject_project_name_idx`(`project_name`),
    PRIMARY KEY (`subject_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `MetaUserCohort` ADD COLUMN `subject_id` VARCHAR(191) NOT NULL DEFAULT '';
CREATE INDEX `MetaUserCohort_project_name_subject_id_idx` ON `MetaUserCohort`(`project_name`, `subject_id`);

ALTER TABLE `MetaUserTag` ADD COLUMN `subject_id` VARCHAR(191) NOT NULL DEFAULT '';
CREATE INDEX `MetaUserTag_project_name_subject_id_idx` ON `MetaUserTag`(`project_name`, `subject_id`);
