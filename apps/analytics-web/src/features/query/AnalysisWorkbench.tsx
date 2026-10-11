import type { ReactNode } from 'react';
import { useShellLayout } from '../../layouts/shell-layout-context';
import './analysis-workbench.css';

interface AnalysisWorkbenchProps {
  rail: ReactNode;
  result: ReactNode;
}

export function AnalysisWorkbench({ rail, result }: AnalysisWorkbenchProps) {
  const { layout } = useShellLayout();
  return (
    <div className={`analysis-workbench analysis-workbench--${layout.workbench}`}>
      <aside className="analysis-workbench__rail">{rail}</aside>
      <section className="analysis-workbench__result">{result}</section>
    </div>
  );
}
