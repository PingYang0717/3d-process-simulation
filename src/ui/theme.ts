import type { ThemeConfig } from 'antd';

/** Ant Design 5 主題：預設主色 #1677ff，邊框與文字灰階調淡。 */
export const theme: ThemeConfig = {
  token: {
    colorPrimary: '#1677ff',
    borderRadius: 6,
    fontSize: 13,
    controlHeight: 32,
    controlHeightSM: 26,
    colorBorder: '#e4e6eb',
    colorBorderSecondary: '#eef0f3',
    colorBgLayout: '#f5f6f8',
    colorText: '#1f2329',
    colorTextSecondary: '#646a73',
    colorTextTertiary: '#8f959e',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, 'PingFang TC', 'Noto Sans TC', 'Helvetica Neue', Arial, sans-serif",
  },
  components: {
    Button: {
      defaultShadow: 'none',
      primaryShadow: 'none',
      dangerShadow: 'none',
      fontWeight: 500,
      paddingInline: 12,
      paddingInlineSM: 10,
      defaultBorderColor: '#e4e6eb',
      defaultHoverBg: '#f5f6f8',
      defaultHoverBorderColor: '#d0d3d9',
      defaultHoverColor: '#1f2329',
      defaultActiveBg: '#eef0f3',
    },
    Segmented: { trackBg: '#f0f1f3', itemSelectedBg: '#fff', itemSelectedColor: '#1f2329', trackPadding: 2 },
    Tabs: { titleFontSize: 13, horizontalItemPadding: '10px 0', horizontalMargin: '0 0 0 0' },
    Table: { cellPaddingBlockSM: 6, cellPaddingInlineSM: 8, headerBg: '#fafbfc', headerColor: '#646a73', borderColor: '#eef0f3' },
    Input: { activeShadow: '0 0 0 2px rgba(22,119,255,.12)' },
    InputNumber: { activeShadow: '0 0 0 2px rgba(22,119,255,.12)' },
    Select: { optionSelectedBg: '#e8f1ff' },
    Tag: { borderRadiusSM: 4 },
    Alert: { withDescriptionPadding: '12px 14px', defaultPadding: '6px 10px' },
    Drawer: { paddingLG: 20 },
  },
};
