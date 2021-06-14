import {Loader, OnLoadArgs, OnLoadResult, OnResolveArgs, Plugin} from "esbuild";
import {promises as fsp, readFileSync, Stats} from "fs";
import {dirname, resolve} from "path";
import picomatch from "picomatch";
import {CachedResult, SassPluginOptions} from "./index";
import {loadSass} from "./utils";
import {createSassImporter} from "./importer";

const cssTextModule = cssText => `\
export default \`
${cssText.replace(/([$`\\])/g, "\\$1")}\`;
`;

const cssResultModule = cssText => `\
import {css} from "lit-element";
export default css\`
${cssText.replace(/([$`\\])/g, "\\$1")}\`;
`;

const styleModule = cssText => `\
document.head
    .appendChild(document.createElement("style"))
    .appendChild(document.createTextNode(\`
${cssText.replace(/([$`\\])/g, "\\$1")}\`));
`;

function makeModule(contents: string, type: string) {
    if (type === "style") {
        return styleModule(contents);
    } else {
        return type === "lit-css" ? cssResultModule(contents) : cssTextModule(contents);
    }
}

/**
 *
 * @param options
 */
export function sassPlugin(options: SassPluginOptions = {}): Plugin {

    if (!options.basedir) {
        options.basedir = process.cwd();
    }
    if (!options.picomatch) {
        options.picomatch = {unixify: true};
    }

    const sass = loadSass(options);

    const type: string = typeof options.type === "string" ? options.type : "css";

    const matchers: [string, (args: OnResolveArgs) => boolean][] | false = Array.isArray(options.type)
        && options.type.map(function ([type, pattern]) {
            if (Array.isArray(pattern)) {
                const importerMatcher = picomatch("**/" + pattern[0], options.picomatch);
                const pathMatcher = pattern[1] ? picomatch("**/" + pattern[1], options.picomatch) : null;
                if (pathMatcher) {
                    return [
                        type, (args: OnResolveArgs) => importerMatcher(args.importer) && pathMatcher(resolve(args.resolveDir, args.path))
                    ];
                } else {
                    return [
                        type, (args: OnResolveArgs) => importerMatcher(args.importer)
                    ];
                }
            } else {
                if (pattern) {
                    const pathMatcher = picomatch("**/" + pattern, options.picomatch);
                    return [type, (args: OnResolveArgs) => pathMatcher(resolve(args.resolveDir, args.path))];
                } else {
                    return [type, () => true];
                }
            }
        });

    const typeOf = matchers
        ? (args: OnResolveArgs) => {
            for (const [type, isMatch] of matchers) if (isMatch(args)) {
                return type;
            }
            return type;
        }
        : () => type;

    function pathResolve({resolveDir, path, importer}: OnResolveArgs) {
        return resolve(resolveDir || dirname(importer), path);
    }

    function requireResolve({resolveDir, path, importer}: OnResolveArgs) {
        if (!resolveDir) {
            resolveDir = dirname(importer);
        }
        const paths = options.includePaths ? [resolveDir, ...options.includePaths] : [resolveDir];
        return require.resolve(path, {paths});
    }

    function readCssFileSync(path: string) {
        return {css: readFileSync(path, "utf-8"), watchFiles: [path]};
    }

    const importer = createSassImporter(options);

    function renderSync(file) {
        const {
            css,
            stats: {
                includedFiles
            }
        } = sass.renderSync({importer, ...options, file});
        return {
            css: css.toString("utf-8"),
            watchFiles: includedFiles
        };
    }

    const cache = !options.cache
        ? null
        : options.cache instanceof Map
            ? options.cache
            : new Map<string, Map<string, CachedResult>>();

    function collectStats(watchFiles):Promise<Stats[]> {
        return Promise.all(watchFiles.map(filename => fsp.stat(filename)));
    }

    function maxMtimeMs(stats: Stats[]) {
        return stats.reduce((max, {mtimeMs}) => Math.max(max, mtimeMs), 0);
    }

    function useExclude(callback) {
        const exclude = options.exclude;
        if (exclude) {
            return (args: OnResolveArgs) => exclude.test(args.path) ? null : callback(args)
        } else {
            return callback
        }
    }

    return {
        name: "sass-plugin",
        setup: function (build) {

            build.onResolve({filter: /\.(s[ac]ss|css)$/}, useExclude((args) => {
                return {path: args.path, namespace: "sass", pluginData: args};
            }));

            let cached: (
                resolve: (args: OnResolveArgs) => string,
                transform: (filename: string, type: string) => Promise<OnLoadResult>
            ) => (args) => Promise<OnLoadResult>;

            if (cache) {
                cached = (resolve, transform) => async ({pluginData: args}: OnLoadArgs) => {
                    let group = cache.get(args.resolveDir);
                    if (!group) {
                        group = new Map();
                        cache.set(args.resolveDir, group);
                    }
                    let cached = group.get(args.path);
                    if (cached) {
                        let watchFiles = cached.result.watchFiles!;
                        let stats = await collectStats(watchFiles);
                        for (const {mtimeMs} of stats) {
                            if (mtimeMs > cached.mtimeMs) {
                                cached.result = await transform(watchFiles[0], cached.type);
                                cached.mtimeMs = maxMtimeMs(stats);
                                break;
                            }
                        }
                        return cached.result;
                    }
                    let filename = resolve(args);
                    let type = typeOf(args);
                    let result = await transform(filename, type);
                    group.set(args.path, {
                        type,
                        mtimeMs: maxMtimeMs(await collectStats(result.watchFiles)),
                        result
                    });
                    return result;
                };
            } else {
                cached = (resolve, transform) => ({pluginData: args}: OnLoadArgs) => {
                    return transform(resolve(args), typeOf(args));
                };
            }

            async function transform(path: string, type: string): Promise<OnLoadResult> {
                let {css, watchFiles} = path.endsWith(".css") ? readCssFileSync(path) : renderSync(path);
                if (options.transform) {
                    css = await options.transform(css, dirname(path));
                }
                return type === "css" ? {
                    contents: css,
                    loader: "css" as Loader,
                    resolveDir: dirname(path),
                    watchFiles
                } : {
                    contents: makeModule(css, type),
                    loader: "js" as Loader,
                    resolveDir: dirname(path),
                    watchFiles
                };
            }

            build.onLoad({filter: /^\.\.?\//, namespace: "sass"}, cached(pathResolve, transform));
            build.onLoad({filter: /^([^.]|\.\.?[^/])/, namespace: "sass"}, cached(requireResolve, transform));
        }
    };
}
