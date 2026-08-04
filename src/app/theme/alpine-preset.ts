import { definePreset, palette } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';
import { DEFAULT_THEME } from '../models/theme.model';

const BORDER_SUBTLE = 'rgba(255,255,255,0.10)';
const BORDER_DEFAULT = 'rgba(255,255,255,0.16)';
const BORDER_STRONG = 'rgba(255,255,255,0.22)';

/**
 * Alpine Design System -refined dark messenger preset
 *
 * Design goals:
 * - Neutral-first UI
 * - Indigo only as interaction accent
 * - Reduced color noise
 * - Better depth/elevation
 * - More premium dark surfaces
 * - Less "Tailwind dashboard"
 */

export const AlpinePreset = definePreset(Aura, {
    primitive: {
        /**
         * Accent scale
         * Slightly softer + less default-tailwind feeling
         */
        accent: {
            ...(palette(DEFAULT_THEME.colors.brand) as object),
            400: DEFAULT_THEME.colors.brandDim,
            500: DEFAULT_THEME.colors.brand,
            600: DEFAULT_THEME.colors.brandHover,
            700: DEFAULT_THEME.colors.brandDark,
        },

        /**
         * True neutral dark system
         * Reduced purple contamination
         */
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

        /**
         * Semantic colors
         * Muted to fit neutral UI
         */
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

        /**
         * Aura resolves the unchecked box from `{form.field.background}`, which is the same
         * token the text inputs use - correct for a field you type into, and far too light for
         * a 1.25rem square sitting on a list row. It read as a white chip against the dark row.
         *
         * <p>`styles.css` used to carry a `.dark .p-multiselect-option .p-checkbox-box` override
         * with the same complaint written on it. That one was scoped to the multiselect overlay,
         * so every checkbox outside it - the shopping list's most of all - kept the white box.
         * It has been removed in favour of this, which reaches all of them; the colours here are
         * the ones it used, so the multiselect looks the same as before.</p>
         */
        checkbox: {
            colorScheme: {
                dark: {
                    root: {
                        // Not `formField.background`: a checkbox is a mark on the surface it sits
                        // on, so it tints that surface rather than punching an input-coloured
                        // hole in it - which is also why this survives on card, row and hover.
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
                        // White rather than `{primary.contrast.color}`: the accent is mid-tone
                        // enough that the generated contrast colour lands on the dark end, and a
                        // near-black tick on a purple box is the thing that looks broken.
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

        // The closed control matches `inputtext` because that is what it is - a field. The open
        // panel matches `menu` rather than the field, because that is what it behaves like, and
        // an overlay tinted like an input reads as a second input floating over the page.
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

                        // Selected is the accent at low opacity rather than a solid fill: the row
                        // still has to read as a list item, and a solid accent bar makes the open
                        // panel look like it has a header.
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

                    emptyMessage: {
                        color: '{zinc.400}',
                    },
                },
            },
        },

        radiobutton: {
            colorScheme: {
                dark: {
                    root: {
                        // Same reasoning as checkbox: a radio is a mark on whatever surface it
                        // sits on, not an input-coloured hole punched in it.
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
                        // White for the same reason as the checkbox tick - the generated contrast
                        // colour lands dark against this accent.
                        checkedColor: '#ffffff',
                        checkedHoverColor: '#ffffff',
                        disabledColor: 'rgba(255,255,255,0.30)',
                    },
                },
            },
        },

        // The field itself inherits `inputtext`; only the spinner buttons need saying, and they
        // are deliberately quiet - they sit inside the field and must not out-weigh its content.
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