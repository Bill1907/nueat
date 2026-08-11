/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#172016',
    background: '#F6F7F2',
    backgroundElement: '#FFFFFF',
    backgroundSelected: '#E8ECE3',
    textSecondary: '#5D675B',
    surfaceRaised: '#FFFFFF',
    surfaceInset: '#E8ECE3',
    border: '#D8DED3',
    highlight: '#FFFFFF',
    shadow: '#8E998A',
    primary: '#16794A',
    onPrimary: '#FFFFFF',
    primaryAccent: '#B8E64C',
    danger: '#B42318',
    dangerSurface: '#FDECEA',
    warning: '#8A5A00',
    warningSurface: '#FFF1D6',
    successSurface: '#E7F4EC',
  },
  dark: {
    text: '#F3F6EF',
    background: '#10120E',
    backgroundElement: '#1C201A',
    backgroundSelected: '#292E26',
    textSecondary: '#B8C1B5',
    surfaceRaised: '#1C201A',
    surfaceInset: '#292E26',
    border: '#394035',
    highlight: '#30372C',
    shadow: '#000000',
    primary: '#58C982',
    onPrimary: '#102417',
    primaryAccent: '#C7F05A',
    danger: '#FF8A82',
    dangerSurface: '#482321',
    warning: '#FFD08A',
    warningSurface: '#493713',
    successSurface: '#193A29',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;
export const Radius = {
  surface: 24,
  control: 20,
  pill: 999,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
