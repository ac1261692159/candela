-- 时区系统 v2（phase: clklog-analytics-timezone-v2）：用户偏好 / 项目级 / 通知按收件人时区。
-- 三列皆可空（= 跟随上级，零变化兼容）；IANA 名在应用层校验，DB 层不约束。
ALTER TABLE `sauser` ADD COLUMN `timezone` VARCHAR(64) NULL;
ALTER TABLE `saproject` ADD COLUMN `timezone` VARCHAR(64) NULL;
ALTER TABLE `alertcontact` ADD COLUMN `timezone` VARCHAR(64) NULL;
