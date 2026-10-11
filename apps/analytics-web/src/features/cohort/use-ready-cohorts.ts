import { useEffect, useState } from 'react';
import { getCohorts, type UserCohort } from '../../services/cohort.service';
import { useProjectStore } from '../../stores/project.store';
import { useIamStore } from '../../stores/iam.store';

/**
 * 已就绪分群（分析页 / 看板筛选 / 指标定义共用）。
 *
 * rbac-v5：无 `cohort.view` 的角色（普通成员看自己的看板时会渲染筛选区）不再发请求——
 * 该接口守卫是 `cohort.view`，此前会稳定报 403（用户可见的是控制台一片红）。
 */
export function useReadyCohorts(subjectId?: string): UserCohort[] {
  const project = useProjectStore((state) => state.currentProject);
  const canViewCohorts = useIamStore((state) => state.has('cohort.view'));
  const [cohorts, setCohorts] = useState<UserCohort[]>([]);

  useEffect(() => {
    if (!canViewCohorts) {
      setCohorts([]);
      return;
    }
    let cancelled = false;
    getCohorts({ status: 'ready', subject_id: subjectId })
      .then((res) => {
        if (!cancelled) setCohorts(res.items);
      })
      .catch(() => {
        if (!cancelled) setCohorts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project, subjectId, canViewCohorts]);

  return cohorts;
}
