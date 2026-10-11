-- 分析空间登记（不建 ClickHouse 库，只记 project_name）

CREATE TABLE `SaProject` (
    `name` VARCHAR(64) NOT NULL,
    `display_name` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `SaProject` (`name`, `display_name`, `created_at`, `updated_at`)
VALUES
    ('clklogapp', 'clklogapp', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('default', 'default', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

INSERT IGNORE INTO `SaProject` (`name`, `display_name`, `created_at`, `updated_at`)
SELECT DISTINCT `project_name`, `project_name`, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `SaProjectMember`
WHERE `project_name` IS NOT NULL AND `project_name` <> '';
