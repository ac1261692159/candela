import { useEffect, useState } from 'react';
import { getSubjects, type AnalysisSubject } from '../../services/subject.service';
import { useProjectStore } from '../../stores/project.store';

export function useSubjects() {
  const project = useProjectStore((state) => state.currentProject);
  const [subjects, setSubjects] = useState<AnalysisSubject[]>([]);

  useEffect(() => {
    let cancelled = false;
    getSubjects()
      .then((res) => {
        if (!cancelled) setSubjects(res.items);
      })
      .catch(() => {
        if (!cancelled) setSubjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const preset = subjects.find((item) => item.is_preset) ?? subjects.find((item) => item.name === 'user');
  return { subjects, presetId: preset?.subject_id, preset };
}

export function subjectForbidsDidNot(subject?: AnalysisSubject | null) {
  return Boolean(subject && subject.kind === 'property' && subject.source?.scope === 'event');
}
