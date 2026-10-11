import { Select } from 'antd';
import { SELECT_POPUP } from './select-popup';
import { useT } from '../i18n';
import { useProjectStore } from '../stores/project.store';

export function ProjectSelector() {
  const { t } = useT();
  const { projects, currentProject, setCurrentProject } = useProjectStore();

  return (
    <Select
      {...SELECT_POPUP}
      value={currentProject}
      onChange={setCurrentProject}
      options={projects.map((p) => ({ label: p.display_name || p.name, value: p.name }))}
      // 跟随侧栏内容宽度（侧栏宽度本身按语言实测自适应，见 useSiderWidth）：
      // 不写死 220 上限——长语言下项目名/占位文案更长，压住宽度只会提前截断（G.29）
      style={{ width: '100%', maxWidth: '100%', minWidth: 0 }}
      placeholder={t('common:projectSelector.placeholder')}
      aria-label={t('common:projectSelector.current')}
      // 侧栏底部空间有限：弹层固定最小宽度并向上展开，避免被视口/容器裁剪
      popupMatchSelectWidth={false}
      dropdownStyle={{ minWidth: 220 }}
      placement="topLeft"
    />
  );
}
