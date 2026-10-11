import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Space } from 'antd';
import { ColumnHeightOutlined, ExpandOutlined, ShrinkOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';

interface ResultResizePaneProps {
  children: React.ReactNode;
  loading?: boolean;
  onFullscreen?: () => void;
  fullscreen?: boolean;
  onHeightChange?: (height: number) => void;
  /** 无查询结果时收成工具条，把高度还给 SQL 编辑器 */
  compact?: boolean;
}

const DEFAULT_HEIGHT = 360;
const MIN_HEIGHT = 240;
const EMPTY_HEIGHT = 88;

export function ResultResizePane({
  children,
  loading,
  onFullscreen,
  fullscreen,
  onHeightChange,
  compact = false,
}: ResultResizePaneProps) {
  const { t } = useT('report');
  const [height, setHeight] = useState(compact ? EMPTY_HEIGHT : DEFAULT_HEIGHT);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    if (compact) {
      setHeight(EMPTY_HEIGHT);
      return;
    }
    setHeight((current) => (current <= EMPTY_HEIGHT ? DEFAULT_HEIGHT : current));
  }, [compact]);

  useEffect(() => {
    onHeightChange?.(height);
  }, [height, onHeightChange]);

  const maxHeight = () => Math.round(window.innerHeight * 0.7);

  const clamp = useCallback((value: number) => {
    const floor = compact ? EMPTY_HEIGHT : MIN_HEIGHT;
    return Math.min(maxHeight(), Math.max(floor, value));
  }, [compact]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!dragRef.current) return;
      const next = dragRef.current.startH + (dragRef.current.startY - event.clientY);
      setHeight(clamp(next));
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [clamp]);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHeight((value) => clamp(value + 24));
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHeight((value) => clamp(value - 24));
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setHeight(MIN_HEIGHT);
    }
    if (event.key === 'End') {
      event.preventDefault();
      setHeight(maxHeight());
    }
  };

  return (
    <div
      style={{
        height: fullscreen ? '100%' : height,
        flexShrink: 0,
        borderTop: '1px solid #f0f0f0',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        position: fullscreen ? 'fixed' : 'relative',
        inset: fullscreen ? 0 : undefined,
        background: '#fff',
        zIndex: fullscreen ? 20 : undefined,
      }}
    >
      {/* 长语言按钮（俄「Полноэкранный режим」≈ 中文 2 倍宽）：工具条整体允许换行，不挤压按钮 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, rowGap: 4, padding: '0 8px', borderBottom: '1px solid #f5f5f5' }}>
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-valuemin={compact ? EMPTY_HEIGHT : MIN_HEIGHT}
          aria-valuemax={maxHeight()}
          aria-valuenow={height}
          aria-label={t('report:resultPane.resizeAria')}
          tabIndex={0}
          onKeyDown={onKey}
          onMouseDown={(event) => {
            dragRef.current = { startY: event.clientY, startH: height };
          }}
          style={{ flex: 1, cursor: 'ns-resize', height: 16, display: 'flex', alignItems: 'center', color: '#8c8c8c' }}
        >
          <ColumnHeightOutlined />
        </div>
        <Space size={4} wrap style={{ rowGap: 4 }}>
          <Button
            size="small"
            icon={height >= maxHeight() - 8 ? <ShrinkOutlined /> : <ExpandOutlined />}
            onClick={() => setHeight(height >= maxHeight() - 8
              ? (compact ? EMPTY_HEIGHT : MIN_HEIGHT)
              : maxHeight())}
            disabled={loading}
          >
            {height >= maxHeight() - 8 ? t('report:resultPane.collapse') : t('report:resultPane.expand')}
          </Button>
          {onFullscreen && (
            <Button size="small" onClick={onFullscreen}>
              {fullscreen ? t('report:resultPane.exitFullscreen') : t('report:resultPane.fullscreen')}
            </Button>
          )}
        </Space>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', opacity: loading ? 0.7 : 1 }}>{children}</div>
    </div>
  );
}
