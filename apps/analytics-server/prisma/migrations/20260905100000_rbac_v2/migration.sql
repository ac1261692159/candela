-- RBAC v2: platform_role, project members, folders, asset lock/acl, data policies

ALTER TABLE `sauser` ADD COLUMN `platform_role` VARCHAR(191) NOT NULL DEFAULT 'none';

UPDATE `sauser` SET `platform_role` = IF(`role` = 'admin', 'super_admin', 'none');

ALTER TABLE `sauser` DROP COLUMN `role`;

CREATE TABLE `SaProjectMember` (
    `id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `role_key` VARCHAR(191) NOT NULL,
    `data_policy_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SaProjectMember_project_name_user_id_key`(`project_name`, `user_id`),
    INDEX `SaProjectMember_project_name_role_key_idx`(`project_name`, `role_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SaMemberGroup` (
    `id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `role_key` VARCHAR(191) NOT NULL,
    `data_policy_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SaMemberGroup_project_name_name_key`(`project_name`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SaMemberGroupUser` (
    `group_id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`group_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SaRoleGrant` (
    `id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `role_key` VARCHAR(191) NOT NULL,
    `grants_json` TEXT NOT NULL,
    `updated_by` VARCHAR(191) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SaRoleGrant_project_name_role_key_key`(`project_name`, `role_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SaDataPolicy` (
    `id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `definition_json` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SaDataPolicy_project_name_name_key`(`project_name`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SaAssetAcl` (
    `id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(64) NOT NULL,
    `asset_type` VARCHAR(32) NOT NULL,
    `asset_id` VARCHAR(64) NOT NULL,
    `subject_type` VARCHAR(16) NOT NULL,
    `subject_id` VARCHAR(64) NOT NULL,
    `perm` VARCHAR(16) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `SaAssetAcl_asset_type_asset_id_subject_type_subject_id_perm_key`(`asset_type`, `asset_id`, `subject_type`, `subject_id`, `perm`),
    INDEX `SaAssetAcl_project_name_asset_type_asset_id_idx`(`project_name`, `asset_type`, `asset_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SaDashboardFolder` (
    `folder_id` VARCHAR(191) NOT NULL,
    `project_name` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `parent_id` VARCHAR(191) NOT NULL DEFAULT '',
    `locked` BOOLEAN NOT NULL DEFAULT false,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `SaDashboardFolder_project_name_parent_id_idx`(`project_name`, `parent_id`),
    UNIQUE INDEX `SaDashboardFolder_project_name_parent_id_name_key`(`project_name`, `parent_id`, `name`),
    PRIMARY KEY (`folder_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Dashboard` ADD COLUMN `folder_id` VARCHAR(191) NULL;
ALTER TABLE `Dashboard` ADD COLUMN `locked` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `Dashboard` ADD COLUMN `visibility` VARCHAR(191) NOT NULL DEFAULT 'project';
CREATE INDEX `Dashboard_folder_id_idx` ON `Dashboard`(`folder_id`);

ALTER TABLE `Card` ADD COLUMN `locked` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `MetaUserCohort` ADD COLUMN `locked` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `MetaUserTag` ADD COLUMN `locked` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `SaProjectMember` ADD CONSTRAINT `SaProjectMember_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `sauser`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `SaProjectMember` ADD CONSTRAINT `SaProjectMember_data_policy_id_fkey` FOREIGN KEY (`data_policy_id`) REFERENCES `SaDataPolicy`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `SaMemberGroup` ADD CONSTRAINT `SaMemberGroup_data_policy_id_fkey` FOREIGN KEY (`data_policy_id`) REFERENCES `SaDataPolicy`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `SaMemberGroupUser` ADD CONSTRAINT `SaMemberGroupUser_group_id_fkey` FOREIGN KEY (`group_id`) REFERENCES `SaMemberGroup`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `SaMemberGroupUser` ADD CONSTRAINT `SaMemberGroupUser_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `sauser`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Dashboard` ADD CONSTRAINT `Dashboard_folder_id_fkey` FOREIGN KEY (`folder_id`) REFERENCES `SaDashboardFolder`(`folder_id`) ON DELETE SET NULL ON UPDATE CASCADE;
