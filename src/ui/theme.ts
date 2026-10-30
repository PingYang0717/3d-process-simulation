import type { ThemeConfig } from 'antd';

/** 和 styles.css 的 :root 變數對齊；兩邊要一起改。 */
export const colors = {
  primary: '#0b57d0',
  primaryBg: '#e8f1ff',
  text: '#1f2329',
  text2: '#646a73',
  text3: '#6b7280',
  border: '#e4e6eb',
  border2: '#eef0f3',
  bg: '#f5f6f8',
  bgSub: '#fafbfc',
  track: '#f0f1f3',
} as const;

const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Ant Design 5 主題：主色 #0b57d0（白字對比 6.4:1），邊框與文字灰階調淡；系統要求減少動態時關掉元件動畫。 */
export const theme: ThemeConfig = {
  token: {
    colorPrimary: colors.primary,
    colorLink: colors.primary,
    borderRadius: 6,
    fontSize: 13,
    controlHeight: 32,
    controlHeightSM: 26,
    colorBorder: colors.border,
    colorBorderSecondary: colors.border2,
    colorBgLayout: colors.bg,
    colorText: colors.text,
    colorTextSecondary: colors.text2,
    colorTextTertiary: colors.text3,
    motion: !reducedMotion,
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
      defaultBorderColor: colors.border,
      defaultHoverBg: colors.bg,
      defaultHoverBorderColor: '#d0d3d9',
      defaultHoverColor: colors.text,
      defaultActiveBg: colors.border2,
    },
    Segmented: { trackBg: colors.track, itemSelectedBg: '#fff', itemSelectedColor: colors.text, trackPadding: 2 },
    Tabs: { titleFontSize: 13, horizontalItemPadding: '10px 0', horizontalMargin: '0 0 0 0' },
    Table: { cellPaddingBlockSM: 6, cellPaddingInlineSM: 8, headerBg: colors.bgSub, headerColor: colors.text2, borderColor: colors.border2 },
    Input: { activeShadow: '0 0 0 2px rgba(11,87,208,.12)' },
    InputNumber: { activeShadow: '0 0 0 2px rgba(11,87,208,.12)' },
    Select: { optionSelectedBg: colors.primaryBg },
    Tag: { borderRadiusSM: 4 },
    Alert: { withDescriptionPadding: '12px 14px', defaultPadding: '6px 10px' },
    Drawer: { paddingLG: 20 },
  },
};
