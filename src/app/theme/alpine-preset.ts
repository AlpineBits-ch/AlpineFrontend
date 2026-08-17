import { definePreset, palette } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';
import { DEFAULT_THEME } from '../models/theme.model';

const BORDER_SUBTLE = 'rgba(255,255,255,0.10)';
const BORDER_DEFAULT = 'rgba(255,255,255,0.16)';
const BORDER_STRONG = 'rgba(255,255,255,0.22)';

/**
 * Alpine Design System: refined dark messenger preset. Neutral-first, with indigo used only as the
 * interaction accent.
 */

export const AlpinePreset = definePreset(Aura, {
    primitive: {
        /** Accent scale. */
        accent: {
            ...(palette(DEFAULT_THEME.colors.brand) as object),
            400: DEFAULT_THEME.colors.brandDim,
            500: DEFAULT_THEME.colors.brand,
            600: DEFAULT_THEME.colors.brandHover,
            700: DEFAULT_THEME.colors.brandDark,
        },

        /** True neutral dark system. */
        zinc: {
            0: '#ffffff',

            50: '#f3f4f6',
            100: '#e5e7eb',
            200: '#cfd4dc',
            300: '#9aa4b2',
            400: '#6b7280',

            500: '#454c59',
            600: '#2f3540',
            700: '#242a33',
            800: '#1b1f26',
            900: '#131620',
            950: '#0a0c10',
        },

        /** Semantic colors. */
        success: '#46b98a',
        warn: '#d9a441',
        danger: '#e06c75',
        info: '#56a8f5',
    },

    semantic: {
        primary: {
            50: '{accent.50}',
            100: '{accent.100}',
            200: '{accent.200}',
            300: '{accent.300}',
            400: '{accent.400}',
            500: '{accent.500}',
            600: '{accent.600}',
            700: '{accent.700}',
            800: '{accent.800}',
            900: '{accent.900}',
            950: '{accent.950}',
        },

        colorScheme: {
            dark: {
                surface: {
                    0: '{zinc.0}',
                    50: '{zinc.50}',
                    100: '{zinc.100}',
                    200: '{zinc.200}',
                    300: '{zinc.300}',
                    400: '{zinc.400}',
                    500: '{zinc.500}',
                    600: '{zinc.600}',
                    700: '{zinc.700}',
                    800: '{zinc.800}',
                    900: '{zinc.900}',
                    950: '{zinc.950}',
                },

                formField: {
                    background: '#121821',
                    borderColor: BORDER_SUBTLE,
                    color: '{zinc.50}',
                },

                overlay: {
                    select: {
                        background: '{zinc.800}',
                        borderColor: BORDER_SUBTLE,
                        color: '{zinc.100}',
                        shadow: `
              0 0 0 1px rgba(255,255,255,0.08),
              0 12px 40px rgba(0,0,0,0.45)
            `,
                    },

                    popover: {
                        background: '{zinc.800}',
                        borderColor: BORDER_SUBTLE,
                        color: '{zinc.100}',
                        shadow: `
              0 0 0 1px rgba(255,255,255,0.08),
              0 12px 40px rgba(0,0,0,0.45)
            `,
                    },

                    navigation: {
                        background: '{zinc.800}',
                        borderColor: BORDER_SUBTLE,
                        color: '{zinc.100}',
                        shadow: `
              0 0 0 1px rgba(255,255,255,0.08),
              0 12px 40px rgba(0,0,0,0.45)
            `,
                    },

                    modal: {
                        background: '{zinc.900}',
                        borderColor: BORDER_SUBTLE,
                        color: '{zinc.100}',
                        shadow: `
              0 0 0 1px rgba(255,255,255,0.10),
              0 20px 60px rgba(0,0,0,0.60)
            `,
                    },
                },
            },
        },
    },

    components: {
        avatar: {
            colorScheme: {
                dark: {
                    root: {
                        background: '{zinc.700}',
                        color: '{zinc.200}',
                    },
                },
            },
        },

        button: {
            colorScheme: {
                dark: {
                    root: {
                        borderRadius: '10px',

                        primary: {
                            background: '{accent.600}',
                            hoverBackground: '{accent.500}',
                            activeBackground: '{accent.700}',

                            borderColor: '{accent.600}',
                            hoverBorderColor: '{accent.500}',
                            activeBorderColor: '{accent.700}',

                            color: '#ffffff',
                        },

                        secondary: {
                            background: 'rgba(255,255,255,0.05)',
                            hoverBackground: 'rgba(255,255,255,0.09)',
                            activeBackground: 'rgba(255,255,255,0.13)',

                            borderColor: BORDER_SUBTLE,
                            hoverBorderColor: BORDER_DEFAULT,
                            activeBorderColor: BORDER_STRONG,

                            color: '{zinc.200}',
                        },
                    },
                },
            },
        },

        inputtext: {
            colorScheme: {
                dark: {
                    root: {
                        background: '#121821',

                        borderColor: BORDER_SUBTLE,
                        hoverBorderColor: BORDER_DEFAULT,

                        color: '{zinc.50}',
                        placeholderColor: '{zinc.400}',

                        shadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',

                        focusBorderColor: '{accent.400}',

                        focusRing: {
                            color: '{accent.400}',
                            shadow: '0 0 0 2px rgba(124,114,255,0.32)',
                        },
                    },
                },
            },
        },

        textarea: {
            colorScheme: {
                dark: {
                    root: {
                        background: '#121821',

                        borderColor: BORDER_SUBTLE,
                        hoverBorderColor: BORDER_DEFAULT,

                        color: '{zinc.50}',
                        placeholderColor: '{zinc.400}',

                        shadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',

                        focusBorderColor: '{accent.400}',

                        focusRing: {
                            color: '{accent.400}',
                            shadow: '0 0 0 2px rgba(124,114,255,0.32)',
                        },
                    },
                },
            },
        },

        dialog: {
            colorScheme: {
                dark: {
                    root: {
                        background: '{zinc.900}',
                        borderColor: BORDER_SUBTLE,
                        color: '{zinc.100}',

                        shadow: `
              0 0 0 1px rgba(255,255,255,0.09),
              0 24px 80px rgba(0,0,0,0.65)
            `,
                    },
                },
            },
        },

        menu: {
            colorScheme: {
                dark: {
                    root: {
                        background: '{zinc.800}',
                        borderColor: BORDER_SUBTLE,
                        color: '{zinc.100}',

                        shadow: `
              0 0 0 1px rgba(255,255,255,0.08),
              0 12px 40px rgba(0,0,0,0.50)
            `,
                    },

                    item: {
                        color: '{zinc.100}',
                        focusColor: '{zinc.50}',

                        focusBackground: 'rgba(255,255,255,0.07)',

                        icon: {
                            color: '{zinc.400}',
                            focusColor: '{zinc.200}',
                        },
                    },

                    separator: {
                        borderColor: BORDER_SUBTLE,
                    },

                    submenuLabel: {
                        color: '{zinc.400}',
                    },
                },
            },
        },

        contextmenu: {
            colorScheme: {
                dark: {
                    root: {
                        background: '{zinc.800}',
                        borderColor: BORDER_SUBTLE,
                        color: '{zinc.100}',

                        shadow: `
              0 0 0 1px rgba(255,255,255,0.08),
              0 12px 40px rgba(0,0,0,0.50)
            `,
                    },

                    item: {
                        color: '{zinc.100}',
                        focusColor: '{zinc.50}',

                        focusBackground: 'rgba(255,255,255,0.07)',

                        icon: {
                            color: '{zinc.400}',
                            focusColor: '{zinc.200}',
                        },
                    },

                    separator: {
                        borderColor: BORDER_SUBTLE,
                    },
                },
            },
        },

        tooltip: {
            colorScheme: {
                dark: {
                    root: {
                        background: '{zinc.700}',
                        color: '{zinc.100}',
                    },
                },
            },
        },

        chip: {
            colorScheme: {
                dark: {
                    root: {
                        background: 'rgba(255,255,255,0.04)',
                        color: '{zinc.200}',
                    },
                },
            },
        },

        badge: {
            colorScheme: {
                dark: {
                    primary: {
                        background: '{accent.600}',
                        color: '#ffffff',
                    },
                },
            },
        },

        tag: {
            colorScheme: {
                dark: {
                    primary: {
                        background: 'rgba(124,114,255,0.14)',
                        color: '{accent.300}',
                    },

                    secondary: {
                        background: 'rgba(255,255,255,0.05)',
                        color: '{zinc.200}',
                    },

                    success: {
                        background: 'rgba(70,185,138,0.14)',
                        color: '{success}',
                    },

                    info: {
                        background: 'rgba(86,168,245,0.14)',
                        color: '{info}',
                    },

                    warn: {
                        background: 'rgba(217,164,65,0.14)',
                        color: '{warn}',
                    },

                    danger: {
                        background: 'rgba(224,108,117,0.14)',
                        color: '{danger}',
                    },

                    contrast: {
                        background: '{zinc.0}',
                        color: '{zinc.950}',
                    },
                },
            },
        },

        checkbox: {
            colorScheme: {
                dark: {
                    root: {
                        // Not `formField.background`: a checkbox tints the surface it sits on.
                        background: 'rgba(255,255,255,0.04)',
                        borderColor: BORDER_DEFAULT,
                        hoverBorderColor: 'rgba(255,255,255,0.28)',

                        checkedBackground: '{accent.500}',
                        checkedHoverBackground: '{accent.400}',
                        checkedBorderColor: '{accent.500}',
                        checkedHoverBorderColor: '{accent.400}',

                        disabledBackground: 'rgba(255,255,255,0.02)',
                    },

                    icon: {
                        // White rather than `{primary.contrast.color}`, which lands too dark here.
                        checkedColor: '#ffffff',
                        checkedHoverColor: '#ffffff',
                        disabledColor: 'rgba(255,255,255,0.30)',
                    },
                },
            },
        },

        toggleswitch: {
            colorScheme: {
                dark: {
                    root: {
                        background: 'rgba(255,255,255,0.12)',
                        hoverBackground: 'rgba(255,255,255,0.18)',

                        checkedBackground: '{accent.600}',
                        checkedHoverBackground: '{accent.500}',

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

        // The closed control matches `inputtext`; the open panel matches `menu`.
        select: {
            colorScheme: {
                dark: {
                    root: {
                        background: '#121821',
                        disabledBackground: 'rgba(255,255,255,0.02)',
                        filledBackground: '#121821',
                        filledHoverBackground: '#121821',
                        filledFocusBackground: '#121821',

                        borderColor: BORDER_SUBTLE,
                        hoverBorderColor: BORDER_DEFAULT,
                        focusBorderColor: '{accent.400}',

                        color: '{zinc.50}',
                        disabledColor: 'rgba(255,255,255,0.30)',
                        placeholderColor: '{zinc.400}',

                        shadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',

                        focusRing: {
                            color: '{accent.400}',
                            shadow: '0 0 0 2px rgba(124,114,255,0.32)',
                        },
                    },

                    dropdown: {
                        color: '{zinc.400}',
                    },

                    overlay: {
                        background: '{zinc.800}',
                        borderColor: BORDER_SUBTLE,
                        color: '{zinc.100}',

                        shadow: `
              0 0 0 1px rgba(255,255,255,0.08),
              0 12px 40px rgba(0,0,0,0.50)
            `,
                    },

                    option: {
                        color: '{zinc.100}',
                        focusColor: '{zinc.50}',
                        focusBackground: 'rgba(255,255,255,0.07)',

                        // Selected is the accent at low opacity rather than a solid fill.
                        selectedColor: '{zinc.50}',
                        selectedBackground: 'rgba(124,114,255,0.20)',
                        selectedFocusColor: '{zinc.50}',
                        selectedFocusBackground: 'rgba(124,114,255,0.28)',
                    },

                    optionGroup: {
                        background: 'transparent',
                        color: '{zinc.400}',
                    },

                    clearIcon: {
                        color: '{zinc.400}',
                    },
                },
            },
        },

        /** The calendar overlay, stated literally like every other overlay in this preset. */
        datepicker: {
            colorScheme: {
                dark: {
                    panel: {
                        background: '{zinc.800}',
                        borderColor: BORDER_SUBTLE,
                        color: '{zinc.100}',

                        shadow: `
              0 0 0 1px rgba(255,255,255,0.08),
              0 12px 40px rgba(0,0,0,0.50)
            `,
                    },

                    header: {
                        background: 'transparent',
                        borderColor: BORDER_SUBTLE,
                        color: '{zinc.100}',
                    },

                    // The month/year buttons are navigation, not fields: quiet until hovered.
                    selectMonth: {
                        color: '{zinc.100}',
                        hoverColor: '{zinc.50}',
                        hoverBackground: 'rgba(255,255,255,0.07)',
                    },

                    selectYear: {
                        color: '{zinc.100}',
                        hoverColor: '{zinc.50}',
                        hoverBackground: 'rgba(255,255,255,0.07)',
                    },

                    // Column headings, not data: muted so the numbers below them carry the grid.
                    weekDay: {
                        color: '{zinc.400}',
                    },

                    date: {
                        color: '{zinc.100}',
                        hoverColor: '{zinc.50}',
                        hoverBackground: 'rgba(255,255,255,0.07)',

                        selectedBackground: '{accent.500}',
                        selectedColor: '#ffffff',

                        // A range is a band behind several days, so it stays translucent.
                        rangeSelectedBackground: 'rgba(124,114,255,0.20)',
                        rangeSelectedColor: '{zinc.50}',

                        focusRing: {
                            color: '{accent.400}',
                            shadow: '0 0 0 2px rgba(124,114,255,0.32)',
                        },
                    },

                    // Today is a hint, not a selection.
                    today: {
                        background: 'rgba(255,255,255,0.09)',
                        color: '{zinc.50}',
                    },

                    // The month/year grid pages reuse the day cell's colours via `content`.
                    group: {
                        borderColor: BORDER_SUBTLE,
                    },

                    buttonbar: {
                        borderColor: BORDER_SUBTLE,
                    },

                    timePicker: {
                        borderColor: BORDER_SUBTLE,
                    },

                    // The trigger button sits inside the field, so it matches `inputnumber`'s spinner.
                    dropdown: {
                        background: 'transparent',
                        hoverBackground: 'rgba(255,255,255,0.07)',
                        activeBackground: 'rgba(255,255,255,0.10)',

                        borderColor: BORDER_SUBTLE,
                        hoverBorderColor: BORDER_DEFAULT,
                        activeBorderColor: BORDER_DEFAULT,

                        color: '{zinc.400}',
                        hoverColor: '{zinc.200}',
                        activeColor: '{zinc.100}',
                    },

                    inputIcon: {
                        color: '{zinc.400}',
                    },
                },
            },
        },

        radiobutton: {
            colorScheme: {
                dark: {
                    root: {
                        // Same as checkbox: a radio tints the surface it sits on.
                        background: 'rgba(255,255,255,0.04)',
                        checkedBackground: '{accent.500}',
                        checkedHoverBackground: '{accent.400}',
                        disabledBackground: 'rgba(255,255,255,0.02)',
                        filledBackground: 'rgba(255,255,255,0.04)',

                        borderColor: BORDER_DEFAULT,
                        hoverBorderColor: 'rgba(255,255,255,0.28)',
                        focusBorderColor: '{accent.400}',
                        checkedBorderColor: '{accent.500}',
                        checkedHoverBorderColor: '{accent.400}',
                        checkedFocusBorderColor: '{accent.400}',
                        checkedDisabledBorderColor: BORDER_DEFAULT,

                        focusRing: {
                            color: '{accent.400}',
                            shadow: '0 0 0 2px rgba(124,114,255,0.32)',
                        },
                    },

                    icon: {
                        // White for the same reason as the checkbox tick.
                        checkedColor: '#ffffff',
                        checkedHoverColor: '#ffffff',
                        disabledColor: 'rgba(255,255,255,0.30)',
                    },
                },
            },
        },

        // The field itself inherits `inputtext`; only the spinner buttons need saying.
        inputnumber: {
            colorScheme: {
                dark: {
                    button: {
                        background: 'transparent',
                        hoverBackground: 'rgba(255,255,255,0.07)',
                        activeBackground: 'rgba(255,255,255,0.10)',

                        borderColor: BORDER_SUBTLE,
                        hoverBorderColor: BORDER_SUBTLE,
                        activeBorderColor: BORDER_SUBTLE,

                        color: '{zinc.400}',
                        hoverColor: '{zinc.200}',
                        activeColor: '{zinc.100}',
                    },
                },
            },
        },
    },
});