/**
 * The built screens: redirects, the files themselves with their headers, and
 * everything a path can try — a directory without its slash, a file that is
 * not there, an escape out of the directory, a malformed escape.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPS = path.resolve(HERE, '../../..');
const mounts = [['/console', 'console/dist'], ['/docs', 'docs/dist'], ['/playground', 'playground/dist']].filter(([, dir]) => existsSync(path.join(APPS, dir)));

/** A few files of every kind there is, and a directory, out of a built screen. */
function sample(dir) {
  const files = []; const dirs = [];
  const walk = (rel, depth) => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const child = path.posix.join(rel, name);
      if (statSync(path.join(dir, child)).isDirectory()) { dirs.push(child); if (depth < 3) walk(child, depth + 1); } else files.push(child);
    }
  };
  walk('', 0);
  const perKind = new Map();
  for (const f of files) {
    const ext = path.extname(f).toLowerCase() || '(none)';
    if ((perKind.get(ext) ?? []).length < 2) perKind.set(ext, [...(perKind.get(ext) ?? []), f]);
  }
  return { files: [...perKind.values()].flat(), dirs: dirs.slice(0, 3) };
}

export default () => {
  const cases = [
    { target: '/' }, { method: 'HEAD', target: '/' }, { method: 'POST', target: '/' }, { method: 'DELETE', target: '/' }, { target: '/?lang=en' }, { target: "/?a='b'&c=d e".replace(' ', '%20') },
    { target: '/consolex' }, { target: '/console-old/' }, { target: '/docsx/y' },
  ];
  for (const [mount, dir] of mounts) {
    const { files, dirs } = sample(path.join(APPS, dir));
    cases.push({ target: mount }, { target: `${mount}?lang=ko` }, { target: `${mount}/` }, { method: 'HEAD', target: `${mount}/` }, { target: `${mount}/index.html` },
      { method: 'POST', target: `${mount}/` }, { method: 'PUT', target: `${mount}/index.html` }, { method: 'OPTIONS', target: `${mount}/` },
      { target: `${mount}/nope.js` }, { target: `${mount}/nope/` }, { target: `${mount}//index.html` }, { target: `${mount}/./index.html` },
      { target: `${mount}/../healthz` }, { target: `${mount}/..%2f..%2f..%2fetc%2fpasswd` }, { target: `${mount}/..%2Findex.html` }, { target: `${mount}/%2e%2e/x` },
      { target: `${mount}/%E0` }, { target: `${mount}/%zz` }, { target: `${mount}/%00` }, { target: `${mount}/index.html%00.js` }, { target: `${mount}/index.html/` },
      { target: `${mount}/INDEX.HTML` }, { target: `${mount}/index.html?v=1` }, { target: `${mount}/a%20b.txt` }, { target: `${mount}/%69ndex.html` });
    for (const f of files) cases.push({ target: `${mount}/${f.split('/').map(encodeURIComponent).join('/')}` }, { method: 'HEAD', target: `${mount}/${f.split('/').map(encodeURIComponent).join('/')}` });
    for (const d of dirs) cases.push({ target: `${mount}/${d}` }, { target: `${mount}/${d}/` }, { target: `${mount}/${d}?x=1` });
  }
  return cases;
};
