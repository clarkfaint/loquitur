/**
 * Lectern's Android design tokens (F§10.4).
 *
 * The values are the ones `@lectern/ui-web` ships as custom properties, so the same reader sees the same
 * palette and the same rhythm on every platform: the colours are the stylesheet's hex values unchanged, and
 * the rem-based spacing, radii and sizes are converted at the stylesheet's own 16 px root — `--lectern-space-2`
 * (`0.5rem`) is `spacing.two` (8), `--lectern-radius-3` (`0.875rem`) is `radius.three` (14). Nothing here is
 * a new colour or a new measurement; the light and dark palettes are the two blocks the stylesheet swaps.
 *
 * The file carries the theme provider as well, because this unit's file scope has no separate module for it:
 * `ThemeProvider` reads the operating system's colour scheme through React Native's own `useColorScheme()` and
 * hands the matching token set to `useTheme()`. Expo's `userInterfaceStyle` key is deliberately not set in
 * `app.json`: it only takes effect with `expo-system-ui`, which this unit's install list does not name, while
 * React Native's `Appearance` — which is what the hook reads — follows the system setting on its own (the
 * generated manifest carries `uiMode` in `configChanges`, so a switch arrives without an activity restart).
 * It is written with `createElement` rather than JSX so the module can stay a `.ts` file, which is the name the
 * contract fixes.
 *
 * Font families are Android's own generic families — the stylesheet's stack starts with `system-ui`, and
 * `sans-serif` is what the platform resolves that to.
 */

import { createContext, createElement, type ReactNode, useContext, useMemo } from "react";
import { useColorScheme } from "react-native";

/** The stylesheet's palette as one shape, so a screen names `colors.line` and never a hex. */
export interface ThemeColors {
  /** Body text. */
  ink: string;
  /** Secondary text: hints, counts, the inactive tab. */
  inkMuted: string;
  /** The page behind the content. */
  paper: string;
  /** Cards, bars and fields. */
  surface: string;
  /** Hairlines and borders. */
  line: string;
  /** The one accent the reader's eye follows. */
  accent: string;
  /** Text on the accent. */
  accentInk: string;
  /** A muted accent for the accent's own backgrounds. */
  accentSoft: string;
  /** The active sentence's background (F§10.4's reader). */
  sentence: string;
  /** The active word's background, stronger than the sentence's. */
  word: string;
  /** Refusals and errors. */
  danger: string;
}

/** The palette `:root` declares. */
export const lightColors: ThemeColors = {
  ink: "#1b1d21",
  inkMuted: "#5c6070",
  paper: "#fbf9f5",
  surface: "#ffffff",
  line: "#e3dfd6",
  accent: "#2f6f6a",
  accentInk: "#ffffff",
  accentSoft: "#d7ebe7",
  sentence: "#e6f0ee",
  word: "#a9d3ce",
  danger: "#9c3527",
};

/** The palette the stylesheet swaps in for the dark theme. */
export const darkColors: ThemeColors = {
  ink: "#ecedf1",
  inkMuted: "#a3a7b4",
  paper: "#15171b",
  surface: "#1d2026",
  line: "#2e323a",
  accent: "#6fc0b6",
  accentInk: "#10201e",
  accentSoft: "#244440",
  sentence: "#23313a",
  word: "#3d5f5a",
  danger: "#e2917f",
};

/** `--lectern-space-1` … `--lectern-space-5`. */
export const spacing = { one: 4, two: 8, three: 12, four: 16, five: 24 } as const;

/** `--lectern-radius-1` … `--lectern-radius-3`. */
export const radius = { one: 4, two: 8, three: 14 } as const;

/** The stylesheet's font sizes: its 16 px body, its `0.875rem` label and its `0.75rem` caption. */
export const type = { body: 16, label: 14, caption: 12 } as const;

/** The stylesheet's font stacks, as Android resolves them. */
export const fontFamily = { sans: "sans-serif", sansEmphasis: "sans-serif-medium", mono: "monospace" } as const;

/** `--lectern-control-size`, `--lectern-icon-size` and `--lectern-progress-height`. */
export const control = { size: 36, iconSize: 20, progressHeight: 4 } as const;

/** Every token a screen draws with, and the scheme it was chosen for. */
export interface Theme {
  scheme: "light" | "dark";
  colors: ThemeColors;
  spacing: typeof spacing;
  radius: typeof radius;
  type: typeof type;
  fontFamily: typeof fontFamily;
  control: typeof control;
}

/** The tokens under the light palette. */
export const lightTheme: Theme = { scheme: "light", colors: lightColors, spacing, radius, type, fontFamily, control };

/** The tokens under the dark palette. */
export const darkTheme: Theme = { scheme: "dark", colors: darkColors, spacing, radius, type, fontFamily, control };

/** The theme in force. Light is the default the provider starts from, before the scheme is known. */
const ThemeContext = createContext<Theme>(lightTheme);

/** Hands every screen below it the tokens of the scheme the operating system reports. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const theme = useMemo(() => (scheme === "dark" ? darkTheme : lightTheme), [scheme]);
  return createElement(ThemeContext.Provider, { value: theme }, children);
}

/** The tokens of the scheme in force, for a screen's own styles. */
export function useTheme(): Theme {
  return useContext(ThemeContext);
}
