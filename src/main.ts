import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import './style.css';

type LL = { lat: number; lon: number };
type Way = { id: number; tags?: Record<string, string>; geometry?: LL[] };
type OSM = { elements?: Way[] };
type Segment = { a: THREE.Vector3; b: THREE.Vector3; width: number; main: boolean };

const BBOX = { s: 18.9162, w: 72.8138, n: 18.9634, e: 72.8366 };
const ORIGIN = { lat: 18.9398, lon: 72.8252 };
const OSM_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

const $ = <T extends Element>(q: string) => document.querySelector<T>(q)!;
const stage = $('#stage');
const loader = $('#loader');
const loaderBar = $('#loaderBar');
const loaderStatus = $('#loaderStatus');
const loaderPct = $('#loaderPct');
const speedEl = $('#speed');
const errorPanel = $('#errorPanel') as HTMLElement;
const errorText = $('#errorText');
$('#retryButton').addEventListener('click', () => location.reload());

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x7895a4);
scene.fog = new THREE.FogExp2(0x7895a4, 0.00072);
const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 6500);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xcbe5ef, 0x273321, 2.1));
const sun = new THREE.DirectionalLight(0xffefd1, 4);
sun.position.set(-450, 620, -280);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -750;
sun.shadow.camera.right = sun.shadow.camera.top = 750;
sun.shadow.camera.far = 1900;
scene.add(sun);

const root = new THREE.Group();
scene.add(root);
let physics: RAPIER.World;
let kartBody: RAPIER.RigidBody;
let kartMesh: THREE.Group;
let spawn = new THREE.Vector3(0, 1.4, 0);
let spawnYaw = 0;
let running = false;
const keys = new Set<string>();

addEventListener('keydown', (e) => { keys.add(e.code); if (e.code === 'KeyR') resetKart(); });
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('resize', resize);

function progress(pct: number, text: string) {
  (loaderBar as HTMLElement).style.width = `${pct}%`;
  loaderPct.textContent = `${pct}%`;
  loaderStatus.textContent = text;
}

function worldPoint(p: LL) {
  const x = (p.lon - ORIGIN.lon) * 111_320 * Math.cos(THREE.MathUtils.degToRad(ORIGIN.lat));
  const z = -(p.lat - ORIGIN.lat) * 110_540;
  return new THREE.Vector3(x, 0, z);
}

function widthFor(type = '') {
  if (['motorway', 'trunk'].includes(type)) return 13.5;
  if (type === 'primary') return 11;
  if (type === 'secondary') return 9;
  if (type === 'tertiary') return 7.5;
  if (['residential', 'unclassified'].includes(type)) return 6.2;
  return 5;
}

function drivable(type = '') {
  return !['footway', 'path', 'cycleway', 'steps', 'pedestrian', 'bridleway', 'construction', 'proposed'].includes(type);
}

async function loadOsm(): Promise<OSM> {
  const q = `[out:json][timeout:25];(way["highway"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});way["building"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e}););out geom tags;`;
  let last: unknown;
  for (const endpoint of OSM_ENDPOINTS) {
    try {
      const r = await fetch(`${endpoint}?data=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`OSM ${r.status}`);
      const data = await r.json() as OSM;
      if (!data.elements?.length) throw new Error('OSM returned no geometry');
      return data;
    } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error('OSM unavailable');
}

function parse(data: OSM) {
  const roads: Segment[] = [];
  const buildings: { c: THREE.Vector3; sx: number; sz: number; h: number; color: THREE.Color }[] = [];
  let longest: { pts: THREE.Vector3[]; len: number } | undefined;

  for (const way of data.elements ?? []) {
    if (!way.geometry || way.geometry.length < 2) continue;
    if (way.tags?.highway && drivable(way.tags.highway)) {
      const pts = way.geometry.map(worldPoint);
      const w = widthFor(way.tags.highway);
      const mainRoad = ['motorway', 'trunk', 'primary', 'secondary'].includes(way.tags.highway);
      let len = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const d = pts[i].distanceTo(pts[i + 1]);
        if (d < 1.2 || d > 250) continue;
        len += d;
        roads.push({ a: pts[i], b: pts[i + 1], width: w, main: mainRoad });
      }
      if (!longest || len > longest.len) longest = { pts, len };
    } else if (way.tags?.building && way.geometry.length >= 4) {
      const box = new THREE.Box3().setFromPoints(way.geometry.map(worldPoint));
      const size = box.getSize(new THREE.Vector3());
      if (size.x < 2 || size.z < 2 || size.x > 130 || size.z > 130) continue;
      const c = box.getCenter(new THREE.Vector3());
      const levels = Number(way.tags['building:levels'] ?? 0);
      const hash = Math.abs(Math.sin(way.id * 12.9898));
      const h = levels > 0 ? Math.min(levels * 3.1, 90) : 9 + hash * 23;
      buildings.push({ c, sx: size.x, sz: size.z, h, color: new THREE.Color().setHSL(0.09 + hash * 0.03, 0.12, 0.59 + hash * 0.07) });
    }
  }

  if (!longest || !roads.length) throw new Error('No drivable roads found');
  const i = Math.max(0, Math.floor(longest.pts.length / 2) - 1);
  const a = longest.pts[i], b = longest.pts[Math.min(i + 1, longest.pts.length - 1)];
  spawn = a.clone().lerp(b, 0.5).setY(1.4);
  spawnYaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
  return { roads, buildings };
}

function segmentMatrix(a: THREE.Vector3, b: THREE.Vector3, width: number, height: number, y: number) {
  const o = new THREE.Object3D();
  o.position.copy(a).lerp(b, 0.5).setY(y);
  o.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
  o.scale.set(width, height, a.distanceTo(b));
  o.updateMatrix();
  return o.matrix;
}

function buildCity(roads: Segment[], buildings: ReturnType<typeof parse>['buildings']) {
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4200, 6200), new THREE.MeshStandardMaterial({ color: 0x4a5847, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.07; ground.receiveShadow = true; root.add(ground);
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(1700, 6200), new THREE.MeshPhysicalMaterial({ color: 0x34687c, roughness: 0.25, clearcoat: 0.6 }));
  sea.rotation.x = -Math.PI / 2; sea.position.set(-1050, -0.02, 0); root.add(sea);

  const cube = new THREE.BoxGeometry(1, 1, 1);
  const shoulder = new THREE.InstancedMesh(cube, new THREE.MeshStandardMaterial({ color: 0xa89e89, roughness: 0.95 }), roads.length);
  const asphalt = new THREE.InstancedMesh(cube, new THREE.MeshStandardMaterial({ color: 0x2e3336, roughness: 0.78 }), roads.length);
  roads.forEach((r, i) => { shoulder.setMatrixAt(i, segmentMatrix(r.a, r.b, r.width + 3.4, .1, .015)); asphalt.setMatrixAt(i, segmentMatrix(r.a, r.b, r.width, .12, .08)); });
  shoulder.instanceMatrix.needsUpdate = asphalt.instanceMatrix.needsUpdate = true;
  shoulder.receiveShadow = asphalt.receiveShadow = true;
  root.add(shoulder, asphalt);

  if (buildings.length) {
    const mesh = new THREE.InstancedMesh(cube, new THREE.MeshStandardMaterial({ roughness: .86 }), buildings.length);
    const o = new THREE.Object3D();
    buildings.forEach((b, i) => { o.position.set(b.c.x, b.h / 2, b.c.z); o.scale.set(b.sx, b.h, b.sz); o.updateMatrix(); mesh.setMatrixAt(i, o.matrix); mesh.setColorAt(i, b.color); });
    mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = mesh.receiveShadow = true; root.add(mesh);
  }

  const dashes: THREE.Matrix4[] = [];
  roads.filter(r => r.main).forEach(r => {
    const v = r.b.clone().sub(r.a), len = v.length(); if (len < 8) return; v.normalize();
    for (let d = 5; d < len - 2; d += 11) {
      const p = r.a.clone().addScaledVector(v, d), o = new THREE.Object3D();
      o.position.set(p.x, .155, p.z); o.rotation.y = Math.atan2(v.x, v.z); o.scale.set(.13, .025, 3.6); o.updateMatrix(); dashes.push(o.matrix.clone());
    }
  });
  if (dashes.length) { const mesh = new THREE.InstancedMesh(cube, new THREE.MeshStandardMaterial({ color: 0xe7dfc8 }), dashes.length); dashes.forEach((m, i) => mesh.setMatrixAt(i, m)); mesh.instanceMatrix.needsUpdate = true; root.add(mesh); }
}

function createKart() {
  const g = new THREE.Group(), yellow = new THREE.MeshStandardMaterial({ color: 0xf0b12f, roughness: .42, metalness: .14 }), dark = new THREE.MeshStandardMaterial({ color: 0x171a1d, roughness: .5 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, p: [number, number, number]) => { const m = new THREE.Mesh(geo, mat); m.position.set(...p); m.castShadow = true; g.add(m); return m; };
  add(new THREE.BoxGeometry(1.55, .42, 2.65), yellow, [0, .42, 0]);
  add(new THREE.BoxGeometry(1.15, .26, .82), yellow, [0, .53, -1.55]);
  const seat = add(new THREE.BoxGeometry(.85, .82, .62), dark, [0, .78, .35]); seat.rotation.x = -.12;
  const wg = new THREE.CylinderGeometry(.34, .34, .28, 18);
  [[-.86,.31,-.92],[.86,.31,-.92],[-.86,.31,.93],[.86,.31,.93]].forEach(p => { const w = add(wg, dark, p as [number,number,number]); w.rotation.z = Math.PI / 2; });
  root.add(g); return g;
}

function setupPhysics() {
  physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const ground = physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -.55, 0));
  physics.createCollider(RAPIER.ColliderDesc.cuboid(2100, .5, 3100).setFriction(1.3), ground);
  kartBody = physics.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(spawn.x, spawn.y, spawn.z).setRotation({ x: 0, y: Math.sin(spawnYaw / 2), z: 0, w: Math.cos(spawnYaw / 2) }).setLinearDamping(.55).setAngularDamping(2.8));
  kartBody.setEnabledRotations(false, true, false, true);
  physics.createCollider(RAPIER.ColliderDesc.cuboid(.78, .38, 1.34).setTranslation(0, .48, 0).setFriction(1.1), kartBody);
}

function resetKart() {
  if (!kartBody) return;
  kartBody.setTranslation(spawn, true);
  kartBody.setRotation({ x: 0, y: Math.sin(spawnYaw / 2), z: 0, w: Math.cos(spawnYaw / 2) }, true);
  kartBody.setLinvel({ x: 0, y: 0, z: 0 }, true); kartBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
}

function drive() {
  const r = kartBody.rotation(), q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q).setY(0).normalize(), right = new THREE.Vector3(1, 0, 0).applyQuaternion(q).setY(0).normalize();
  const lv = kartBody.linvel(), v = new THREE.Vector3(lv.x, lv.y, lv.z), kmh = v.length() * 3.6, forwardSpeed = v.dot(f);
  const gas = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const steer = (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) - (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0);
  if (gas > 0 && kmh < 145) kartBody.addForce({ x: f.x * 1150, y: 0, z: f.z * 1150 }, true);
  else if (gas < 0) { const force = forwardSpeed > 1.2 ? -1500 : -620; kartBody.addForce({ x: f.x * force, y: 0, z: f.z * force }, true); }
  const lateral = v.dot(right), grip = kmh > 70 ? 82 : 118;
  kartBody.addForce({ x: -right.x * lateral * grip, y: -Math.min(750, kmh * 3.5), z: -right.z * lateral * grip }, true);
  if (steer && kmh > 1.5) kartBody.addTorque({ x: 0, y: steer * 58 * THREE.MathUtils.clamp(kmh / 18, .4, 2.2) * (forwardSpeed >= -.5 ? 1 : -1), z: 0 }, true);
  speedEl.textContent = String(Math.round(kmh)).padStart(3, '0');
  if (kartBody.translation().y < -3) resetKart();
}

function resize() { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75)); }
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame); const dt = Math.min(clock.getDelta(), .05);
  if (running) {
    drive(); physics.timestep = dt; physics.step();
    const p = kartBody.translation(), r = kartBody.rotation(); kartMesh.position.set(p.x, p.y, p.z); kartMesh.quaternion.set(r.x, r.y, r.z, r.w);
    const desired = kartMesh.position.clone().add(new THREE.Vector3(0, 4.6, 9.4).applyQuaternion(kartMesh.quaternion)); camera.position.lerp(desired, 1 - Math.exp(-dt * 4.4));
    camera.lookAt(kartMesh.position.clone().add(new THREE.Vector3(0, .75, -7).applyQuaternion(kartMesh.quaternion)));
  }
  renderer.render(scene, camera);
}
frame();

async function boot() {
  try {
    progress(7, 'Initialising WebGL'); await RAPIER.init();
    progress(18, 'Loading live OSM geometry'); const osm = await loadOsm();
    progress(48, 'Building real roads'); const city = parse(osm); buildCity(city.roads, city.buildings);
    progress(72, 'Preparing kart physics'); kartMesh = createKart(); setupPhysics(); kartMesh.position.copy(spawn);
    progress(92, `Optimising ${city.roads.length.toLocaleString()} road segments`); camera.position.copy(spawn).add(new THREE.Vector3(0, 5, 10)); camera.lookAt(spawn);
    progress(100, 'Ready'); running = true; setTimeout(() => loader.classList.add('is-done'), 180);
  } catch (e) {
    errorText.textContent = `${e instanceof Error ? e.message : String(e)}. Free public Overpass endpoints can occasionally rate-limit or time out.`;
    errorPanel.hidden = false; progress(100, 'OSM unavailable');
  }
}
void boot();
