import { useEffect, useState } from 'react';
import { getTags, type UserTag } from '../../services/tag.service';
import { useProjectStore } from '../../stores/project.store';

export function useReadyTags(subjectId?: string): UserTag[] {
  const project = useProjectStore((state) => state.currentProject);
  const [tags, setTags] = useState<UserTag[]>([]);

  useEffect(() => {
    let cancelled = false;
    getTags({ status: 'ready', subject_id: subjectId })
      .then((res) => {
        if (!cancelled) setTags(res.items);
      })
      .catch(() => {
        if (!cancelled) setTags([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project, subjectId]);

  return tags;
}
