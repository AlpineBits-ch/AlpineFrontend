// @ts-check
const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');
const angular = require('angular-eslint');
const prettier = require('eslint-config-prettier');

module.exports = tseslint.config(
    {
        ignores: [
            'dist/**',
            '.angular/**',
            '.claude/**',
            'node_modules/**',
            'src-tauri/**',
            'crates/**',
            'src/assets/wasm/**',
            'scripts/**',
        ],
    },
    {
        files: ['**/*.ts'],
        extends: [
            eslint.configs.recommended,
            ...tseslint.configs.recommended,
            ...tseslint.configs.stylistic,
            ...angular.configs.tsRecommended,
            prettier,
        ],
        processor: angular.processInlineTemplates,
        rules: {
            '@angular-eslint/directive-selector': [
                'error',
                {type: 'attribute', prefix: 'app', style: 'camelCase'},
            ],
            '@angular-eslint/component-selector': [
                'error',
                {type: 'element', prefix: 'app', style: 'kebab-case'},
            ],

            // Required on new components. ~159 existing ones predate the rule and are still
            // being migrated, so this warns rather than blocks. Before flipping one, check for a
            // plain (non-signal) field written from an async callback and read by the template:
            // that is the case OnPush breaks, and the fix is to make the field a signal.
            '@angular-eslint/prefer-on-push-component-change-detection': 'warn',
            // `inject()` is the house style: 1380 call sites against 34 constructor params.
            '@angular-eslint/prefer-inject': 'error',
            // Signal inputs/outputs, not the decorators.
            '@angular-eslint/prefer-signals': 'error',
            '@angular-eslint/no-input-rename': 'error',
            '@angular-eslint/no-output-rename': 'error',
            '@angular-eslint/use-lifecycle-interface': 'error',

            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_'},
            ],
            '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
            '@typescript-eslint/no-empty-function': 'off',
            // Must stay off. Its autofix rewrites getters into class fields, and a class field
            // initialised from an imported const reads undefined under Vite in full-suite runs
            // (passes solo, so it looks like flake). Getters are the workaround here, not a style.
            '@typescript-eslint/class-literal-property-style': 'off',

            // 197 existing call sites; a warning until a logging abstraction lands.
            'no-console': ['warn', {allow: ['warn', 'error']}],
            eqeqeq: ['error', 'always', {null: 'ignore'}],
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },
    {
        // Services must not import stores. The reverse edge is legal and is 30 inject sites.
        // `ignores` is a shrinking list. Do not add to it.
        files: ['**/*.service.ts'],
        ignores: [
            'src/app/services/call-session.service.ts',
            'src/app/services/call-state.service.ts',
            'src/app/services/direct-message.service.ts',
            'src/app/services/go-live-notification.service.ts',
            'src/app/services/inbox.service.ts',
            'src/app/services/stripe-loader.service.ts',
            'src/app/services/voice-limits.service.ts',
            'src/app/features/guild/components/channel/channel-conversation/channel-send.service.ts',
            'src/app/features/main-page/navigation.service.ts',
            'src/app/features/messaging/components/conversation/conversation-search.service.ts',
        ],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['**/stores/*.store'],
                            message:
                                'A service must not import a store. Move the shared state into the store, or take the value as an argument.',
                        },
                    ],
                },
            ],
        },
    },
    {
        // Specs mock freely and assert on shapes the app never builds.
        files: ['**/*.spec.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
            'no-console': 'off',
        },
    },
    {
        files: ['**/*.html'],
        extends: [...angular.configs.templateRecommended],
        rules: {
            '@angular-eslint/template/prefer-control-flow': 'error',
        },
    },
    {
        // Accessibility is a real backlog (~278 findings) but its own piece of work: warn, don't block.
        files: ['**/*.html'],
        extends: [...angular.configs.templateAccessibility],
        rules: {
            '@angular-eslint/template/label-has-associated-control': 'warn',
            '@angular-eslint/template/interactive-supports-focus': 'warn',
            '@angular-eslint/template/click-events-have-key-events': 'warn',
            '@angular-eslint/template/no-autofocus': 'warn',
        },
    },
);
