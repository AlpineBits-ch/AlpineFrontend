import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

/**
 * Alpine Design System — PrimeNG preset
 *
 * Color palette reference:
 *   App bg:       #0d1117   (surface.900)
 *   Sidebar bg:   #111520   (surface.800)
 *   Card/input:   #161b27   (surface.700)
 *   Hover:        #1d2333   (surface.600)
 *   Border:       #252e42   (surface.500)
 *
 *   Brand:        #6366f1   indigo-500
 *   Brand dim:    #818cf8   indigo-400
 *   Brand hover:  #4f46e5   indigo-600
 *
 *   Online:       #34d399   emerald-400
 *   Connecting:   #fbbf24   amber-400
 *   Offline:      #f43f5e   rose-500
 */
export const AlpinePreset = definePreset(Aura, {
  primitive: {
    // Custom indigo scale used as primary
    indigo: {
      50:  '#eef2ff',
      100: '#e0e7ff',
      200: '#c7d2fe',
      300: '#a5b4fc',
      400: '#818cf8',
      500: '#6366f1',
      600: '#4f46e5',
      700: '#4338ca',
      800: '#3730a3',
      900: '#312e81',
      950: '#1e1b4b',
    },
    // Dark-blue surface scale used across all components in dark mode
    slate: {
      0:   '#ffffff',
      50:  '#e4e8f0',
      100: '#c9d0de',
      200: '#9aa5be',
      300: '#6b7a99',
      400: '#3d4f6e',
      500: '#252e42',
      600: '#1d2333',
      700: '#161b27',
      800: '#111520',
      900: '#0d1117',
      950: '#080c11',
    },
  },

  semantic: {
    // Map primary to our indigo palette
    primary: {
      50:  '{indigo.50}',
      100: '{indigo.100}',
      200: '{indigo.200}',
      300: '{indigo.300}',
      400: '{indigo.400}',
      500: '{indigo.500}',
      600: '{indigo.600}',
      700: '{indigo.700}',
      800: '{indigo.800}',
      900: '{indigo.900}',
      950: '{indigo.950}',
    },

    colorScheme: {
      dark: {
        // Map PrimeNG surface tokens to our dark-blue slate scale
        surface: {
          0:   '{slate.0}',
          50:  '{slate.50}',
          100: '{slate.100}',
          200: '{slate.200}',
          300: '{slate.300}',
          400: '{slate.400}',
          500: '{slate.500}',
          600: '{slate.600}',
          700: '{slate.700}',
          800: '{slate.800}',
          900: '{slate.900}',
          950: '{slate.950}',
        },
      },
    },
  },
});
