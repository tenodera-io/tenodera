import React from 'react';

export type ThemeName = 'tokyo-night-moon' | 'catppuccin-mocha' | 'tokyo-night-light' | 'catppuccin-latte';

interface ThemeInfo {
  name: ThemeName;
  label: string;
  dark: boolean;
}

export const THEMES: ThemeInfo[] = [
  { name: 'tokyo-night-moon',  label: 'Tokyo Night Moon',  dark: true  },
  { name: 'catppuccin-mocha',  label: 'Catppuccin Mocha',  dark: true  },
  { name: 'tokyo-night-light', label: 'Tokyo Night Light', dark: false },
  { name: 'catppuccin-latte',  label: 'Catppuccin Latte',  dark: false },
];

export const ThemeContext = React.createContext<{
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;
}>({ theme: 'tokyo-night-moon', setTheme: () => {} });

export function useTheme() { return React.useContext(ThemeContext); }

export function ThemeProvider({ username, children }: { username: string; children: React.ReactNode }) {
  const storageKey = `tenodera_theme_${username}`;
  const [theme, setThemeState] = React.useState<ThemeName>(() => {
    const saved = localStorage.getItem(storageKey);
    return (THEMES.find(t => t.name === saved)?.name) ?? 'tokyo-night-moon';
  });

  const setTheme = (t: ThemeName) => {
    localStorage.setItem(storageKey, t);
    setThemeState(t);
  };

  React.useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
