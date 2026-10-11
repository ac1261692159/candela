import { Result, Button } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useT } from '../i18n';

export function ForbiddenPage() {
  const { t } = useT('auth');
  const navigate = useNavigate();
  return (
    <Result
      status="403"
      title={t('auth:gate.forbiddenTitle')}
      subTitle={t('auth:gate.forbiddenDesc')}
      extra={
        <Button type="primary" onClick={() => navigate('/report/dashboards', { replace: true })}>
          {t('auth:gate.forbiddenBack')}
        </Button>
      }
    />
  );
}
