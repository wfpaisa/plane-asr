// Formateo del JavaScript generado (dist/), no de las fuentes.
//
// `tsc` emite el código sin líneas en blanco entre métodos ni entre grupos de
// declaraciones, y Prettier no las inserta (solo conserva las existentes). Esta
// pasada de `eslint --fix` las añade por AST para que el paquete que revisa EGO
// se lea holgado y ordenado; Prettier corre después para el formato definitivo.
export default [
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
        },
        rules: {
            'lines-between-class-members': [
                'error',
                'always',
                {exceptAfterSingleLine: true},
            ],
            'padding-line-between-statements': [
                'error',
                {blankLine: 'always', prev: 'import', next: '*'},
                {blankLine: 'any', prev: 'import', next: 'import'},
                {blankLine: 'always', prev: '*', next: ['function', 'class']},
                {blankLine: 'always', prev: ['function', 'class'], next: '*'},
                {blankLine: 'always', prev: ['const', 'let', 'var'], next: '*'},
                {
                    blankLine: 'any',
                    prev: ['const', 'let', 'var'],
                    next: ['const', 'let', 'var'],
                },
                {blankLine: 'always', prev: '*', next: 'return'},
            ],
        },
    },
];
