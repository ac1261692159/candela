-- 模型供应商 v1.1（phase: clklog-ai-model-providers-v1）：
-- 删除环境变量密钥机制（api_key_env）。密钥唯一来源是网页设置的密文列 api_key_cipher，
-- 供应商清单也只来自本表（配置文件与环境变量不再是来源）。
ALTER TABLE `saaimodelprovider` DROP COLUMN `api_key_env`;
