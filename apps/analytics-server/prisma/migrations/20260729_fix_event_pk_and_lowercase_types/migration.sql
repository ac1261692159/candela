-- Drop FK so we can drop the redundant unique index
ALTER TABLE `metaeventproperty` DROP FOREIGN KEY `MetaEventProperty_event_key_project_name_fkey`;

-- Drop redundant unique index on MetaEvent
DROP INDEX `MetaEvent_event_key_project_name_key` ON `metaevent`;

-- Change MetaEvent primary key to composite (event_key, project_name)
ALTER TABLE `metaevent` DROP PRIMARY KEY,
    ADD PRIMARY KEY (`event_key`, `project_name`);

-- Re-add FK referencing the new composite PK
ALTER TABLE `metaeventproperty`
    ADD CONSTRAINT `MetaEventProperty_event_key_project_name_fkey`
    FOREIGN KEY (`event_key`, `project_name`)
    REFERENCES `metaevent` (`event_key`, `project_name`)
    ON DELETE RESTRICT
    ON UPDATE CASCADE;

-- Lowercase data_type defaults
ALTER TABLE `metaeventproperty` MODIFY `data_type` VARCHAR(191) NOT NULL DEFAULT 'string';
ALTER TABLE `metaeventattribute` MODIFY `data_type` VARCHAR(191) NOT NULL DEFAULT 'string';

-- Migrate existing Pascal-case data_type values to lowercase
UPDATE `metaeventproperty` SET `data_type` = LOWER(`data_type`);
UPDATE `metaeventattribute` SET `data_type` = LOWER(`data_type`);
