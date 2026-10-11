-- 账号生命周期 v3（phase: clklog-analytics-account-lifecycle-v3）
-- 项目成员有效期 + 邀请附带入会有效期
ALTER TABLE `saprojectmember`
    ADD COLUMN `expires_at` DATETIME(3) NULL;

ALTER TABLE `sainvitation`
    ADD COLUMN `member_expires_at` DATETIME(3) NULL;
