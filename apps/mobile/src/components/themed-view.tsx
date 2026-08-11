import { View, type ViewProps } from 'react-native';

import { Radius, type ThemeColor } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export type SurfaceType = 'raised' | 'inset';

export type ThemedViewProps = ViewProps & {
  lightColor?: string;
  darkColor?: string;
  type?: ThemeColor;
  surface?: SurfaceType;
};

export function ThemedView({
  style,
  lightColor,
  darkColor,
  type,
  surface,
  ...otherProps
}: ThemedViewProps) {
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const backgroundColor =
    colorScheme === 'dark' ? (darkColor ?? theme[type ?? 'background']) : (lightColor ?? theme[type ?? 'background']);
  const surfaceStyle =
    surface === 'raised'
      ? {
          backgroundColor: theme.surfaceRaised,
          borderColor: theme.highlight,
          borderWidth: 1,
          borderRadius: Radius.surface,
          shadowColor: theme.shadow,
          shadowOffset: { width: 0, height: 8 },
          shadowOpacity: 0.16,
          shadowRadius: 16,
          elevation: 5,
        }
      : surface === 'inset'
        ? {
            backgroundColor: theme.surfaceInset,
            borderColor: theme.border,
            borderWidth: 1,
            borderRadius: Radius.control,
          }
        : undefined;

  return <View style={[{ backgroundColor }, surfaceStyle, style]} {...otherProps} />;
}
