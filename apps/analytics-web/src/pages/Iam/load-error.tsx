import { Alert, Button } from 'antd';
import { useT } from '../../i18n';

/**
 * IAM 页取数失败提示（2026-09-18 验收实测）：列表接口瞬时失败（发版重启 / 网络抖动）时
 * 若不提示，页面会渲染成「暂无数据」，使用者会误判成「没有权限」。
 */
export function IamLoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useT('iam');
  return (
    <Alert
      type="error"
      showIcon
      style={{ marginBottom: 12 }}
      message={t('iam:error.loadFailed')}
      action={
        <Button size="small" onClick={onRetry}>
          {t('common:action.retry')}
        </Button>
      }
    />
  );
}
