/* eslint-env node */
/* eslint-disable node/no-unsupported-features/es-syntax */

import nodeResolve from '@rollup/plugin-node-resolve';
import commonJS from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import replace from '@rollup/plugin-replace';

import babel from 'rollup-plugin-babel';
import globals from 'rollup-plugin-node-globals';
import nodePolyfills from 'rollup-plugin-node-polyfills';
import filesize from 'rollup-plugin-filesize';
import {terser} from 'rollup-plugin-terser';

import builtins from 'builtin-modules';

import pkg from './package.json';

const babelBrowserOptions = {
    // sourceMapsAbsolute: true,
    plugins: ['add-module-exports'],
    presets: [
        ['@babel/env', {
            targets: pkg.browserslist[0] // cover 100%
        }]
    ]
};

const babelNodeOptions = {...babelBrowserOptions,
    presets: [
        ['@babel/env', {
            targets: {
                node: '6.9'
            }
        }]
    ]
};

const getRollupPlugins = (babelOptions, {addBuiltins, mainFields, min} = {}) => {
    const ret = [
        nodeResolve({
            mainFields,
            preferBuiltins: !addBuiltins
        }),
        commonJS({
            // Gets issue with dynamic requires and we aren't
            //  "importing" anyways
            ignore: ['sqlite3']
        }),
        babel(babelOptions),
        filesize()
    ];
    if (addBuiltins) {
        ret.unshift(globals(), nodePolyfills());
    } else {
        // Fix from https://github.com/rollup/rollup/issues/1507#issuecomment-340550539
        ret.splice(1, 0, replace({
            delimiters: ['', ''],
            // Replacements:
            'require(\'readable-stream/transform\')': 'require(\'stream\').Transform',
            'require("readable-stream/transform")': 'require("stream").Transform',
            'readable-stream': 'stream'
        }));

        ret.unshift(json());
    }
    if (min) {
        ret.push(terser({
            output: {
                // Not apparently working per https://github.com/TrySound/rollup-plugin-terser/issues/68
                comments (node, comment) {
                    return (/\/*!/u).test(comment.value);
                }
            }
        }));
    }
    return ret;
};

const browserEnvironment = ({input, name, output: file}) => {
    const banner = `/*! ${pkg.name} - v${pkg.version} - ` +
        // eslint-disable-next-line compat/compat
        `${new Intl.DateTimeFormat('en-US').format(new Date())} */\n`;
    return [true, false].map((min) => {
        return {
            input,
            output: {
                name,
                banner,
                file: min ? file.replace(/\.js$/u, '.min.js') : file,
                format: 'umd',
                sourcemap: true
            },
            plugins: getRollupPlugins(
                babelBrowserOptions,
                {min, addBuiltins: true, mainFields: ['browser', 'module', 'main']} // Don't need 'jsnext'?
            )
        };
    });
};

const nodeEnvironment = ({input, name, output: file}) => {
    const banner = `/*! ${pkg.name} - v${pkg.version} - ` +
        // eslint-disable-next-line compat/compat
        `${new Intl.DateTimeFormat('en-US').format(new Date())} */\n`;
    return [false].map((min) => {
        return {
            input,
            external: [
                ...builtins,
                'websql/custom/index.js', 'websql/lib/sqlite/SQLiteDatabase',
                // Fix from https://github.com/rollup/rollup/issues/1507#issuecomment-340550539
                'readable-stream', 'readable-stream/transform'
            ],
            output: {
                file: min ? file.replace(/\.js$/u, '.min.js') : file,
                name,
                banner,
                // Avoid using `browser` entry in package.json
                format: 'cjs',
                // Avoid `window` checking (link now broken)
                // https://github.com/substack/node-rollup/issues/1277#issuecomment-115198436
                sourcemap: true
                // Notes when using browserify:
                // Could try for consistency with any relative paths if still
                //  seeing https://github.com/axemclion/IndexedDBShim/issues/291 ;
                //  see also http://stackoverflow.com/a/33124979/271577
                // basedir: __dirname,
            },
            plugins: getRollupPlugins(
                babelNodeOptions,
                {
                    min,
                    addBuiltins: false
                    // mainFields: ['module', 'main'] // Default
                }
            )
        };
    });
};

/**
* @external Rollup
*/

/* eslint-disable import/no-anonymous-default-export */
/**
 * @param {PlainObject} commandLineArgs Object allowing user-defined `config*`,
 * e.g., `configBrowserOnly`
 * @returns {external:Rollup[]}
 */
export default (commandLineArgs) => {
    /* eslint-enable import/no-anonymous-default-export */

    // if (commandLineArgs.configBrowserOnly) {

    return [
        {
            input: 'node_modules/unicode-10.0.0/Binary_Property/Expands_On_NFD/regex.js',
            output: {
                file: 'src/unicode-regex.js',
                format: 'esm'
            },
            plugins: [
                commonJS({
                    include: ['node_modules/**']
                })
            ]
        },
        ...browserEnvironment({
            name: 'IDBKeyUtils',
            input: 'src/Key.js',
            output: `dist/${pkg.name}-Key.js`
        }),
        ...browserEnvironment({
            input: 'src/browser-UnicodeIdentifiers.js',
            output: `dist/${pkg.name}-UnicodeIdentifiers.js`
        }),
        ...nodeEnvironment({
            input: 'src/node-UnicodeIdentifiers.js',
            output: `dist/${pkg.name}-UnicodeIdentifiers-node.js`
        }),
        ...browserEnvironment({
            input: 'src/browser.js',
            output: `dist/${pkg.name}.js`
        }),
        ...browserEnvironment({
            name: 'setGlobalVars',
            input: 'src/browser-noninvasive.js',
            output: `dist/${pkg.name}-noninvasive.js`
        }),
        ...nodeEnvironment({
            input: 'src/node.js',
            output: `dist/${pkg.name}-node.js`
        })
    ];
};
