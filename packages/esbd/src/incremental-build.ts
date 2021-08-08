import { watch } from 'chokidar';
import {
  build,
  BuildIncremental,
  BuildInvalidate,
  BuildOptions,
  BuildResult,
  Metafile,
  OutputFile,
} from 'esbuild';
import { EventEmitter } from 'events';

interface BuildIncrementalResult extends BuildIncremental {
  metafile: Metafile;
  outputFiles: OutputFile[];
}

function validateResult(result: BuildResult): asserts result is BuildIncrementalResult {
  if (!result.metafile) throw new Error('incrementalBuild: "metafile" option must be "true"');
  if (!result.outputFiles) throw new Error('incrementalBuild: "write" option must be "false"');
  if (!result.rebuild) throw new Error('incrementalBuild: "incremental" option must be "true"');
}

type BuildIncrementalOptions = BuildOptions & { incremental: true; metafile: true; write: false };

interface IncrementalBuildOptions extends BuildIncrementalOptions {
  absWorkingDir: string;
  onBuildResult: (
    result: BuildIncrementalResult,
    options: BuildIncrementalOptions,
  ) => Promise<void> | void;
  onWatchEvent: (event: string, path: string) => Promise<void> | void;
}

interface IncrementalBuildResult extends BuildIncrementalResult {
  wait(): Promise<void>;
}

const NULL_RESULT: Omit<BuildIncrementalResult, 'rebuild'> = {
  errors: [],
  warnings: [],
  metafile: { inputs: {}, outputs: {} },
  outputFiles: [],
};

export async function incrementalBuild({
  onBuildResult,
  onWatchEvent,
  ...options
}: IncrementalBuildOptions): Promise<IncrementalBuildResult> {
  let rebuild = (() => build(options)) as BuildInvalidate;
  let running = false;

  const basedir = options.absWorkingDir;
  const evt = new EventEmitter();
  const watchedInputs = new Set<string>();
  const watchedModules = new Set<string>();

  const inputWatcher = watch([], {
    cwd: basedir,
    disableGlobbing: true,
    ignored: ['**/node_modules/**', '*.tsbuildinfo'],
  });

  const moduleWatcher = watch([], {
    cwd: basedir,
    depth: 2,
    disableGlobbing: true,
    interval: 2000,
    usePolling: true,
  });

  function onInputEvent(event: string, path: string) {
    if (running) return;
    Promise.resolve(onWatchEvent(event, path))
      .then(triggerBuild)
      .catch(e => console.error(e));
  }

  function onModuleEvent(path: string) {
    if (running) return;
    Promise.resolve(onWatchEvent('change', path))
      .then(triggerBuild)
      .catch(e => console.error(e));
  }

  function startWatchers() {
    setTimeout(() => {
      if (running) return;
      inputWatcher.once('all', onInputEvent);
      moduleWatcher.once('change', onModuleEvent);
    }, 100);
  }

  async function triggerBuild() {
    running = true;
    await inputWatcher.close();
    await moduleWatcher.close();

    let result: BuildIncremental;
    try {
      result = await rebuild();
      validateResult(result);
      await onBuildResult(result, options);
    } catch {
      evt.emit('end');
      running = false;
      startWatchers();
      return { ...NULL_RESULT, rebuild };
    }

    const addedInputs = new Set<string>();
    const addedModules = new Set<string>();
    const removedInputs: string[] = [];
    const removedModules: string[] = [];

    const inputs = Object.keys(result.metafile.inputs);
    for (const inputKey of inputs) {
      const input = inputKey.includes(':') ? inputKey.split(':')[1] : inputKey;

      const index = input.indexOf('node_modules');
      if (index >= 0) {
        // For paths in node_modules, we don't want to watch each file individually,
        // so try to find the first level of depth after the first "node_modules/".
        // E.g., "../node_modules/some-library/"
        const modIndex = input.indexOf('/', index + 'node_modules'.length + 1);
        if (modIndex > 0) {
          const mod = input.slice(0, modIndex);
          if (!watchedModules.has(mod)) addedModules.add(mod);
        }
      } else {
        // For source files, watch each file individually
        if (!watchedInputs.has(input)) addedInputs.add(input);
      }
    }

    watchedInputs.forEach(input => {
      if (!addedInputs.has(input)) removedInputs.push(input);
    });
    watchedModules.forEach(mod => {
      if (!addedModules.has(mod)) removedModules.push(mod);
    });

    inputWatcher.unwatch(removedInputs);
    moduleWatcher.unwatch(removedModules);

    inputWatcher.add(Array.from(addedInputs));
    moduleWatcher.add(Array.from(addedModules));

    evt.emit('end');

    running = false;
    rebuild = result.rebuild;
    startWatchers();

    return result;
  }

  triggerBuild.dispose = async () => {
    rebuild.dispose();
    await inputWatcher.close();
    await moduleWatcher.close();
  };

  function wait(): Promise<void> {
    if (!running) return Promise.resolve();
    return new Promise(resolve => {
      evt.once('end', resolve);
    });
  }

  const initialResult = await triggerBuild();
  validateResult(initialResult);

  return { ...initialResult, rebuild: triggerBuild, wait };
}