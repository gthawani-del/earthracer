import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import './style.css';

type LL = { lat: number; lon: number };
type Tags = Record<string, string>;
type Way = { id: number; tags?: Tags; geometry?: LL[] };
type OSM = { elements?: Way[] };
type RoadWay = { id: number; tags: Tags; pts: THREE.Vector3[]; width: number; main: boolean; length: number };
type BuildingWay = { id: number; tags: Tags; pts: THREE.Vector3[] };

const BBOX = { s: 18.9220, w: 72.8145, n: 18.9585, e: 72.8370 };
const ORIGIN = { lat: 18.9410, lon: 72.8240 };
const MARINE_DRIVE_TARGET = worldPoint({ lat: 18.9448, lon: 72.8232 });
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
scene.background = new THREE.Color(0x8aa2ad);
scene.fog = new THREE.FogExp2(0x8aa2ad, 0.00056);

const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 6500);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.65));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.04;
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xd7edf5, 0x59604d, 2.25));
const sun = new THREE.DirectionalLight(0xffefd5, 3.6);
sun.position.set(-420, 620, -260);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -850;
sun.shadow.camera.right = sun.shadow.camera.top = 850;
sun.shadow.camera.far = 2000;
scene.add(sun);

const root = new THREE.Group();
scene.add(root);

let physics: RAPIER.World;
let kartBody: RAPIER.RigidBody;
let kartMesh: THREE.Group;
let spawn = new THREE.Vector3(0, 1.25, 0);
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
  if (['motorway', 'trunk'].includes(type)) return 14;
  if (type === 'primary') return 12;
  if (type === 'secondary') return 9.5;
  if (type === 'tertiary') return 8;
  if (['residential', 'living_street'].includes(type)) return 6.6;
  if (['unclassified', 'service'].includes(type)) return 5.4;
  return 4.8;
}

function drivable(type = '') {
  return !['footway', 'path', 'cycleway', 'steps', 'pedestrian', 'bridleway', 'construction', 'proposed', 'corridor'].includes(type);
}

function polylineLength(pts: THREE.Vector3[]) {
  let n = 0;
  for (let i = 0; i < pts.length - 1; i++) n += pts[i].distanceTo(pts[i + 1]);
  return n;
}

async function loadOsm(): Promise<OSM> {
  const q = `[out:json][timeout:30];(way["highway"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});way["building"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e}););out geom tags;`;
  let last: unknown;
  for (const endpoint of OSM_ENDPOINTS) {
    try {
      const r = await fetch(`${endpoint}?data=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`OSM ${r.status}`);
      const data = await r.json() as OSM;
      if (!data.elements?.length) throw new Error('OSM returned no geometry');
      return data;
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error('OSM unavailable');
}

function chooseSpawnRoad(roads: RoadWay[]) {
  let best: RoadWay | undefined;
  let bestScore = -Infinity;

  for (const road of roads) {
    const name = (road.tags.name ?? '').toLowerCase();
    const namedMarineDrive = name.includes('marine drive') || name.includes('netaji subhash chandra bose');
    const roadClass = road.tags.highway;
    const classScore = roadClass === 'primary' ? 350 : roadClass === 'secondary' ? 220 : roadClass === 'tertiary' ? 80 : 0;
    const minDist = Math.min(...road.pts.map((p) => p.distanceTo(MARINE_DRIVE_TARGET)));
    const score = (namedMarineDrive ? 5000 : 0) + classScore + Math.min(road.length, 1200) - minDist * 0.75;
    if (score > bestScore) {
      bestScore = score;
      best = road;
    }
  }

  if (!best) throw new Error('No suitable Marine Drive road found');

  let bestSegment = 0;
  let bestSegmentDist = Infinity;
  for (let i = 0; i < best.pts.length - 1; i++) {
    const mid = best.pts[i].clone().lerp(best.pts[i + 1], 0.5);
    const d = mid.distanceTo(MARINE_DRIVE_TARGET);
    if (d < bestSegmentDist) {
      bestSegmentDist = d;
      bestSegment = i;
    }
  }

  const a = best.pts[bestSegment];
  const b = best.pts[bestSegment + 1];
  spawn = a.clone().lerp(b, 0.5).setY(1.25);
  spawnYaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
}

function parse(data: OSM) {
  const roads: RoadWay[] = [];
  const buildings: BuildingWay[] = [];

  for (const way of data.elements ?? []) {
    if (!way.geometry || way.geometry.length < 2) continue;

    if (way.tags?.highway && drivable(way.tags.highway)) {
      const pts = way.geometry.map(worldPoint).filter((p, i, arr) => i === 0 || p.distanceTo(arr[i - 1]) > 0.25);
      if (pts.length < 2) continue;
      const length = polylineLength(pts);
      if (length < 2) continue;
      roads.push({
        id: way.id,
        tags: way.tags,
        pts,
        width: widthFor(way.tags.highway),
        main: ['motorway', 'trunk', 'primary', 'secondary'].includes(way.tags.highway),
        length
      });
    } else if (way.tags?.building && way.geometry.length >= 4) {
      const pts = way.geometry.map(worldPoint);
      buildings.push({ id: way.id, tags: way.tags, pts });
    }
  }

  if (!roads.length) throw new Error('No drivable streets found');
  chooseSpawnRoad(roads);
  return { roads, buildings };
}

function ribbonGeometry(pts: THREE.Vector3[], width: number, y: number) {
  const positions: number[] = [];
  const indices: number[] = [];
  const half = width / 2;

  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const tangent = next.clone().sub(prev).setY(0);
    if (tangent.lengthSq() < 0.0001) tangent.set(0, 0, 1);
    tangent.normalize();
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x);
    const left = pts[i].clone().addScaledVector(normal, half);
    const right = pts[i].clone().addScaledVector(normal, -half);
    positions.push(left.x, y, left.z, right.x, y, right.z);
  }

  for (let i = 0; i < pts.length - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

function addRoadLayer(roads: RoadWay[], extraWidth: number, y: number, material: THREE.Material) {
  const group = new THREE.Group();
  for (const road of roads) {
    const mesh = new THREE.Mesh(ribbonGeometry(road.pts, road.width + extraWidth, y), material);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  root.add(group);
}

function junctions(roads: RoadWay[], extraWidth: number, y: number, material: THREE.Material) {
  const nodes = new Map<string, { p: THREE.Vector3; r: number }>();
  for (const road of roads) {
    for (const p of road.pts) {
      const key = `${Math.round(p.x * 2)}:${Math.round(p.z * 2)}`;
      const radius = (road.width + extraWidth) / 2;
      const old = nodes.get(key);
      if (!old || old.r < radius) nodes.set(key, { p, r: radius });
    }
  }

  const geo = new THREE.CylinderGeometry(1, 1, 0.065, 14);
  const mesh = new THREE.InstancedMesh(geo, material, nodes.size);
  const o = new THREE.Object3D();
  let i = 0;
  for (const node of nodes.values()) {
    o.position.set(node.p.x, y, node.p.z);
    o.scale.set(node.r, 1, node.r);
    o.updateMatrix();
    mesh.setMatrixAt(i++, o.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.receiveShadow = true;
  root.add(mesh);
}

function addLaneMarkings(roads: RoadWay[]) {
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const matrices: THREE.Matrix4[] = [];

  for (const road of roads.filter((r) => r.main)) {
    for (let i = 0; i < road.pts.length - 1; i++) {
      const a = road.pts[i];
      const b = road.pts[i + 1];
      const v = b.clone().sub(a);
      const len = v.length();
      if (len < 5) continue;
      v.normalize();

      for (let d = 5; d < len - 1; d += 10) {
        const p = a.clone().addScaledVector(v, d);
        const o = new THREE.Object3D();
        o.position.set(p.x, 0.145, p.z);
        o.rotation.y = Math.atan2(v.x, v.z);
        o.scale.set(0.12, 0.025, Math.min(3.4, len - d));
        o.updateMatrix();
        matrices.push(o.matrix.clone());
      }
    }
  }

  if (!matrices.length) return;
  const mesh = new THREE.InstancedMesh(cube, new THREE.MeshStandardMaterial({ color: 0xf0ead7, roughness: 0.7 }), matrices.length);
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.instanceMatrix.needsUpdate = true;
  root.add(mesh);
}

function addBuildings(buildings: BuildingWay[]) {
  const material = new THREE.MeshStandardMaterial({ color: 0xc8c0ad, roughness: 0.86, metalness: 0.02 });
  const nearby = buildings
    .map((b) => {
      const box = new THREE.Box3().setFromPoints(b.pts);
      return { ...b, box, center: box.getCenter(new THREE.Vector3()) };
    })
    .filter((b) => {
      const size = b.box.getSize(new THREE.Vector3());
      return size.x > 2 && size.z > 2 && size.x < 120 && size.z < 120 && b.center.distanceTo(spawn) < 950;
    })
    .sort((a, b) => a.center.distanceTo(spawn) - b.center.distanceTo(spawn))
    .slice(0, 650);

  for (const b of nearby) {
    const outline = b.pts.slice(0, -1);
    if (outline.length < 3) continue;

    const shape = new THREE.Shape();
    outline.forEach((p, i) => {
      const sx = p.x;
      const sy = -p.z;
      if (i === 0) shape.moveTo(sx, sy);
      else shape.lineTo(sx, sy);
    });

    const levels = Number(b.tags['building:levels'] ?? 0);
    const hash = Math.abs(Math.sin(b.id * 12.9898));
    const h = levels > 0 ? THREE.MathUtils.clamp(levels * 3.05, 4, 82) : 8 + hash * 22;
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, steps: 1 });
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
}

function addPromenade() {
  const promenade = new THREE.Mesh(
    new THREE.PlaneGeometry(235, 4200),
    new THREE.MeshStandardMaterial({ color: 0xc9c0a9, roughness: 0.92 })
  );
  promenade.rotation.x = -Math.PI / 2;
  promenade.position.set(-560, -0.01, 0);
  root.add(promenade);
}

function buildCity(roads: RoadWay[], buildings: BuildingWay[]) {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(3600, 5200),
    new THREE.MeshStandardMaterial({ color: 0x69715f, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.09;
  ground.receiveShadow = true;
  root.add(ground);

  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(1800, 5400),
    new THREE.MeshPhysicalMaterial({ color: 0x356f83, roughness: 0.22, metalness: 0.05, clearcoat: 0.55 })
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(-1350, -0.035, 0);
  root.add(sea);

  addPromenade();

  const sidewalkMaterial = new THREE.MeshStandardMaterial({ color: 0xbeb6a2, roughness: 0.96 });
  const asphaltMaterial = new THREE.MeshStandardMaterial({ color: 0x303435, roughness: 0.81, metalness: 0.02 });

  addRoadLayer(roads, 3.4, 0.018, sidewalkMaterial);
  junctions(roads, 3.4, 0.048, sidewalkMaterial);
  addRoadLayer(roads, 0, 0.083, asphaltMaterial);
  junctions(roads, 0, 0.112, asphaltMaterial);

  addLaneMarkings(roads);
  addBuildings(buildings);
}

function createKart() {
  const g = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf0b12f, roughness: 0.42, metalness: 0.14 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x171a1d, roughness: 0.5 });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, p: [number, number, number]) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...p);
    m.castShadow = true;
    g.add(m);
    return m;
  };

  add(new THREE.BoxGeometry(1.55, 0.42, 2.65), yellow, [0, 0.42, 0]);
  add(new THREE.BoxGeometry(1.15, 0.26, 0.82), yellow, [0, 0.53, -1.55]);
  const seat = add(new THREE.BoxGeometry(0.85, 0.82, 0.62), dark, [0, 0.78, 0.35]);
  seat.rotation.x = -0.12;

  const wg = new THREE.CylinderGeometry(0.34, 0.34, 0.28, 18);
  [[-0.86,0.31,-0.92],[0.86,0.31,-0.92],[-0.86,0.31,0.93],[0.86,0.31,0.93]].forEach((p) => {
    const w = add(wg, dark, p as [number, number, number]);
    w.rotation.z = Math.PI / 2;
  });

  root.add(g);
  return g;
}

function setupPhysics() {
  physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const ground = physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.55, 0));
  physics.createCollider(RAPIER.ColliderDesc.cuboid(1800, 0.5, 2600).setFriction(1.3), ground);

  kartBody = physics.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setRotation({ x: 0, y: Math.sin(spawnYaw / 2), z: 0, w: Math.cos(spawnYaw / 2) })
      .setLinearDamping(0.55)
      .setAngularDamping(2.8)
  );

  kartBody.setEnabledRotations(false, true, false, true);
  physics.createCollider(
    RAPIER.ColliderDesc.cuboid(0.78, 0.38, 1.34).setTranslation(0, 0.48, 0).setFriction(1.1),
    kartBody
  );
}

function resetKart() {
  if (!kartBody) return;
  kartBody.setTranslation(spawn, true);
  kartBody.setRotation({ x: 0, y: Math.sin(spawnYaw / 2), z: 0, w: Math.cos(spawnYaw / 2) }, true);
  kartBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
  kartBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
}

function drive() {
  const r = kartBody.rotation();
  const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q).setY(0).normalize();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q).setY(0).normalize();
  const lv = kartBody.linvel();
  const v = new THREE.Vector3(lv.x, lv.y, lv.z);
  const kmh = v.length() * 3.6;
  const forwardSpeed = v.dot(f);

  const gas = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const steer = (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) - (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0);

  if (gas > 0 && kmh < 145) kartBody.addForce({ x: f.x * 1150, y: 0, z: f.z * 1150 }, true);
  else if (gas < 0) {
    const force = forwardSpeed > 1.2 ? -1500 : -620;
    kartBody.addForce({ x: f.x * force, y: 0, z: f.z * force }, true);
  }

  const lateral = v.dot(right);
  const grip = kmh > 70 ? 82 : 118;
  kartBody.addForce({ x: -right.x * lateral * grip, y: -Math.min(750, kmh * 3.5), z: -right.z * lateral * grip }, true);

  if (steer && kmh > 1.5) {
    kartBody.addTorque({
      x: 0,
      y: steer * 58 * THREE.MathUtils.clamp(kmh / 18, 0.4, 2.2) * (forwardSpeed >= -0.5 ? 1 : -1),
      z: 0
    }, true);
  }

  speedEl.textContent = String(Math.round(kmh)).padStart(3, '0');
  if (kartBody.translation().y < -3) resetKart();
}

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.65));
}

const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (running) {
    drive();
    physics.timestep = dt;
    physics.step();

    const p = kartBody.translation();
    const r = kartBody.rotation();
    kartMesh.position.set(p.x, p.y, p.z);
    kartMesh.quaternion.set(r.x, r.y, r.z, r.w);

    const desired = kartMesh.position.clone().add(new THREE.Vector3(0, 4.8, 10.2).applyQuaternion(kartMesh.quaternion));
    camera.position.lerp(desired, 1 - Math.exp(-dt * 4.6));
    camera.lookAt(kartMesh.position.clone().add(new THREE.Vector3(0, 0.78, -11).applyQuaternion(kartMesh.quaternion)));
  }

  renderer.render(scene, camera);
}

frame();

async function boot() {
  try {
    progress(7, 'Initialising WebGL');
    await RAPIER.init();

    progress(18, 'Loading Marine Drive street network');
    const osm = await loadOsm();

    progress(45, 'Building connected OSM streets');
    const city = parse(osm);
    buildCity(city.roads, city.buildings);

    progress(74, 'Snapping kart to Marine Drive');
    kartMesh = createKart();
    setupPhysics();
    kartMesh.position.copy(spawn);

    progress(92, `Loaded ${city.roads.length.toLocaleString()} street ways`);
    const spawnQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spawnYaw);
    camera.position.copy(spawn).add(new THREE.Vector3(0, 4.8, 10.2).applyQuaternion(spawnQ));
    camera.lookAt(spawn.clone().add(new THREE.Vector3(0, 0.78, -10).applyQuaternion(spawnQ)));

    progress(100, 'Ready');
    running = true;
    setTimeout(() => loader.classList.add('is-done'), 180);
  } catch (e) {
    errorText.textContent = `${e instanceof Error ? e.message : String(e)}. Free public Overpass endpoints can occasionally rate-limit or time out.`;
    errorPanel.hidden = false;
    progress(100, 'OSM unavailable');
  }
}

void boot();
