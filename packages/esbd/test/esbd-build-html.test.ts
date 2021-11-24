import { node } from 'execa';
import fs from 'fs';
import path from 'path';

import { EsbdConfig } from '../lib';

import { BuildWithHTMLOutput } from './types';

interface BuildWithHTMLOptions {
  config: Partial<EsbdConfig>;
  files: { [file: string]: string };
}

async function buildWithHTML(options: BuildWithHTMLOptions): Promise<BuildWithHTMLOutput> {
  await fs.promises.mkdir(path.join(__dirname, 'tests'), { recursive: true });
  const absWorkingDir = await fs.promises.mkdtemp(path.join(__dirname, 'tests', 'test-'));
  const absOutDir = path.join(absWorkingDir, 'out');

  await fs.promises.mkdir(absOutDir, { recursive: true });

  const index = Object.keys(options.files).find(file => file.endsWith('index.html'));
  if (!index) {
    throw new Error('index.html is required');
  }

  const config: EsbdConfig = {
    format: 'esm',
    metafile: true,
    splitting: true,
    sourcemap: false,
    ...options.config,

    absWorkingDir,
    outdir: './out',
    entryPoints: {
      'index.html': index,
    },
  };

  const bundleFile = path.join(absWorkingDir, 'bundle.js');
  const writeBundle = fs.promises.writeFile(
    bundleFile,
    `require('../../../lib').bundle(${JSON.stringify(config)});`,
  );

  const writeFiles = Object.entries(options.files).map(async ([file, content]) => {
    const absFilePath = path.join(absWorkingDir, file);
    await fs.promises.mkdir(path.dirname(absFilePath), { recursive: true });
    await fs.promises.writeFile(absFilePath, content, { encoding: 'utf-8' });
  });

  await Promise.all([...writeFiles, writeBundle]);

  const proc = node(bundleFile, {
    encoding: 'utf8',
    reject: false,
    cwd: absWorkingDir,
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  const { stderr, stdout } = await proc;

  return { outdir: absOutDir, stdout, stderr };
}

describe('build command', () => {
  afterAll(async () => {
    await fs.promises.rm(path.join(__dirname, 'tests'), { recursive: true });
  });

  it('builds a simple HTML entry point', () => {
    return expect(
      buildWithHTML({
        config: {
          external: ['react', 'react-dom'],
        },
        files: {
          'src/index.html': `
            <!DOCTYPE html>
            <html>
              <head>
                <script defer type="module" src="./entry.tsx"></script>
              </head>
              <body><div id='root'></div></body>
            </html>
          `,
          'src/entry.tsx': `
            import ReactDOM from 'react';
            import { App } from './app';
            ReactDOM.render(<App />, document.getElementById('root'));
          `,
          'src/app.tsx': `
            export function App() {
              return <div>Hello world</div>;
            }
          `,
        },
      }),
    ).resolves.toMatchSnapshot();
  });

  it('includes referenced CSS from HTML', () => {
    return expect(
      buildWithHTML({
        config: {
          external: ['react', 'react-dom'],
        },
        files: {
          'src/index.html': `
            <!DOCTYPE html>
            <html>
              <head>
                <link rel="stylesheet" href="../styles/entry.css" />
                <script defer type="module" src="./entry.tsx"></script>
              </head>
              <body><div id='root'></div></body>
            </html>
          `,
          'styles/entry.css': `
            @import "./app.css";
            body { background: red; }
          `,
          'styles/app.css': `
            .app { background: green; }
          `,
          'src/entry.tsx': `
            import ReactDOM from 'react';
            import { App } from './app';
            ReactDOM.render(<App />, document.getElementById('root'));
          `,
          'src/app.tsx': `
            export function App() {
              return <div>Hello world</div>;
            }
          `,
        },
      }),
    ).resolves.toMatchSnapshot();
  });

  it('includes referenced CSS from JS', () => {
    return expect(
      buildWithHTML({
        config: {
          external: ['react', 'react-dom'],
        },
        files: {
          'index.html': `
            <!DOCTYPE html>
            <html>
              <head>
                <script defer type="module" src="./src/entry.tsx"></script>
              </head>
              <body><div id='root'></div></body>
            </html>
          `,
          'src/entry.css': `
            @import "./app.css";
            body { background: red; }
          `,
          'src/app.css': `
            .app { background: green; }
          `,
          'src/entry.tsx': `
            import ReactDOM from 'react';
            import { App } from './app';
            import './entry.css';
            ReactDOM.render(<App />, document.getElementById('root'));
          `,
          'src/app.tsx': `
            export function App() {
              return <div>Hello world</div>;
            }
          `,
        },
      }),
    ).resolves.toMatchSnapshot();
  });

  it('includes referenced assets from HTML', () => {
    return expect(
      buildWithHTML({
        config: {
          external: ['react', 'react-dom'],
        },
        files: {
          'index.html': `
            <!DOCTYPE html>
            <html>
              <head>
                <link rel="apple-touch-icon" href="./assets/favicon.png"/>
                <script defer type="module" src="./src/entry.tsx"></script>
              </head>
              <body><div id='root'></div></body>
            </html>
          `,
          'assets/favicon.png': 'IMA FAVICON',
          'src/entry.tsx': `
            import ReactDOM from 'react';
            function App() { return <div>Hello world</div>; }
            ReactDOM.render(<App />, document.getElementById('root'));
          `,
        },
      }),
    ).resolves.toMatchSnapshot();
  });

  it('includes referenced assets from style tags', () => {
    return expect(
      buildWithHTML({
        config: {
          external: ['react', 'react-dom'],
        },
        files: {
          'src/index.html': `
            <!DOCTYPE html>
            <html>
              <head>
                <style>
                  body {
                    background: url(../assets/cats.jpg);
                  }
                </style>
                <script defer type="module" src="./entry.tsx"></script>
              </head>
              <body><div id='root'></div></body>
            </html>
          `,
          'assets/cats.jpg': 'MEOW',
          'src/entry.tsx': `
            import ReactDOM from 'react';
            function App() { return <div>Hello world</div>; }
            ReactDOM.render(<App />, document.getElementById('root'));
          `,
        },
      }),
    ).resolves.toMatchSnapshot();
  });

  it('supports automatic react runtime', () => {
    return expect(
      buildWithHTML({
        config: {
          external: ['react', 'react-dom'],
          jsxRuntime: 'automatic',
        },
        files: {
          'src/index.html': `
            <!DOCTYPE html>
            <html>
              <head>
                <script defer type="module" src="./entry.tsx"></script>
              </head>
              <body><div id='root'></div></body>
            </html>
          `,
          'src/entry.tsx': `
            import ReactDOM from 'react';
            import { App } from './app';
            ReactDOM.render(<App />, document.getElementById('root'));
          `,
          'src/app.tsx': `
            export function App() {
              return <div>Hello world</div>;
            }
          `,
        },
      }),
    ).resolves.toMatchSnapshot();
  });

  it('writes integrity hashes if requested', () => {
    return expect(
      buildWithHTML({
        config: {
          external: ['react', 'react-dom'],
          integrity: 'sha256',
        },
        files: {
          'src/index.html': `
            <!DOCTYPE html>
            <html>
              <head>
                <style>
                  body {
                    background: url(../assets/cats.jpg);
                  }
                </style>
                <link rel="apple-touch-icon" href="../assets/favicon.png"/>
                <link rel="stylesheet" href="../styles/entry.css" />
                <script defer type="module" src="./entry.tsx"></script>
              </head>
              <body><div id='root'></div></body>
            </html>
          `,
          'assets/cats.jpg': 'MEOW',
          'assets/favicon.png': 'IMA FAVICON',
          'src/entry.tsx': `
            import ReactDOM from 'react';
            function App() { return <div>Hello world</div>; }
            ReactDOM.render(<App />, document.getElementById('root'));
          `,
          'styles/entry.css': `
            body { background: red; }
          `,
        },
      }),
    ).resolves.toMatchSnapshot();
  });
});