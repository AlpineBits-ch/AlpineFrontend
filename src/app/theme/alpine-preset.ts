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
        formField: {
          background: 'rgba(255,255,255,0.04)',
          borderColor: 'rgba(255,255,255,0.09)',
          color: '{slate.50}',
        },
        overlay: {
          select: {
            background: '{slate.800}',
            borderColor: 'rgba(255,255,255,0.09)',
            color: '{slate.100}',
            shadow: '0 4px 24px rgba(0,0,0,0.40)',
          },
          popover: {
            background: '{slate.800}',
            borderColor: 'rgba(255,255,255,0.09)',
            color: '{slate.100}',
            shadow: '0 4px 24px rgba(0,0,0,0.40)',
          },
          navigation: {
            background: '{slate.800}',
            borderColor: 'rgba(255,255,255,0.09)',
            color: '{slate.100}',
            shadow: '0 4px 24px rgba(0,0,0,0.40)',
          },
          modal: {
            background: '{slate.900}',
            borderColor: 'rgba(255,255,255,0.06)',
            color: '{slate.100}',
            shadow: '0 8px 40px rgba(0,0,0,0.60)',
          },
        },
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

  components: {

    // ── Avatar ────────────────────────────────────────────────────────────
    avatar: {
      colorScheme: {
        dark: {
          root: {
            background: '{slate.700}',
            color: '{slate.200}',
          },
        },
      },
    },

    // ── Button ────────────────────────────────────────────────────────────
    button: {
      colorScheme: {
        dark: {
          root: {
            primary: {
              background: '{indigo.600}',
              hoverBackground: '{indigo.500}',
              activeBackground: '{indigo.700}',
              borderColor: '{indigo.600}',
              hoverBorderColor: '{indigo.500}',
              activeBorderColor: '{indigo.700}',
              color: '#ffffff',
            },
            secondary: {
              background: 'rgba(255,255,255,0.06)',
              hoverBackground: 'rgba(255,255,255,0.10)',
              activeBackground: 'rgba(255,255,255,0.14)',
              borderColor: 'rgba(255,255,255,0.10)',
              hoverBorderColor: 'rgba(255,255,255,0.15)',
              activeBorderColor: 'rgba(255,255,255,0.20)',
              color: 'rgba(255,255,255,0.70)',
            },
          },
        },
      },
    },

    // ── Textarea ──────────────────────────────────────────────────────────
    textarea: {
      colorScheme: {
        dark: {
          root: {
            background: 'rgba(255,255,255,0.04)',
            borderColor: 'rgba(255,255,255,0.09)',
            color: '{slate.50}',
            placeholderColor: '{slate.400}',
            focusBorderColor: '{indigo.400}',
            focusRing: {
              color: '{indigo.400}',
              shadow: '0 0 0 3px rgba(129,140,248,0.20)',
            },
          },
        },
      },
    },

    // ── InputText ─────────────────────────────────────────────────────────
    inputtext: {
      colorScheme: {
        dark: {
          root: {
            background: 'rgba(255,255,255,0.04)',
            borderColor: 'rgba(255,255,255,0.09)',
            color: '{slate.50}',
            placeholderColor: '{slate.400}',
            focusBorderColor: '{indigo.400}',
            focusRing: {
              color: '{indigo.400}',
              shadow: '0 0 0 3px rgba(129,140,248,0.20)',
            },
          },
        },
      },
    },

    // ── Select (Dropdown) ─────────────────────────────────────────────────
    select: {
      colorScheme: {
        dark: {
          overlay: {
            background: '{slate.800}',
            borderColor: 'rgba(255,255,255,0.09)',
            color: '{slate.100}',
          },
          option: {
            focusBackground: 'rgba(255,255,255,0.05)',
            selectedBackground: 'rgba(99,102,241,0.15)',
            selectedFocusBackground: 'rgba(99,102,241,0.25)',
            color: '{slate.100}',
            selectedColor: '{indigo.400}',
          },
        },
      },
    },

    // ── DatePicker ────────────────────────────────────────────────────────
    datepicker: {
      colorScheme: {
        dark: {
          panel: {
            background: '{slate.800}',
            borderColor: 'rgba(255,255,255,0.09)',
            color: '{slate.100}',
          },
          header: {
            background: 'transparent',
            borderColor: 'rgba(255,255,255,0.06)',
            color: '{slate.100}',
          },
          date: {
            selectedBackground: '{indigo.600}',
            selectedColor: '#ffffff',
            hoverBackground: 'rgba(255,255,255,0.05)',
          },
          today: {
            background: 'rgba(99,102,241,0.15)',
            color: '{indigo.400}',
          },
        },
      },
    },

    // ── Dialog ────────────────────────────────────────────────────────────
    dialog: {
      colorScheme: {
        dark: {
          root: {
            background: '{slate.900}',
            borderColor: 'rgba(255,255,255,0.06)',
            color: '{slate.100}',
          },
        },
      },
    },

    // ── Tooltip ───────────────────────────────────────────────────────────
    tooltip: {
      colorScheme: {
        dark: {
          root: {
            background: '{slate.700}',
            color: '{slate.100}',
          },
        },
      },
    },

    // ── Badge ─────────────────────────────────────────────────────────────
    badge: {
      colorScheme: {
        dark: {
          primary: {
            background: '{indigo.600}',
            color: '#ffffff',
          },
        },
      },
    },

    // ── Chip ──────────────────────────────────────────────────────────────
    chip: {
      colorScheme: {
        dark: {
          root: {
            background: 'rgba(255,255,255,0.06)',
            color: '{slate.200}',
          },
        },
      },
    },

    // ── Tag ───────────────────────────────────────────────────────────────
    tag: {
      colorScheme: {
        dark: {
          primary:   { background: 'rgba(99,102,241,0.20)',  color: '{indigo.300}' },
          secondary: { background: 'rgba(255,255,255,0.07)', color: '{slate.200}'  },
          success:   { background: 'rgba(52,211,153,0.15)',  color: '#34d399'      },
          info:      { background: 'rgba(56,189,248,0.15)',  color: '#38bdf8'      },
          warn:      { background: 'rgba(251,191,36,0.15)',  color: '#fbbf24'      },
          danger:    { background: 'rgba(244,63,94,0.15)',   color: '#f43f5e'      },
          contrast:  { background: '{slate.0}',              color: '{slate.950}'  },
        },
      },
    },

    // ── Fieldset ──────────────────────────────────────────────────────────
    fieldset: {
      colorScheme: {
        dark: {
          root: {
            background: 'transparent',
            borderColor: 'rgba(255,255,255,0.09)',
            color: '{slate.100}',
          },
          legend: {
            background: 'transparent',
            hoverBackground: 'rgba(255,255,255,0.05)',
            borderColor: 'rgba(255,255,255,0.09)',
            color: '{slate.200}',
          },
        },
      },
    },

    // ── Listbox ───────────────────────────────────────────────────────────
    listbox: {
      colorScheme: {
        dark: {
          root: {
            background: '{slate.800}',
            borderColor: 'rgba(255,255,255,0.09)',
            color: '{slate.100}',
          },
          option: {
            focusBackground: 'rgba(255,255,255,0.05)',
            selectedBackground: 'rgba(99,102,241,0.15)',
            selectedFocusBackground: 'rgba(99,102,241,0.22)',
            color: '{slate.100}',
            selectedColor: '{indigo.400}',
            selectedFocusColor: '{indigo.300}',
          },
        },
      },
    },

    // ── ToggleSwitch ──────────────────────────────────────────────────────
    toggleswitch: {
      colorScheme: {
        dark: {
          root: {
            checkedBackground: '{indigo.600}',
            checkedHoverBackground: '{indigo.500}',
            background: 'rgba(255,255,255,0.12)',
            hoverBackground: 'rgba(255,255,255,0.18)',
            borderColor: 'transparent',
            checkedBorderColor: 'transparent',
          },
          handle: {
            background: '#ffffff',
            checkedBackground: '#ffffff',
            hoverBackground: '#ffffff',
          },
        },
      },
    },

    // ── ConfirmDialog ─────────────────────────────────────────────────────
    confirmdialog: {
      colorScheme: {
        dark: {
          icon: {
            color: '{indigo.400}',
          },
        },
      },
    },

    // ── Menu (popup context menus) ────────────────────────────────────────
    menu: {
      colorScheme: {
        dark: {
          root: {
            background: '{slate.800}',
            borderColor: 'rgba(255,255,255,0.09)',
            color: '{slate.100}',
            shadow: '0 4px 24px rgba(0,0,0,0.40)',
          },
          item: {
            focusBackground: 'rgba(255,255,255,0.05)',
            color: '{slate.100}',
            focusColor: '{slate.100}',
            icon: {
              color: '{slate.400}',
              focusColor: '{slate.200}',
            },
          },
          submenuLabel: {
            background: 'transparent',
            color: '{slate.400}',
          },
          separator: {
            borderColor: 'rgba(255,255,255,0.08)',
          },
        },
      },
    },

    // ── ContextMenu (right-click menus) ───────────────────────────────────
    contextmenu: {
      colorScheme: {
        dark: {
          root: {
            background: '{slate.800}',
            borderColor: 'rgba(255,255,255,0.09)',
            color: '{slate.100}',
            shadow: '0 4px 24px rgba(0,0,0,0.40)',
          },
          item: {
            focusBackground: 'rgba(255,255,255,0.05)',
            color: '{slate.100}',
            focusColor: '{slate.100}',
            icon: {
              color: '{slate.400}',
              focusColor: '{slate.200}',
            },
          },
          separator: {
            borderColor: 'rgba(255,255,255,0.08)',
          },
        },
      },
    },
  },
});
