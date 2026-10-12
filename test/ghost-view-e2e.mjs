// Real Chromium + real three.js: two InstancedMeshes whose games stop
// writing some slots — one with the stale slots ON screen (ghosts), one
// with them behind the camera (culled instances left unwritten on purpose).
// The recorder learns the camera from three's renderer and must report the
// first as in view and the second as none in view (no incident).
// Run: node test/ghost-view-e2e.mjs [path/to/three] (~50 s).
import { attach } from '../src/attach.mjs';
import { createServer } from 'node:http';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const THREE = process.argv[2] ?? process.env.THREE_DIR ?? '/app/data/home/mecharoyale/node_modules/three';
if (!existsSync(join(THREE, 'build/three.module.js'))) { console.log(`SKIP no three.js at ${THREE} (pass its path)`); process.exit(0); }
const page = `<!doctype html><body style="margin:0"><script type="importmap">{"imports":{"three":"/three/three.module.js"}}</script>
<script type="module">
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.setSize(200, 150); document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 640 / 480, 0.1, 500);
camera.position.set(0, 0, 50);
const geo = new THREE.BoxGeometry(1, 1, 1), mat = new THREE.MeshBasicMaterial();
const mk = (name) => { const m = new THREE.InstancedMesh(geo, mat, 100); m.name = name; m.frustumCulled = false; scene.add(m); return m; };
const ghosts = mk('ghosts'), culled = mk('culled');
const o = new THREE.Object3D();
function place(mesh, i, x, y, z) { o.position.set(x, y, z); o.updateMatrix(); mesh.setMatrixAt(i, o.matrix); }
// Slots 80–99 are written once and never again: on screen for 'ghosts', behind the camera for 'culled'.
for (let i = 80; i < 100; i++) { place(ghosts, i, (i - 90) * 2, 5, 0); place(culled, i, (i - 90) * 2, 0, 200); }
let t = 0;
renderer.setAnimationLoop(() => {
  t += 0.02;
  for (let i = 0; i < 80; i++) { place(ghosts, i, Math.sin(t + i) * 20, -5, 0); place(culled, i, Math.cos(t + i) * 20, -10, 0); }
  ghosts.instanceMatrix.needsUpdate = true; culled.instanceMatrix.needsUpdate = true;
  renderer.render(scene, camera);
});
</script></body>`;
const server = createServer((req, res) => {
  if (req.url.startsWith('/three/')) { res.setHeader('content-type', 'text/javascript'); res.end(readFileSync(join(THREE, 'build', req.url.slice(7)))); return; }
  res.setHeader('content-type', 'text/html'); res.end(page);
}).listen(0);
const port = server.address().port;
const DIR = '/tmp/sloptimize-e2e-ghost-view';
rmSync(DIR, { recursive: true, force: true });
const s = await attach({ launch: `http://127.0.0.1:${port}/`, headless: true, port: 9345, dir: DIR, log: () => {} });
await new Promise((r) => setTimeout(r, 40000));
await s.close();
server.close();
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fail++; };
const recs = readFileSync(`${DIR}/perf.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'instance-slots');
const last = (n) => recs.filter((r) => r.name === n).at(-1);
console.log(`  ${recs.map((r) => `${r.name}: ${r.stale} stale, ${r.inView} in view`).join(' · ')}`);
check(last('ghosts')?.stale === 20 && last('ghosts')?.inView === 20, 'ghosts: 20 stale, all 20 in the camera\'s view');
check(last('culled')?.stale === 20 && last('culled')?.inView === 0, 'culled: 20 stale, none in view');
const issues = execFileSync(process.execPath, [fileURLToPath(new URL('../bin/sloptimize.mjs', import.meta.url)), 'issues', '--dir', DIR], { encoding: 'utf8' });
check(/instance slots drawn, not written · ghosts/.test(issues) && !/· culled/.test(issues), 'issues: the on-screen ghosts are an incident, the off-screen ones are not');
process.exit(fail ? 1 : 0);
