import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { FALLBACK_WAYS } from './fallbackMap';
import './style.css';

type LL = { lat: number; lon: number };
type Tags = Record<string, string>;
type Way = { id: number; tags?: Tags; geometry?: LL[] };
type OSM = { elements?: Way[] };
type RoadWay = { id: number; tags: Tags; pts: THREE.Vector3[]; width: number; main: boolean; length: number };
type BuildingWay = { id: number; tags: Tags; pts: THREE.Vector3[] };

const ROAD_BBOX = { s: 18.9220, w: 72.8145, n: 18.9585, e: 72.8370 };
const BUILDING_BBOX = { s: 18.9260, w: 72.8160, n: 18.9560, e: 72.8320 };
const ORIGIN = { lat: 18.9410, lon: 72.8240 };
const MARINE_DRIVE_TARGET = worldPoint({ lat: 18.9448, lon: 72.8232 });
const ASSET_BASE = 'https://raw.githubusercontent.com/gthawani-del/MumbaikartRacer/main/public/assets';
const ASSETS = {
  auto: `${ASSET_BASE}/mumbai-racing-auto.glb`,
  streetlight: `${ASSET_BASE}/streetlight.glb`,
  palm: `${ASSET_BASE}/palm-tree.glb`,
  environment: `${ASSET_BASE}/mumbai-environment-kit.glb`
};

const OSM_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

const $ = <T extends Element>(q: string) => document.querySelector<T>(q)!;
const stage = $('#stage');
const loader = $('#loader');
const loaderBar = $('#loaderBar');
const loaderStatus = $('#loaderStatus');
const loaderPct = $('#loaderPct');
const speedEl = $('#speed');
const mapStatus = $('#mapStatus');
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
const mapRoot = new THREE.Group();
root.add(mapRoot);
scene.add(root);

let physics: RAPIER.World;
let kartBody: RAPIER.RigidBody;
let kartMesh: THREE.Group;
let spawn = new THREE.Vector3(0, 1.25, 0);
let spawnYaw = 0;
let running = false;
let activeRoads: RoadWay[] = [];
let lastSafePosition = new THREE.Vector3();
let lastSafeYaw = 0;
let offRoadSeconds = 0;
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

function parseRoads(elements: Way[], setSpawn: boolean) {
  const roads: RoadWay[] = [];

  for (const way of elements) {
    if (!way.geometry || way.geometry.length < 2 || !way.tags?.highway || !drivable(way.tags.highway)) continue;
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
  }

  if (!roads.length) throw new Error('No drivable streets found');
  if (setSpawn) chooseSpawnRoad(roads);
  return roads;
}

function parseBuildings(elements: Way[]) {
  const buildings: BuildingWay[] = [];
  for (const way of elements) {
    if (!way.geometry || way.geometry.length < 4 || !way.tags?.building) continue;
    buildings.push({ id: way.id, tags: way.tags, pts: way.geometry.map(worldPoint) });
  }
  return buildings;
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

function overpassFetch(query: string, timeoutMs: number) {
  return Promise.any(OSM_ENDPOINTS.map(async (endpoint) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const r = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      if (!r.ok) throw new Error(`OSM ${r.status}`);
      const data = await r.json() as OSM;
      if (!data.elements?.length) throw new Error('OSM returned no geometry');
      return data;
    } finally {
      clearTimeout(timer);
    }
  }));
}

function loadLiveRoads() {
  const b = ROAD_BBOX;
  return overpassFetch(
    `[out:json][timeout:12];way["highway"](${b.s},${b.w},${b.n},${b.e});out geom tags;`,
    5000
  );
}

function loadLiveBuildings() {
  const b = BUILDING_BBOX;
  return overpassFetch(
    `[out:json][timeout:20];way["building"](${b.s},${b.w},${b.n},${b.e});out geom tags;`,
    10000
  );
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
  mapRoot.add(group);
}

function addJunctions(roads: RoadWay[], extraWidth: number, y: number, material: THREE.Material) {
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
  mapRoot.add(mesh);
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

  const mesh = new THREE.InstancedMesh(
    cube,
    new THREE.MeshStandardMaterial({ color: 0xf0ead7, roughness: 0.7 }),
    matrices.length
  );

  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.instanceMatrix.needsUpdate = true;
  mapRoot.add(mesh);
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
    .slice(0, 550);

  for (const b of nearby) {
    const outline = b.pts.slice(0, -1);
    if (outline.length < 3) continue;

    const shape = new THREE.Shape();
    outline.forEach((p, i) => {
      if (i === 0) shape.moveTo(p.x, -p.z);
      else shape.lineTo(p.x, -p.z);
    });

    const levels = Number(b.tags['building:levels'] ?? 0);
    const hash = Math.abs(Math.sin(b.id * 12.9898));
    const h = levels > 0 ? THREE.MathUtils.clamp(levels * 3.05, 4, 82) : 8 + hash * 22;
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, steps: 1 });
    geometry.rotateX(-Math.PI / 2);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mapRoot.add(mesh);
  }
}

function addBaseWorld() {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(3600, 5200),
    new THREE.MeshStandardMaterial({ color: 0x69715f, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.09;
  ground.receiveShadow = true;
  mapRoot.add(ground);

  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(1800, 5400),
    new THREE.MeshPhysicalMaterial({ color: 0x356f83, roughness: 0.22, metalness: 0.05, clearcoat: 0.55 })
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(-1350, -0.035, 0);
  mapRoot.add(sea);
}

function buildRoadWorld(roads: RoadWay[]) {
  activeRoads = roads;
  mapRoot.clear();
  addBaseWorld();

  const sidewalkMaterial = new THREE.MeshStandardMaterial({ color: 0xbeb6a2, roughness: 0.96 });
  const asphaltMaterial = new THREE.MeshStandardMaterial({ color: 0x303435, roughness: 0.81, metalness: 0.02 });

  addRoadLayer(roads, 3.4, 0.018, sidewalkMaterial);
  addJunctions(roads, 3.4, 0.048, sidewalkMaterial);
  addRoadLayer(roads, 0, 0.083, asphaltMaterial);
  addJunctions(roads, 0, 0.112, asphaltMaterial);
  addLaneMarkings(roads);
}


function fitModelToHeight(model: THREE.Object3D, targetHeight: number) {
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const scale = targetHeight / Math.max(size.y, 0.001);

  model.scale.setScalar(scale);
  model.position.set(
    -center.x * scale,
    -bounds.min.y * scale - 0.04,
    -center.z * scale
  );

  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => {
      if (material instanceof THREE.MeshStandardMaterial) {
        material.envMapIntensity = 0.72;
        material.metalness = Math.min(material.metalness, 0.48);
        material.roughness = Math.max(material.roughness, 0.42);
      }
    });
  });

  return model;
}

async function upgradeKartVisual(host: THREE.Group) {
  // Keep the vehicle hidden behind the loader until the authored auto is ready.
  // This prevents a one-frame flash of the procedural fallback.
  host.visible = false;

  try {
    const loader = new GLTFLoader();
    const gltf = await Promise.race([
      loader.loadAsync(ASSETS.auto),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Auto asset timeout')), 6500)
      )
    ]);

    const model = fitModelToHeight(gltf.scene.clone(true), 1.75);

    // EarthKart physics faces local -Z. This GLB already faces that direction,
    // so no 180-degree correction is required.
    model.rotation.y = 0;

    // Remove the procedural placeholder completely before revealing gameplay.
    host.clear();
    host.add(model);
  } catch {
    // If the GLB fails, reveal the lightweight procedural fallback only after
    // the loader has completed — never as a transient flash.
  } finally {
    host.visible = true;
  }
}


function samplePath(pts: THREE.Vector3[], t: number) {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    total += pts[i].distanceTo(pts[i + 1]);
    lengths.push(total);
  }
  const target = THREE.MathUtils.clamp(t, 0, 1) * total;
  let index = lengths.findIndex((n) => n >= target);
  if (index < 0) index = pts.length - 2;
  const before = index === 0 ? 0 : lengths[index - 1];
  const segment = Math.max(0.001, lengths[index] - before);
  const u = THREE.MathUtils.clamp((target - before) / segment, 0, 1);
  const position = pts[index].clone().lerp(pts[index + 1], u);
  const tangent = pts[index + 1].clone().sub(pts[index]).setY(0).normalize();
  const inland = new THREE.Vector3(-tangent.z, 0, tangent.x);
  return { position, tangent, inland };
}

function firstMesh(rootNode: THREE.Object3D): THREE.Mesh | null {
  let result: THREE.Mesh | null = null;
  rootNode.traverse((object) => {
    if (!result && object instanceof THREE.Mesh) result = object;
  });
  return result;
}

async function addStreetFurniture() {
  const marine = FALLBACK_WAYS.find((way) => (way.tags.name ?? '').toLowerCase().includes('marine drive'));
  if (!marine) return;
  const path = marine.geometry.map(worldPoint);
  const loader = new GLTFLoader();

  const streetlightTask = loader.loadAsync(ASSETS.streetlight).then((gltf) => {
    const source = firstMesh(gltf.scene);
    if (!source) return;
    const bounds = new THREE.Box3().setFromObject(source);
    const size = bounds.getSize(new THREE.Vector3());
    const scale = 4.7 / Math.max(size.y, 0.001);
    const material = new THREE.MeshStandardMaterial({
      color: 0x222a2d,
      metalness: 0.72,
      roughness: 0.32
    });
    const count = 26;
    const instances = new THREE.InstancedMesh(source.geometry, material, count);
    instances.name = 'Marine Drive streetlights';
    instances.castShadow = true;
    instances.receiveShadow = true;

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scaleVec = new THREE.Vector3(scale, scale, scale);

    for (let i = 0; i < count; i++) {
      const pose = samplePath(path, (i + 0.5) / count);
      const position = pose.position.clone().addScaledVector(pose.inland, -7.1);
      position.y = -bounds.min.y * scale + 0.02;
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(pose.tangent.x, pose.tangent.z));
      matrix.compose(position, quaternion, scaleVec);
      instances.setMatrixAt(i, matrix);
    }

    instances.instanceMatrix.needsUpdate = true;
    root.add(instances);
  });

  const palmTask = loader.loadAsync(ASSETS.palm).then((gltf) => {
    const source = firstMesh(gltf.scene);
    if (!source) return;
    const bounds = new THREE.Box3().setFromObject(source);
    const size = bounds.getSize(new THREE.Vector3());
    const scale = 5.6 / Math.max(size.y, 0.001);
    const sourceMaterial = Array.isArray(source.material) ? source.material[0] : source.material;
    const texture = sourceMaterial instanceof THREE.MeshStandardMaterial ? sourceMaterial.map : null;
    if (texture) texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshLambertMaterial({
      map: texture,
      color: 0xa9b99a,
      side: THREE.DoubleSide
    });

    const count = 12;
    const instances = new THREE.InstancedMesh(source.geometry, material, count);
    instances.name = 'Marine Drive palms';
    instances.castShadow = true;
    instances.receiveShadow = true;

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();

    for (let i = 0; i < count; i++) {
      const pose = samplePath(path, (i + 0.7) / count);
      const position = pose.position.clone().addScaledVector(pose.inland, -10.8);
      position.y = -bounds.min.y * scale + 0.02;
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i * 2.399963) % (Math.PI * 2));
      const variation = scale * (0.92 + (i % 5) * 0.04);
      matrix.compose(position, quaternion, new THREE.Vector3(variation, variation, variation));
      instances.setMatrixAt(i, matrix);
    }

    instances.instanceMatrix.needsUpdate = true;
    root.add(instances);
  });

  await Promise.allSettled([streetlightTask, palmTask]);
}


async function addAuthoredEnvironment() {
  const marine = FALLBACK_WAYS.find((way) => (way.tags.name ?? '').toLowerCase().includes('marine drive'));
  if (!marine) return;
  const path = marine.geometry.map(worldPoint);

  try {
    const gltf = await new GLTFLoader().loadAsync(ASSETS.environment);
    const authored = new THREE.Group();
    authored.name = 'Authored Mumbai environment';

    const cloneModule = (name: string, scale: number) => {
      const source = gltf.scene.getObjectByName(name);
      if (!source) return null;

      const module = source.clone(true);
      module.scale.setScalar(scale);
      module.updateMatrixWorld(true);

      const bounds = new THREE.Box3().setFromObject(module);
      const center = bounds.getCenter(new THREE.Vector3());
      module.position.x -= center.x;
      module.position.y -= bounds.min.y;
      module.position.z -= center.z;

      module.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = false;
          object.receiveShadow = true;
        }
      });

      return module;
    };

    const buildingNames = ['ArtDeco_Cream', 'ArtDeco_Teal', 'ArtDeco_Coral'];
    const buildingCount = 15;
    for (let i = 0; i < buildingCount; i++) {
      const module = cloneModule(buildingNames[i % buildingNames.length], 0.82 + (i % 3) * 0.05);
      if (!module) continue;
      const pose = samplePath(path, (i + 0.35) / buildingCount);
      module.position.add(pose.position).addScaledVector(pose.inland, 24 + (i % 3) * 5);
      module.rotation.y = Math.atan2(pose.inland.x, pose.inland.z);
      authored.add(module);
    }

    const promenadeCount = 18;
    for (let i = 0; i < promenadeCount; i++) {
      const module = cloneModule('Promenade_Module', 0.56);
      if (!module) continue;
      const pose = samplePath(path, (i + 0.5) / promenadeCount);
      module.position.add(pose.position).addScaledVector(pose.inland, -8.3);
      module.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), pose.tangent);
      authored.add(module);
    }

    for (const t of [0.18, 0.49, 0.78]) {
      const module = cloneModule('BusStop_Module', 0.86);
      if (!module) continue;
      const pose = samplePath(path, t);
      module.position.add(pose.position).addScaledVector(pose.inland, 13);
      module.rotation.y = Math.atan2(pose.inland.x, pose.inland.z);
      authored.add(module);
    }

    root.add(authored);
  } catch {
    // Authored environment is enhancement-only; roads remain playable.
  }
}


function pointToSegmentDistance2D(point: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const apx = point.x - a.x;
  const apz = point.z - a.z;
  const lenSq = abx * abx + abz * abz;

  if (lenSq < 0.0001) {
    const dx = point.x - a.x;
    const dz = point.z - a.z;
    return { distance: Math.hypot(dx, dz), point: a.clone(), tangent: new THREE.Vector3(0, 0, -1) };
  }

  const t = THREE.MathUtils.clamp((apx * abx + apz * abz) / lenSq, 0, 1);
  const nearest = new THREE.Vector3(a.x + abx * t, 0, a.z + abz * t);
  const tangent = new THREE.Vector3(abx, 0, abz).normalize();
  return {
    distance: Math.hypot(point.x - nearest.x, point.z - nearest.z),
    point: nearest,
    tangent
  };
}

function nearestRoadState(point: THREE.Vector3) {
  let bestDistance = Infinity;
  let bestRoad: RoadWay | null = null;
  let bestPoint = new THREE.Vector3();
  let bestTangent = new THREE.Vector3(0, 0, -1);

  for (const road of activeRoads) {
    for (let i = 0; i < road.pts.length - 1; i++) {
      const hit = pointToSegmentDistance2D(point, road.pts[i], road.pts[i + 1]);
      if (hit.distance < bestDistance) {
        bestDistance = hit.distance;
        bestRoad = road;
        bestPoint.copy(hit.point);
        bestTangent.copy(hit.tangent);
      }
    }
  }

  return {
    road: bestRoad,
    centerDistance: bestDistance,
    outsideDistance: bestRoad ? Math.max(0, bestDistance - bestRoad.width / 2) : Infinity,
    point: bestPoint,
    tangent: bestTangent
  };
}

function currentYaw() {
  const r = kartBody.rotation();
  const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q).setY(0).normalize();
  return Math.atan2(-forward.x, -forward.z);
}

function recoverToLastSafeRoad() {
  if (!kartBody) return;
  const position = lastSafePosition.lengthSq() > 0.01 ? lastSafePosition : spawn;
  const yaw = lastSafePosition.lengthSq() > 0.01 ? lastSafeYaw : spawnYaw;

  kartBody.setTranslation({ x: position.x, y: 1.25, z: position.z }, true);
  kartBody.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  kartBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
  kartBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
  offRoadSeconds = 0;

  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  camera.position.copy(position).add(new THREE.Vector3(0, 4.8, 10.2).applyQuaternion(q));
  camera.lookAt(position.clone().add(new THREE.Vector3(0, 0.78, -10).applyQuaternion(q)));
}

function updateRoadSafety(dt: number) {
  if (!kartBody || !activeRoads.length) return;

  const p = kartBody.translation();
  if (![p.x, p.y, p.z].every(Number.isFinite)) {
    recoverToLastSafeRoad();
    return;
  }

  const position = new THREE.Vector3(p.x, 0, p.z);
  const state = nearestRoadState(position);

  if (state.outsideDistance <= 1.2) {
    offRoadSeconds = 0;
    lastSafePosition.copy(state.point).setY(1.25);
    lastSafeYaw = currentYaw();
    return;
  }

  offRoadSeconds += dt;

  const velocity = kartBody.linvel();
  const drag = state.outsideDistance > 5 ? 0.78 : 0.9;
  kartBody.setLinvel({
    x: velocity.x * drag,
    y: velocity.y,
    z: velocity.z * drag
  }, true);

  // Mild steering pull toward the nearest street before hard recovery.
  if (state.outsideDistance < 14 && state.point.lengthSq() > 0) {
    const toward = state.point.clone().sub(position).setY(0);
    if (toward.lengthSq() > 0.01) {
      toward.normalize();
      kartBody.addForce({ x: toward.x * 420, y: 0, z: toward.z * 420 }, true);
    }
  }

  if (state.outsideDistance > 22 || offRoadSeconds > 2.5 || p.y < -2.5) {
    recoverToLastSafeRoad();
  }
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
  lastSafePosition.copy(spawn);
  lastSafeYaw = spawnYaw;
  offRoadSeconds = 0;
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
  kartBody.addForce({
    x: -right.x * lateral * grip,
    y: -Math.min(750, kmh * 3.5),
    z: -right.z * lateral * grip
  }, true);

  if (steer && kmh > 1.5) {
    kartBody.addTorque({
      x: 0,
      y: steer * 58 * THREE.MathUtils.clamp(kmh / 18, 0.4, 2.2) * (forwardSpeed >= -0.5 ? 1 : -1),
      z: 0
    }, true);
  }

  speedEl.textContent = String(Math.round(kmh)).padStart(3, '0');
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
    updateRoadSafety(dt);

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

async function hydrateLiveMap() {
  try {
    mapStatus.textContent = 'OSM SYNCING';
    const osm = await loadLiveRoads();
    const roads = parseRoads(osm.elements ?? [], false);
    buildRoadWorld(roads);
    mapStatus.textContent = 'LIVE OSM';

    void loadLiveBuildings()
      .then((buildingOsm) => addBuildings(parseBuildings(buildingOsm.elements ?? [])))
      .catch(() => {
        // Buildings are enhancement-only; never block gameplay.
      });
  } catch {
    mapStatus.textContent = 'OFFLINE MAP';
  }
}

async function boot() {
  try {
    progress(12, 'Initialising WebGL physics');
    await RAPIER.init();

    progress(42, 'Loading local Marine Drive streets');
    const fallbackRoads = parseRoads(FALLBACK_WAYS, true);
    buildRoadWorld(fallbackRoads);

    progress(68, 'Preparing kart');
    kartMesh = createKart();

    progress(76, 'Loading Mumbai racing auto');
    await upgradeKartVisual(kartMesh);

    progress(86, 'Preparing environment');
    void addStreetFurniture();
    void addAuthoredEnvironment();

    setupPhysics();
    lastSafePosition.copy(spawn);
    lastSafeYaw = spawnYaw;
    kartMesh.position.copy(spawn);

    const spawnQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spawnYaw);
    camera.position.copy(spawn).add(new THREE.Vector3(0, 4.8, 10.2).applyQuaternion(spawnQ));
    camera.lookAt(spawn.clone().add(new THREE.Vector3(0, 0.78, -10).applyQuaternion(spawnQ)));

    progress(100, 'Drive');
    mapStatus.textContent = 'LOCAL MAP';
    running = true;
    setTimeout(() => loader.classList.add('is-done'), 120);

    void hydrateLiveMap();
  } catch (e) {
    errorText.textContent = e instanceof Error ? e.message : String(e);
    errorPanel.hidden = false;
    progress(100, 'Startup error');
  }
}

void boot();
