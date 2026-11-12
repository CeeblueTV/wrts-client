/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

// For an extensive guide to getting started with the rollup.js JavaScript bundler, visit:
// https://blog.openreplay.com/the-ultimate-guide-to-getting-started-with-the-rollup-js-javascript-bundler

import replacer from '@rollup/plugin-replace';
import eslint from '@rollup/plugin-eslint';
import typescript from '@rollup/plugin-typescript';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import { dts } from 'rollup-plugin-dts';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import path from 'path';
import { readFileSync } from 'fs';

const input = 'index.ts';
const output = 'dist/wrts-client';
const name = 'CeeblueWRTSClient';

// The WebAssembly audio decoder (see the wasm folder) is the module src/media/audio/DecoderWasmBinary,
// generated here from its binary. It is imported dynamically, to be loaded only by the browsers which need it.
const decoderInput = 'wasm/decoder.wasm';
const decoderOutput = output + '.decoder.js';
const decoderModule = '\0decoder-wasm';

// The decoder file is always beside the file importing it
const decoderPaths = id => (id === path.resolve(process.cwd(), decoderOutput) ? './' + path.basename(decoderOutput) : id);

function decoderPlugin(isExternal) {
    return {
        name: 'decoder-wasm',
        resolveId(source) {
            if (source === decoderModule) {
                return source;
            }
            if (/(^|\/)DecoderWasmBinary$/.test(source)) {
                // In its own file beside the library, or inlined when the module format has no dynamic import
                return isExternal ? { id: path.resolve(process.cwd(), decoderOutput), external: true } : decoderModule;
            }
        },
        load(id) {
            if (id === decoderModule) {
                this.addWatchFile(path.resolve(process.cwd(), decoderInput));
                return `export const DECODER_WASM = '${readFileSync(decoderInput).toString('base64')}';`;
            }
        }
    };
}

export default args => {
    // Determine the package version by using the 'version' environment variable (for CI/CD processes) or fallback to the version specified in the 'package.json' file.
    const version = process.env.version ?? process.env.npm_package_version;
    // Validate the version format
    if (typeof version !== 'string') {
        throw new Error('Version is undefined or not a string.');
    }
    // https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
    const versionRegex =
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
    if (!versionRegex.test(version)) {
        throw new Error(
            'The provided version string does not comply with the Semantic Versioning (SemVer) format required. Please refer to https://semver.org/ for more details on the SemVer specification.'
        );
    }
    if (!args.target) {
        // ES6 by default
        args.target = 'es6';
    }
    console.info(`Building${args.format ? ' ' + args.format : ''} in ${args.target} version ${version}`);

    const ts = typescript({ target: args.target });
    delete args.target; // remove the target argument because it not valid for rollup

    // ES and CommonJS modules load the decoder from its own file, the other formats embed it
    const isDecoderExternal = !args.format || ['es', 'esm', 'module', 'cjs', 'commonjs'].includes(args.format);

    function createOutput(input, outputName, isExternal) {
        return {
            input,
            output: [
                {
                    // normal
                    name,
                    format: args.format, // iife, es, cjs, umd, amd, system
                    compact: true,
                    sourcemap: true,
                    inlineDynamicImports: !isDecoderExternal,
                    paths: decoderPaths,
                    file: outputName + '.js'
                },
                {
                    // minified
                    name,
                    format: args.format, // iife, es, cjs, umd, amd, system
                    compact: true,
                    sourcemap: true,
                    inlineDynamicImports: !isDecoderExternal,
                    paths: decoderPaths,
                    plugins: [terser()],
                    file: outputName + '.min.js'
                }
            ],
            plugins: [
                decoderPlugin(isDecoderExternal),
                replacer({
                    __lib__version__: "'" + version + "'",
                    preventAssignment: true
                }),
                eslint(),
                ts,
                commonjs(),
                nodeResolve()
            ],
            external: isExternal ?? []
        };
    }

    return [
        // Generate type definitions
        {
            input,
            output: {
                compact: true,
                file: output + '.d.ts'
            },
            plugins: [dts()]
        },
        // NPM binaries
        createOutput(input, output, id => {
            const resolvedEntry = path.resolve(process.cwd(), input);
            // We return isExternal=true only for modules import
            return (
                !id.startsWith('.') && // is not a relative import (our sources)
                !id.startsWith('/') &&
                id !== resolvedEntry && // is not an absolute import
                id !== 'index.ts'
            ); // special case: is not our main index.ts file
        }),
        // Browser binaries
        createOutput(input, output + '.bundle'),
        // WebAssembly audio decoder
        ...(isDecoderExternal
            ? [
                  {
                      input: decoderModule,
                      output: { format: args.format, compact: true, file: decoderOutput },
                      plugins: [decoderPlugin(false)]
                  }
              ]
            : [])
    ];
};
