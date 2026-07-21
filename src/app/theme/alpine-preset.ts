import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

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
            50: '#f2f5ff',
            100: '#e4eafc',
            200: '#cdd8f6',
            300: '#a9bbea',
            400: '#7f99d9',
            500: '#5f7fc7',
            600: '#4d6db3',
            700: '#405b95',
            800: '#344977',
            900: '#2b3c61',
            950: '#1b263d',
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

            500: '#3f4652',
            600: '#2b3038',
            700: '#1f2329',
            800: '#171a1f',
            900: '#111317',
            950: '#0b0d10',
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
                    borderColor: 'rgba(255,255,255,0.06)',
                    color: '{zinc.50}',
                },

                overlay: {
                    select: {
                        background: '{zinc.800}',
                        borderColor: 'rgba(255,255,255,0.06)',
                        color: '{zinc.100}',
                        shadow: `
              0 0 0 1px rgba(255,255,255,0.03),
              0 12px 40px rgba(0,0,0,0.45)
            `,
                    },

                    popover: {
                        background: '{zinc.800}',
                        borderColor: 'rgba(255,255,255,0.06)',
                        color: '{zinc.100}',
                        shadow: `
              0 0 0 1px rgba(255,255,255,0.03),
              0 12px 40px rgba(0,0,0,0.45)
            `,
                    },

                    navigation: {
                        background: '{zinc.800}',
                        borderColor: 'rgba(255,255,255,0.06)',
                        color: '{zinc.100}',
                        shadow: `
              0 0 0 1px rgba(255,255,255,0.03),
              0 12px 40px rgba(0,0,0,0.45)
            `,
                    },

                    modal: {
                        background: '{zinc.900}',
                        borderColor: 'rgba(255,255,255,0.05)',
                        color: '{zinc.100}',
                        shadow: `
              0 0 0 1px rgba(255,255,255,0.04),
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
                            background: 'rgba(255,255,255,0.03)',
                            hoverBackground: 'rgba(255,255,255,0.06)',
                            activeBackground: 'rgba(255,255,255,0.09)',

                            borderColor: 'rgba(255,255,255,0.06)',
                            hoverBorderColor: 'rgba(255,255,255,0.10)',
                            activeBorderColor: 'rgba(255,255,255,0.14)',

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

                        borderColor: 'rgba(255,255,255,0.06)',
                        hoverBorderColor: 'rgba(255,255,255,0.10)',

                        color: '{zinc.50}',
                        placeholderColor: '{zinc.400}',

                        shadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',

                        focusBorderColor: '{accent.400}',

                        focusRing: {
                            color: '{accent.400}',
                            shadow: '0 0 0 2px rgba(124,114,255,0.16)',
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

                        borderColor: 'rgba(255,255,255,0.06)',
                        hoverBorderColor: 'rgba(255,255,255,0.10)',

                        color: '{zinc.50}',
                        placeholderColor: '{zinc.400}',

                        shadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',

                        focusBorderColor: '{accent.400}',

                        focusRing: {
                            color: '{accent.400}',
                            shadow: '0 0 0 2px rgba(124,114,255,0.16)',
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
                        borderColor: 'rgba(255,255,255,0.05)',
                        color: '{zinc.100}',

                        shadow: `
              0 0 0 1px rgba(255,255,255,0.03),
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
                        borderColor: 'rgba(255,255,255,0.06)',
                        color: '{zinc.100}',

                        shadow: `
              0 0 0 1px rgba(255,255,255,0.03),
              0 12px 40px rgba(0,0,0,0.50)
            `,
                    },

                    item: {
                        color: '{zinc.100}',
                        focusColor: '{zinc.50}',

                        focusBackground: 'rgba(255,255,255,0.04)',

                        icon: {
                            color: '{zinc.400}',
                            focusColor: '{zinc.200}',
                        },
                    },

                    separator: {
                        borderColor: 'rgba(255,255,255,0.06)',
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
                        borderColor: 'rgba(255,255,255,0.06)',
                        color: '{zinc.100}',

                        shadow: `
              0 0 0 1px rgba(255,255,255,0.03),
              0 12px 40px rgba(0,0,0,0.50)
            `,
                    },

                    item: {
                        color: '{zinc.100}',
                        focusColor: '{zinc.50}',

                        focusBackground: 'rgba(255,255,255,0.04)',

                        icon: {
                            color: '{zinc.400}',
                            focusColor: '{zinc.200}',
                        },
                    },

                    separator: {
                        borderColor: 'rgba(255,255,255,0.06)',
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
    },
});