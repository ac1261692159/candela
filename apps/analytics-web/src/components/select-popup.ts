import type { SelectProps } from 'antd';

export const SELECT_POPUP: Pick<SelectProps, 'getPopupContainer' | 'popupMatchSelectWidth'> = {
  getPopupContainer: () => document.body,
  popupMatchSelectWidth: false,
};
