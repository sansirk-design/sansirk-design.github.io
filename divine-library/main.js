import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* ============================================================
   Layout
   One long hall running toward -z forever, cut into segments.
   Each segment: a tall shelf on both sides, a reading table,
   and a lamp hanging out of the dark. Segments are recycled
   from a small pool as you walk, so the hall never ends.
   ============================================================ */
const SEG = 8;                 // longer segments: more room between reading tables
const AISLE = 2.6;             // centre to shelf front
const DEPTH = 0.38;
const SHELF_LEN = 5.7;
const GAP = 0.41;              // vertical space per shelf
const LEVELS = Array.from({ length: 26 }, (_, i) => 0.13 + i * GAP);   // shelves climb far out of reach
const FILL_ORDER = [3, 2, 4, 1, 5, 0, 6, 7, 8];   // your books fill eye level first, and never above reach
const UNIT_H = LEVELS[LEVELS.length - 1] + GAP + 0.02;
const POOL = 8;
const EYE = 1.62;
const LAMP_Y = 6.2;            // lamps hang high, out of the dark
const SCONCE_Y = 3.1;
const WARP_START = 3.75;        // above this height the stacks lean in over you
const WARP_REACH = 7.0;
const FILL_CAP = 9000;

const TYPES = {
  book:       { label: 'Book',        h: 0.235, d: 0.155, perPage: 0.00008, cover: 0.006 },
  manga:      { label: 'Manga',       h: 0.180, d: 0.128, perPage: 0.00009, cover: 0.004 },
  lightnovel: { label: 'Light novel', h: 0.150, d: 0.105, perPage: 0.00008, cover: 0.004 },
  comic:      { label: 'Comic',       h: 0.260, d: 0.170, perPage: 0.00012, cover: 0.004 },
  other:      { label: 'Other',       h: 0.220, d: 0.150, perPage: 0.00008, cover: 0.005 },
};
const LEATHER = ['#5a1f1b', '#6b2a1f', '#2f3b2a', '#22313f', '#4a3524', '#7a5a2e', '#3b2430',
  '#1e1a17', '#5c4630', '#283a36', '#6d4c2f', '#401c16', '#2c2a3d', '#55402a'];

/* ============================================================
   Helpers
   ============================================================ */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const V2 = (x, y) => new THREE.Vector2(x, y);

/* ============================================================
   Renderer, scene, post-processing
   ============================================================ */
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
const FOG = 0x020101;
scene.background = new THREE.Color(FOG);
scene.fog = new THREE.FogExp2(FOG, 0.1);

const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.05, 55);
camera.rotation.order = 'YXZ';

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

// Ambient occlusion: darkens corners, gaps between books, under tables
const gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
gtao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.6, thickness: 1.2, scale: 1.6, samples: 16, distanceFallOff: 1 });
gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
gtao.blendIntensity = 1.25;
// glows, light shafts, cobwebs and dust shouldn't cast AO
const baseOverride = gtao.overrideVisibility.bind(gtao);
gtao.overrideVisibility = function () {
  baseOverride();
  this.scene.traverse((o) => { if (o.isSprite || o.userData.noAO) o.visible = false; });
};
composer.addPass(gtao);

const bloom = new UnrealBloomPass(V2(innerWidth, innerHeight), 1.45, 0.7, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function tex(c, { repeat = false, srgb = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = MAX_ANISO;
  return t;
}

/* ============================================================
   Procedural textures + normal maps
   Normal maps are generated from each texture's brightness,
   so grain, seams and tooling read as real surface depth.
   ============================================================ */
function normalCanvas(src, strength = 4) {
  const w = src.width, h = src.height;
  const sd = src.getContext('2d').getImageData(0, 0, w, h).data;
  const H = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) H[i] = (sd[i * 4] * 0.3 + sd[i * 4 + 1] * 0.59 + sd[i * 4 + 2] * 0.11) / 255;
  const out = makeCanvas(w, h), g = out.getContext('2d'), img = g.createImageData(w, h), d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = H[y * w + (x - 1 + w) % w], r = H[y * w + (x + 1) % w];
      const u = H[((y - 1 + h) % h) * w + x], dn = H[((y + 1) % h) * w + x];
      let nx = (l - r) * strength, ny = (dn - u) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * w + x) * 4;
      d[i] = (nx / len * 0.5 + 0.5) * 255;
      d[i + 1] = (ny / len * 0.5 + 0.5) * 255;
      d[i + 2] = (nz / len * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return out;
}

function woodCanvas(seed) {
  const w = 512, h = 512, c = makeCanvas(w, h), g = c.getContext('2d'), r = rng(seed);
  g.fillStyle = '#c9a27c'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 520; i++) {
    const p = r() * h, a = r() * 0.16, dark = r() < 0.72;
    g.strokeStyle = dark ? `rgba(40,20,5,${a})` : `rgba(255,230,190,${a * 0.6})`;
    g.lineWidth = 0.5 + r() * 2.6;
    const amp = r() * 4, f = 0.008 + r() * 0.03, ph = r() * 6;
    g.beginPath();
    for (let s = 0; s <= w; s += 6) { const o = p + Math.sin(s * f + ph) * amp; s === 0 ? g.moveTo(s, o) : g.lineTo(s, o); }
    g.stroke();
  }
  // knots
  for (let i = 0; i < 4; i++) {
    const x = r() * w, y = r() * h;
    for (let k = 9; k > 0; k--) { g.strokeStyle = `rgba(40,20,5,${0.05 + k * 0.012})`; g.lineWidth = 1.2; g.beginPath(); g.ellipse(x, y, k * 4, k * 1.6, 0, 0, Math.PI * 2); g.stroke(); }
  }
  return c;
}

function floorCanvas() {
  const c = makeCanvas(512, 512), g = c.getContext('2d'), r = rng(7);
  for (let i = 0; i < 8; i++) {
    const x = i * 64;
    const shade = () => `hsl(${22 + r() * 8} ${36 + r() * 12}% ${13 + r() * 7}%)`;
    g.fillStyle = shade(); g.fillRect(x, 0, 64, 512);
    const a = (r() * 220) | 0, b = a + 140 + ((r() * 120) | 0);
    g.fillStyle = shade(); g.fillRect(x, a, 64, b - a);
    for (let k = 0; k < 34; k++) {
      g.strokeStyle = `rgba(0,0,0,${r() * 0.2})`;
      g.lineWidth = 0.5 + r() * 1.6;
      const gx = x + 3 + r() * 58;
      g.beginPath(); g.moveTo(gx, 0);
      g.bezierCurveTo(gx + (r() - 0.5) * 8, 170, gx + (r() - 0.5) * 8, 340, gx + (r() - 0.5) * 4, 512);
      g.stroke();
    }
    for (let k = 0; k < 60; k++) { g.fillStyle = `rgba(0,0,0,${r() * 0.25})`; g.fillRect(x + r() * 64, r() * 512, 1 + r() * 3, 1); } // scuffs
    g.fillStyle = 'rgba(0,0,0,.8)';
    g.fillRect(x, a, 64, 3); g.fillRect(x, b, 64, 3);
    g.fillRect(x, 0, 3, 512);
    g.fillStyle = 'rgba(0,0,0,.6)';
    for (const ny of [a + 10, b + 10]) for (const nx of [x + 12, x + 52]) { g.beginPath(); g.arc(nx, ny, 2, 0, 7); g.fill(); } // nails
  }
  return c;
}

function rugCanvas() {
  const c = makeCanvas(192, 256), g = c.getContext('2d');
  g.fillStyle = '#2e0b0a'; g.fillRect(0, 0, 192, 256);
  g.fillStyle = '#140605'; g.fillRect(0, 0, 14, 256); g.fillRect(178, 0, 14, 256);
  g.fillStyle = '#6d5530'; g.fillRect(16, 0, 3, 256); g.fillRect(173, 0, 3, 256);
  g.fillStyle = '#4a1512'; g.fillRect(24, 0, 6, 256); g.fillRect(162, 0, 6, 256);
  g.strokeStyle = 'rgba(110,85,48,.55)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(96, 40); g.lineTo(150, 128); g.lineTo(96, 216); g.lineTo(42, 128); g.closePath(); g.stroke();
  g.fillStyle = 'rgba(74,21,18,.9)';
  g.beginPath(); g.moveTo(96, 70); g.lineTo(132, 128); g.lineTo(96, 186); g.lineTo(60, 128); g.closePath(); g.fill();
  const r = rng(3);
  for (let y = 0; y < 256; y += 2) { g.fillStyle = `rgba(0,0,0,${0.08 + r() * 0.06})`; g.fillRect(0, y, 192, 1); } // weave
  for (let i = 0; i < 2600; i++) { g.fillStyle = `rgba(0,0,0,${r() * 0.2})`; g.fillRect(r() * 192, r() * 256, 1, 1); }
  return c;
}

function leatherCanvas() {
  // Spine pattern for anonymous books; tinted per book by instance colour
  const c = makeCanvas(128, 512), g = c.getContext('2d'), r = rng(11);
  g.fillStyle = '#b4b4b4'; g.fillRect(0, 0, 128, 512);
  for (let i = 0; i < 5000; i++) { const v = 120 + r() * 110; g.fillStyle = `rgba(${v},${v},${v},.35)`; g.fillRect(r() * 128, r() * 512, 1 + r() * 2, 1 + r() * 2); }
  // raised bands (the ridges on old bindings)
  for (const y of [70, 160, 250, 340, 430]) {
    const gr = g.createLinearGradient(0, y - 8, 0, y + 8);
    gr.addColorStop(0, '#8a8a8a'); gr.addColorStop(0.5, '#f4f4f4'); gr.addColorStop(1, '#8a8a8a');
    g.fillStyle = gr; g.fillRect(0, y - 8, 128, 16);
  }
  g.fillStyle = '#e8e8e8';
  g.fillRect(24, 186, 80, 46);
  g.strokeStyle = '#7a7a7a'; g.lineWidth = 2; g.strokeRect(24, 186, 80, 46);
  return c;
}

function grainCanvas(seed = 21) {
  const c = makeCanvas(256, 256), g = c.getContext('2d'), r = rng(seed);
  g.fillStyle = '#808080'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) { const v = 70 + r() * 120; g.fillStyle = `rgba(${v},${v},${v},.5)`; g.fillRect(r() * 256, r() * 256, 1 + r() * 2, 1 + r() * 2); }
  return c;
}

function pagesCanvas() {
  const c = makeCanvas(256, 256), g = c.getContext('2d'), r = rng(31);
  g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, 256, 256);
  for (let x = 0; x < 256; x += 2) { const v = 110 + r() * 120; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, 0, 1, 256); }
  return c;
}

function radialCanvas() {
  const c = makeCanvas(128, 128), g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return c;
}

function flameCanvas() {
  const c = makeCanvas(64, 128), g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 84, 2, 32, 76, 46);
  gr.addColorStop(0, 'rgba(255,255,240,1)'); gr.addColorStop(0.25, 'rgba(255,210,120,.95)');
  gr.addColorStop(0.6, 'rgba(255,120,30,.45)'); gr.addColorStop(1, 'rgba(255,80,0,0)');
  g.fillStyle = gr;
  g.beginPath(); g.moveTo(32, 6); g.bezierCurveTo(54, 50, 52, 110, 32, 116); g.bezierCurveTo(12, 110, 10, 50, 32, 6); g.fill();
  return c;
}

function beamCanvas() {
  const c = makeCanvas(16, 128), g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 128);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 16, 128);
  return c;
}

function webCanvas(seed) {
  // A cobweb anchored in the top-right corner
  const S = 256, c = makeCanvas(S, S), g = c.getContext('2d'), r = rng(seed);
  g.strokeStyle = 'rgba(235,228,215,.9)'; g.lineCap = 'round';
  const ox = S, oy = 0, spokes = 9, angles = [];
  for (let i = 0; i < spokes; i++) angles.push(Math.PI / 2 + (i / (spokes - 1)) * (Math.PI / 2) + (r() - 0.5) * 0.08);
  const len = angles.map(() => S * (0.75 + r() * 0.35));
  g.lineWidth = 1.1;
  angles.forEach((a, i) => { g.beginPath(); g.moveTo(ox, oy); g.lineTo(ox + Math.cos(a) * len[i], oy + Math.sin(a) * len[i]); g.stroke(); });
  g.lineWidth = 0.8;
  for (let ring = 14; ring < S; ring += 9 + r() * 9) {
    g.beginPath();
    angles.forEach((a, i) => {
      if (ring > len[i]) return;
      const sag = ring * 0.92;
      const x = ox + Math.cos(a) * ring, y = oy + Math.sin(a) * ring;
      if (i === 0) g.moveTo(x, y);
      else { const pa = (angles[i - 1] + a) / 2; g.quadraticCurveTo(ox + Math.cos(pa) * sag, oy + Math.sin(pa) * sag, x, y); }
    });
    g.globalAlpha = 0.4 + r() * 0.5; g.stroke(); g.globalAlpha = 1;
  }
  for (let i = 0; i < 6; i++) { // loose strands
    g.lineWidth = 0.6; g.globalAlpha = 0.5;
    g.beginPath(); const a = angles[(r() * spokes) | 0], d = r() * S * 0.6;
    g.moveTo(ox + Math.cos(a) * d, oy + Math.sin(a) * d); g.quadraticCurveTo(r() * S, r() * S, r() * S * 0.6, S * (0.5 + r() * 0.5)); g.stroke();
  }
  return c;
}

function plaqueCanvas(text, w = 512, h = 96, size = 44, family = '600 {S}px "Cormorant Garamond", Georgia, serif', spacing = '6px') {
  const c = makeCanvas(w, h), g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, '#a88449'); gr.addColorStop(0.5, '#7a5a2a'); gr.addColorStop(1, '#5c4220');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(30,18,6,.8)'; g.lineWidth = 4; g.strokeRect(6, 6, w - 12, h - 12);
  g.fillStyle = '#21140a';
  g.font = family.replace('{S}', size);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if ('letterSpacing' in g) g.letterSpacing = spacing;
  g.fillText(text, w / 2, h / 2 + 2);
  return c;
}

/* ============================================================
   Materials
   ============================================================ */
const woodC = woodCanvas(2);
const woodTex = tex(woodC, { repeat: true });
const woodN = tex(normalCanvas(woodC, 7), { repeat: true, srgb: false });
const floorC = floorCanvas();
const floorTex = tex(floorC, { repeat: true });
const floorN = tex(normalCanvas(floorC, 9), { repeat: true, srgb: false });
const rugC = rugCanvas();
const leatherC = leatherCanvas();
const grainN = tex(normalCanvas(grainCanvas(), 3), { repeat: true, srgb: false });
const pagesN = tex(normalCanvas(pagesCanvas(), 4), { srgb: false });
const glowTex = tex(radialCanvas(), { srgb: false });
const flameTex = tex(flameCanvas(), { srgb: false });
const beamTex = tex(beamCanvas(), { srgb: false });
const webTexes = [tex(webCanvas(5), { srgb: false }), tex(webCanvas(9), { srgb: false }), tex(webCanvas(17), { srgb: false })];

const woodMat = (color, rough = 0.62) => new THREE.MeshStandardMaterial({ map: woodTex, normalMap: woodN, normalScale: V2(1.8, 1.8), color, roughness: rough });
const M = {
  wood: woodMat(0x5a3720),
  woodDark: woodMat(0x2a190e, 0.75),
  table: woodMat(0x4c2e19, 0.42),
  brass: new THREE.MeshStandardMaterial({ color: 0xa07c40, metalness: 0.9, roughness: 0.32, normalMap: grainN, normalScale: V2(0.25, 0.25) }),
  iron: new THREE.MeshStandardMaterial({ color: 0x1c1a18, metalness: 0.7, roughness: 0.55 }),
  shadeInside: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xd88a40, emissiveIntensity: 0.45, side: THREE.BackSide }),
  bulb: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xfff0cf, emissiveIntensity: 7 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x3a2a18, emissive: 0xffa956, emissiveIntensity: 1.1, transparent: true, opacity: 0.88, roughness: 0.15 }),
  wax: new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.6, emissive: 0x3a1c06, emissiveIntensity: 0.4 }),
  pages: new THREE.MeshStandardMaterial({ color: 0xd6c6a2, roughness: 0.92, normalMap: pagesN, normalScale: V2(1.2, 1.2) }),
  filler: new THREE.MeshStandardMaterial({ map: tex(leatherC), normalMap: tex(normalCanvas(leatherC, 6), { srgb: false }), normalScale: V2(2, 2), roughness: 0.7 }),
  cord: new THREE.MeshBasicMaterial({ color: 0x050403 }),
  glow: new THREE.SpriteMaterial({ map: glowTex, color: 0xffb468, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.55 }),
  flame: new THREE.SpriteMaterial({ map: flameTex, color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
  poolTable: new THREE.MeshBasicMaterial({ map: glowTex, color: 0xff9c50, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.2 }),
  poolFloor: new THREE.MeshBasicMaterial({ map: glowTex, color: 0xff8a40, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.08 }),
  shaft: new THREE.MeshBasicMaterial({ map: beamTex, color: 0xffc78a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.03, side: THREE.DoubleSide }),
  webs: webTexes.map((t) => new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, color: 0xbdb3a2 })),
  leathers: LEATHER.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.62, normalMap: grainN, normalScale: V2(0.8, 0.8) })),
};

/* ---------- the warp ----------
   Above WARP_START every shelf vertex is pulled toward the centre of the
   hall, more the higher it is, with a slow ripple along its length. The
   stacks seem to lean in and close over you. Applied in the vertex shader. */
const WARP_GLSL = `
  vec4 wpos = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    wpos = instanceMatrix * wpos;
  #endif
  wpos = modelMatrix * wpos;
  float wh = max( 0.0, wpos.y - ${WARP_START.toFixed(3)} );
  float lean = min( 0.36, ( wh / ${WARP_REACH.toFixed(3)} ) * ( wh / ${WARP_REACH.toFixed(3)} ) * 0.36 );
  float edge = smoothstep( 1.4, 2.4, abs( wpos.x ) );
  wpos.x *= 1.0 - lean * edge;
  wpos.x += sin( wpos.z * 0.33 + wh * 0.55 ) * 0.035 * wh * edge;
  wpos.z += sin( wpos.y * 0.7 + wpos.x * 0.9 ) * 0.03 * wh * edge;
  vec4 mvPosition = viewMatrix * wpos;
  gl_Position = projectionMatrix * mvPosition;
`;
function applyWarp(mat) {
  mat.onBeforeCompile = (shader) => { shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', WARP_GLSL); };
  mat.customProgramCacheKey = () => 'warp';
  return mat;
}
[M.wood, M.woodDark, M.filler, ...M.webs].forEach(applyWarp);
applyWarp(gtao.normalMaterial);   // keep ambient occlusion in step with the bent shelves
M.paper = new THREE.MeshStandardMaterial({ color: 0xcfc1a2, roughness: 0.95, side: THREE.DoubleSide });

/* ---------- geometry helpers (cached) ---------- */
const geoCache = new Map();
function rbox(w, h, d, r = 0.008, seg = 2) {
  const key = `${w}|${h}|${d}|${r}|${seg}`;
  if (!geoCache.has(key)) geoCache.set(key, r > 0 ? new RoundedBoxGeometry(w, h, d, seg, r) : new THREE.BoxGeometry(w, h, d));
  return geoCache.get(key);
}
function box(w, h, d, mat, x, y, z, parent, r = 0.008) {
  const m = new THREE.Mesh(rbox(w, h, d, r), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function lathe(points, segs = 32) {
  return new THREE.LatheGeometry(points.map(([r, y]) => V2(r, y)), segs);
}
function cyl(rt, rb, h, mat, x, y, z, parent, segs = 20) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, segs), mat);
  m.position.set(x, y, z); parent.add(m); return m;
}
function noAO(o) { o.userData.noAO = true; return o; }

/* ============================================================
   The floor follows the player. There is no ceiling: above the
   shelves is only darkness.
   ============================================================ */
const HALL_W = 2 * (AISLE + DEPTH);
const RUN = 180;
const following = new THREE.Group();
scene.add(following);
{
  floorTex.repeat.set(HALL_W / 2, RUN / 2); floorN.repeat.copy(floorTex.repeat);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(HALL_W, RUN),
    new THREE.MeshStandardMaterial({ map: floorTex, normalMap: floorN, normalScale: V2(2.2, 2.2), roughness: 0.5 }));
  floor.rotation.x = -Math.PI / 2;
  following.add(floor);

  const rugTex = tex(rugC, { repeat: true }), rugN = tex(normalCanvas(rugC, 5), { repeat: true, srgb: false });
  rugTex.repeat.set(1, RUN / 2); rugN.repeat.copy(rugTex.repeat);
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(1.5, RUN),
    new THREE.MeshStandardMaterial({ map: rugTex, normalMap: rugN, normalScale: V2(1.5, 1.5), roughness: 0.95 }));
  rug.rotation.x = -Math.PI / 2; rug.position.y = 0.004;
  following.add(rug);
}

// Entrance wall with doors, behind where you start
const SIGN = ['The Divine Library', 768, 126, 76, '{S}px "Pinyon Script", cursive', '0px'];
const signTex = tex(plaqueCanvas(...SIGN));
{
  const g = new THREE.Group(); scene.add(g);
  const wallH = 6;
  const wallTex = woodTex.clone(); wallTex.repeat.set(3, 3); wallTex.needsUpdate = true;
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(HALL_W, wallH), new THREE.MeshStandardMaterial({ map: wallTex, normalMap: woodN, color: 0x24160d, roughness: 0.8 }));
  wall.rotation.y = Math.PI; wall.position.set(0, wallH / 2, 0); g.add(wall);
  // wainscot panels
  for (let i = -2; i <= 2; i++) if (Math.abs(i) > 0) box(0.7, 1.0, 0.04, M.woodDark, i * 1.15, 0.65, -0.03, g, 0.01);
  // door frame + arch
  box(2.3, 0.18, 0.16, M.wood, 0, 2.88, -0.05, g, 0.02);
  for (const s of [-1, 1]) box(0.16, 2.9, 0.16, M.wood, s * 1.07, 1.45, -0.05, g, 0.02);
  const arch = new THREE.Mesh(new THREE.TorusGeometry(1.07, 0.07, 12, 48, Math.PI), M.wood);
  arch.position.set(0, 2.97, -0.06); g.add(arch);
  for (const s of [-1, 1]) {
    box(0.98, 2.75, 0.08, M.wood, s * 0.495, 1.375, -0.08, g, 0.01);
    for (const [py, ph] of [[0.62, 0.9], [1.75, 1.15]]) box(0.68, ph, 0.03, M.woodDark, s * 0.495, py, -0.13, g, 0.008);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.009, 10, 28), M.brass);
    ring.position.set(s * 0.12, 1.15, -0.16); g.add(ring);
    cyl(0.02, 0.02, 0.03, M.brass, s * 0.12, 1.22, -0.14, g).rotation.x = Math.PI / 2;
  }
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.36), new THREE.MeshStandardMaterial({ map: signTex, metalness: 0.5, roughness: 0.45 }));
  sign.rotation.y = Math.PI; sign.position.set(0, 4.35, -0.03); g.add(sign);
  // two warm lights on your own shelves, either side of the entrance
  for (const sx of [-1, 1]) {
    const l = new THREE.PointLight(0xffb36b, 5, 6, 2);
    l.position.set(sx * 1.05, 2.6, -1.0); scene.add(l);
  }
}

/* ============================================================
   Furniture & fixtures
   ============================================================ */
function buildShelfUnit() {
  // Left-hand unit. The right one is the same rotated 180°.
  const g = new THREE.Group();
  const x0 = -AISLE - DEPTH, cx = -AISLE - DEPTH / 2, front = -AISLE;
  // back: vertical tongue-and-groove boards
  const boards = 16, bw = (SHELF_LEN + 0.1) / boards;
  for (let i = 0; i < boards; i++) box(0.02, UNIT_H, bw - 0.004, M.woodDark, x0 + 0.01, UNIT_H / 2, -SHELF_LEN / 2 - 0.05 + bw * (i + 0.5), g, 0.003);
  // uprights with a column on the front
  for (const s of [-1, 1]) {
    const z = s * (SHELF_LEN / 2 + 0.04);
    box(DEPTH + 0.03, UNIT_H + 0.05, 0.08, M.wood, cx + 0.015, (UNIT_H + 0.05) / 2, z, g, 0.012);
    const col = new THREE.Mesh(lathe([[0, 0], [0.05, 0], [0.05, 0.04], [0.04, 0.06], [0.034, 0.1], [0.03, UNIT_H - 0.42], [0.036, UNIT_H - 0.38], [0.048, UNIT_H - 0.34], [0.048, UNIT_H - 0.3], [0, UNIT_H - 0.3]], 20), M.wood);
    col.position.set(front + 0.06, 0.12, z); g.add(col);
  }
  // shelf boards with a rounded front lip
  for (const y of LEVELS) {
    box(DEPTH, 0.028, SHELF_LEN, M.wood, cx, y - 0.014, 0, g, 0.006);
    box(0.03, 0.045, SHELF_LEN, M.wood, front - 0.012, y - 0.02, 0, g, 0.01);
  }
  box(DEPTH, 0.03, SHELF_LEN, M.wood, cx, UNIT_H - 0.02, 0, g, 0.006);
  // crown: stacked mouldings
  box(DEPTH + 0.08, 0.14, SHELF_LEN + 0.22, M.wood, cx + 0.04, UNIT_H + 0.07, 0, g, 0.02);
  const bead = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, SHELF_LEN + 0.24, 16), M.wood);
  bead.rotation.x = Math.PI / 2; bead.position.set(front + 0.09, UNIT_H + 0.15, 0); g.add(bead);
  box(DEPTH + 0.16, 0.08, SHELF_LEN + 0.34, M.woodDark, cx + 0.08, UNIT_H + 0.22, 0, g, 0.025);
  box(DEPTH + 0.2, 0.05, SHELF_LEN + 0.4, M.wood, cx + 0.1, UNIT_H + 0.285, 0, g, 0.02);
  // dentil blocks under the crown
  for (let z = -SHELF_LEN / 2 + 0.1; z < SHELF_LEN / 2; z += 0.16) box(0.03, 0.04, 0.07, M.wood, front + 0.07, UNIT_H - 0.01, z, g, 0.004);
  // plinth
  box(DEPTH + 0.06, 0.12, SHELF_LEN + 0.12, M.woodDark, cx + 0.03, 0.06, 0, g, 0.015);
  box(0.03, 0.03, SHELF_LEN + 0.12, M.wood, front + 0.06, 0.125, 0, g, 0.01);
  // brass rail for the rolling ladder
  const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, SHELF_LEN + 0.1, 14), M.brass);
  rail.rotation.x = Math.PI / 2; rail.position.set(front + 0.13, 3.62, 0); g.add(rail);
  for (const z of [-SHELF_LEN / 2 + 0.3, 0, SHELF_LEN / 2 - 0.3]) box(0.12, 0.02, 0.02, M.brass, front + 0.07, 3.62, z, g, 0.005);
  return g;
}

function turnedLeg(h, r) {
  const k = h / 0.65;
  return lathe([[0, 0], [r * 0.85, 0], [r, 0.03 * k], [r * 0.75, 0.06 * k], [r * 0.6, 0.2 * k], [r, 0.3 * k], [r * 1.1, 0.35 * k], [r * 0.75, 0.42 * k], [r * 0.62, 0.55 * k], [r * 0.9, 0.6 * k], [r * 0.9, h], [0, h]], 16);
}

function buildTable() {
  const g = new THREE.Group();
  box(1.08, 0.055, 2.72, M.table, 0, 0.765, 0, g, 0.02);
  box(1.0, 0.03, 2.64, M.woodDark, 0, 0.725, 0, g, 0.01);
  box(0.9, 0.1, 2.4, M.woodDark, 0, 0.66, 0, g, 0.01);
  const legGeo = turnedLeg(0.71, 0.045);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const l = new THREE.Mesh(legGeo, M.woodDark); l.position.set(sx * 0.42, 0, sz * 1.18); g.add(l); }
  const st = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 2.36, 12), M.woodDark);
  st.rotation.x = Math.PI / 2; st.position.y = 0.16; g.add(st);
  for (const sz of [-1, 1]) { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.84, 12), M.woodDark); c.rotation.z = Math.PI / 2; c.position.set(0, 0.16, sz * 1.18); g.add(c); }
  return g;
}

function buildChair() {
  // Faces +z; back at -z
  const g = new THREE.Group();
  box(0.44, 0.045, 0.42, M.wood, 0, 0.46, 0, g, 0.012);
  const front = turnedLeg(0.44, 0.022);
  for (const sx of [-1, 1]) { const l = new THREE.Mesh(front, M.woodDark); l.position.set(sx * 0.19, 0, 0.17); g.add(l); }
  for (const sx of [-1, 1]) {
    const l = cyl(0.02, 0.022, 0.98, M.woodDark, sx * 0.19, 0.49, -0.18, g, 12);
    l.rotation.x = -0.06;
    const fin = new THREE.Mesh(new THREE.SphereGeometry(0.026, 12, 10), M.woodDark); fin.position.set(sx * 0.19, 0.99, -0.21); g.add(fin);
  }
  box(0.4, 0.08, 0.03, M.wood, 0, 0.9, -0.205, g, 0.012);
  box(0.4, 0.035, 0.025, M.wood, 0, 0.6, -0.188, g, 0.008);
  for (let i = -1.5; i <= 1.5; i++) { const sp = cyl(0.009, 0.011, 0.27, M.woodDark, i * 0.08, 0.74, -0.196, g, 10); sp.rotation.x = -0.06; }
  for (const sx of [-1, 1]) { const s = cyl(0.01, 0.01, 0.34, M.woodDark, sx * 0.19, 0.12, 0, g, 8); s.rotation.x = Math.PI / 2; }
  return g;
}

function buildLamp() {
  const g = new THREE.Group();
  g.position.y = LAMP_Y;
  // chain into the dark, then a cord that never ends
  const links = [];
  for (let i = 0; i < 26; i++) {
    const t = new THREE.TorusGeometry(0.016, 0.0035, 6, 14);
    if (i % 2) t.rotateY(Math.PI / 2);
    t.translate(0, 0.24 + i * 0.026, 0);
    links.push(t);
  }
  g.add(new THREE.Mesh(mergeGeometries(links), M.iron));
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 10, 6), M.cord);
  cord.position.y = 0.24 + 26 * 0.026 + 5; g.add(cord);
  // canopy, neck and bell shade
  g.add(new THREE.Mesh(lathe([[0, 0.24], [0.02, 0.24], [0.03, 0.2], [0.05, 0.17], [0.06, 0.13], [0, 0.13]], 24), M.brass));
  const shadeGeo = lathe([[0.055, 0.13], [0.07, 0.12], [0.09, 0.09], [0.13, 0.05], [0.19, 0.01], [0.26, -0.04], [0.31, -0.08], [0.34, -0.11], [0.35, -0.125]], 48);
  g.add(new THREE.Mesh(shadeGeo, M.brass));
  const inner = new THREE.Mesh(shadeGeo, M.shadeInside); inner.scale.setScalar(0.975); inner.name = 'inner'; g.add(inner);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.009, 10, 64), M.brass);
  rim.rotation.x = Math.PI / 2; rim.position.y = -0.125; g.add(rim);
  cyl(0.025, 0.03, 0.07, M.brass, 0, 0.07, 0, g, 16);
  const bulb = new THREE.Mesh(lathe([[0, 0.03], [0.03, 0.02], [0.05, -0.02], [0.055, -0.06], [0.045, -0.1], [0.02, -0.12], [0, -0.125]], 24), M.bulb);
  bulb.name = 'bulb'; g.add(bulb);
  const glow = new THREE.Sprite(M.glow); glow.scale.set(0.95, 0.95, 1); glow.position.y = -0.12; glow.name = 'glow'; g.add(glow);
  const shaftH = LAMP_Y - 0.14 - 0.8;
  const shaft = noAO(new THREE.Mesh(new THREE.CylinderGeometry(0.32, 2.0, shaftH, 40, 1, true), M.shaft));
  shaft.position.y = -0.13 - shaftH / 2; shaft.name = 'shaft'; g.add(shaft);
  return g;
}

function buildSconce(side) {
  // Brass wall light on the upright between two shelf units, facing the aisle
  const g = new THREE.Group();
  const fx = side * (AISLE - 0.1);
  const rose = new THREE.Mesh(lathe([[0, 0], [0.07, 0], [0.07, 0.012], [0.05, 0.03], [0.02, 0.04], [0, 0.04]], 24), M.brass);
  rose.rotation.z = side * -Math.PI / 2; rose.position.set(fx, SCONCE_Y - 0.05, 0); g.add(rose);
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(fx, SCONCE_Y - 0.05, 0),
    new THREE.Vector3(fx - side * 0.1, SCONCE_Y - 0.09, 0),
    new THREE.Vector3(fx - side * 0.2, SCONCE_Y - 0.03, 0),
    new THREE.Vector3(fx - side * 0.22, SCONCE_Y + 0.04, 0),
  ]);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.009, 8), M.brass));
  const cup = new THREE.Mesh(lathe([[0, 0], [0.035, 0], [0.045, 0.02], [0.03, 0.035], [0, 0.035]], 20), M.brass);
  cup.position.set(fx - side * 0.22, SCONCE_Y + 0.03, 0); g.add(cup);
  const glass = noAO(new THREE.Mesh(lathe([[0.02, 0], [0.035, 0.02], [0.05, 0.07], [0.058, 0.12], [0.062, 0.15]], 24), M.glass));
  glass.position.set(fx - side * 0.22, SCONCE_Y + 0.06, 0); g.add(glass);
  const glow = new THREE.Sprite(M.glow); glow.scale.set(0.7, 0.7, 1); glow.position.set(fx - side * 0.22, SCONCE_Y + 0.13, 0); g.add(glow);
  return g;
}

function buildLadder() {
  const g = new THREE.Group();
  const H = 3.66;
  for (const s of [-1, 1]) box(0.05, H, 0.055, M.wood, 0, H / 2, s * 0.23, g, 0.012);
  for (let y = 0.3; y < H - 0.1; y += 0.3) { const r = cyl(0.016, 0.016, 0.46, M.woodDark, 0, y, 0, g, 12); r.rotation.x = Math.PI / 2; }
  for (const s of [-1, 1]) {
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.008, 8, 20, Math.PI * 1.2), M.brass);
    hook.position.set(-0.02, H + 0.01, s * 0.23); hook.rotation.y = Math.PI / 2; g.add(hook);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.025, 20), M.brass);
    wheel.rotation.x = Math.PI / 2; wheel.position.set(0, 0.04, s * 0.23); g.add(wheel);
  }
  return g;
}

function buildCandle() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(lathe([[0, 0], [0.06, 0], [0.065, 0.006], [0.05, 0.012], [0.014, 0.02], [0.012, 0.06], [0.02, 0.07], [0.028, 0.08], [0.028, 0.085], [0, 0.085]], 24), M.brass));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.004, 8, 20, Math.PI * 1.5), M.brass);
  ring.position.set(0.075, 0.03, 0); ring.rotation.y = Math.PI / 2; g.add(ring);
  const wax = new THREE.Mesh(lathe([[0, 0], [0.019, 0], [0.019, 0.1], [0.015, 0.108], [0.006, 0.11], [0, 0.11]], 18), M.wax);
  wax.position.y = 0.085; wax.name = 'wax'; g.add(wax);
  const wick = cyl(0.0015, 0.0015, 0.015, M.iron, 0, 0.2, 0, g, 6); wick.name = 'wick';
  const flame = new THREE.Sprite(M.flame); flame.scale.set(0.035, 0.07, 1); flame.position.y = 0.225; flame.name = 'flame'; g.add(flame);
  const glow = new THREE.Sprite(M.glow); glow.scale.set(0.35, 0.35, 1); glow.position.y = 0.22; glow.name = 'cglow'; g.add(glow);
  return g;
}

function buildProps() {
  const g = new THREE.Group();
  const open = new THREE.Group();
  box(0.36, 0.012, 0.25, M.leathers[0], 0, 0.796, 0, open, 0.004);
  for (const s of [-1, 1]) {
    const p = box(0.165, 0.016, 0.23, M.pages, s * 0.085, 0.812, 0, open, 0.003);
    p.rotation.z = -s * 0.1;
  }
  g.add(open);
  const stack = new THREE.Group();
  let y = 0.79;
  const r = rng(99);
  for (let i = 0; i < 4; i++) {
    const t = 0.03 + r() * 0.03;
    const b = box(0.17 + r() * 0.05, t, 0.24 + r() * 0.04, M.leathers[(i * 3) % LEATHER.length], 0, y + t / 2, 0, stack, 0.004);
    b.rotation.y = (r() - 0.5) * 0.5;
    y += t;
  }
  g.add(stack);
  const candle = buildCandle(); g.add(candle);
  // books that fell (or were thrown) onto the floor
  const fallen = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const t = 0.03 + r() * 0.04;
    const b = box(0.16 + r() * 0.06, t, 0.23 + r() * 0.05, M.leathers[(i * 5 + 2) % LEATHER.length], (r() - 0.5) * 0.5, t / 2 + (i > 2 ? 0.05 : 0), (r() - 0.5) * 0.6, fallen, 0.004);
    b.rotation.set((r() - 0.5) * 0.2, r() * Math.PI, i > 2 ? 0.25 : 0);
  }
  const lost = new THREE.Group();
  box(0.34, 0.01, 0.24, M.leathers[4], 0, 0.005, 0, lost, 0.003);
  for (const s of [-1, 1]) { const p = box(0.16, 0.014, 0.22, M.pages, s * 0.083, 0.016, 0, lost, 0.003); p.rotation.z = -s * 0.12; }
  lost.position.set(0.35, 0, 0.5); lost.rotation.y = 0.7; fallen.add(lost);
  g.add(fallen);
  return { g, open, stack, candle, fallen };
}

const shelfTemplate = buildShelfUnit();
const tableTemplate = buildTable();
const chairTemplate = buildChair();
const ladderTemplate = buildLadder();
const lampTemplate = buildLamp();
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const plaqueTex = tex(plaqueCanvas('YOUR COLLECTION'));
const plaqueMat = new THREE.MeshStandardMaterial({ map: plaqueTex, metalness: 0.5, roughness: 0.45 });
const plaqueGeo = new THREE.PlaneGeometry(0.62, 0.1);
const webGeo = new THREE.PlaneGeometry(0.75, 0.75);

/* ============================================================
   Segment pool
   ============================================================ */
const slots = [];
const dummy = new THREE.Object3D();
const tmpColor = new THREE.Color();
let userSegs = 1;               // segments holding your books (kept free of clutter)
let occ = null;                 // where your collection ends: { unit, li, cur }

// Example books fill every shelf your own books haven't reached yet, so as
// your collection grows it pushes them further down the hall.
function freeEnd(unit, level) {
  const end = SHELF_LEN / 2 - 0.02;
  if (!occ || unit > occ.unit) return end;
  const idx = FILL_ORDER.indexOf(level);
  if (idx === -1) return end;                       // the high shelves are never yours
  if (unit < occ.unit || idx < occ.li) return null; // your shelf
  if (idx === occ.li) return end - occ.cur - 0.08;  // shared shelf: stop at your bookend
  return end;
}
const candles = [];

function lampState(k) {
  // Some lamps further in have died. Yours never do.
  if (k < 3) return 1;
  return rng(k * 131 + 7)() < 0.16 ? 0 : 1;
}

function makeSlot() {
  const g = new THREE.Group(); scene.add(g);
  g.add(shelfTemplate.clone());
  const right = shelfTemplate.clone(); right.rotation.y = Math.PI; g.add(right);

  const filler = new THREE.InstancedMesh(unitBox, M.filler, FILL_CAP);
  filler.frustumCulled = false;
  filler.setColorAt(0, tmpColor.set(1, 1, 1));
  filler.count = 0;
  g.add(filler);

  g.add(tableTemplate.clone());
  const chairs = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const c = chairTemplate.clone(); c.userData.base = { sx, sz }; chairs.push(c); g.add(c); }

  // each lamp gets its own glowing materials so it can flicker or die alone
  const lamp = lampTemplate.clone();
  const mats = { bulb: M.bulb.clone(), inner: M.shadeInside.clone(), glow: M.glow.clone(), shaft: M.shaft.clone() };
  lamp.getObjectByName('bulb').material = mats.bulb;
  lamp.getObjectByName('inner').material = mats.inner;
  lamp.getObjectByName('glow').material = mats.glow;
  lamp.getObjectByName('shaft').material = mats.shaft;
  g.add(lamp);

  const poolMatT = M.poolTable.clone(), poolMatF = M.poolFloor.clone();
  const poolT = noAO(new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), poolMatT));
  poolT.rotation.x = -Math.PI / 2; poolT.position.y = 0.795; g.add(poolT);
  const poolF = noAO(new THREE.Mesh(new THREE.PlaneGeometry(5, 5), poolMatF));
  poolF.rotation.x = -Math.PI / 2; poolF.position.y = 0.008; g.add(poolF);

  for (const sd of [-1, 1]) { const sc = buildSconce(sd); sc.position.z = SEG / 2; g.add(sc); }

  const plaques = [-1, 1].map((s) => {
    const p = new THREE.Mesh(plaqueGeo, plaqueMat);
    p.position.set(s * (AISLE - 0.004), LEVELS[9] - 0.075, 0);
    p.rotation.y = s < 0 ? Math.PI / 2 : -Math.PI / 2;
    g.add(p); return p;
  });

  const webs = [];
  for (let i = 0; i < 4; i++) {
    const w = noAO(new THREE.Mesh(webGeo, M.webs[i % M.webs.length]));
    g.add(w); webs.push(w);
  }

  const ladder = ladderTemplate.clone(); g.add(ladder);
  const props = buildProps(); g.add(props.g);

  // books stacked and spilled on the floor, and loose pages
  const piles = new THREE.InstancedMesh(unitBox, M.filler, 260);
  piles.frustumCulled = false;
  piles.setColorAt(0, tmpColor.set(1, 1, 1));
  piles.count = 0;
  g.add(piles);
  const loose = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.15, 0.21).rotateX(-Math.PI / 2), M.paper, 40);
  loose.frustumCulled = false;
  loose.count = 0;
  g.add(loose);
  candles.push(props.candle);

  return { g, filler, piles, loose, chairs, lamp, mats, poolMatT, poolMatF, plaques, webs, ladder, props, k: -1, on: 1 };
}

function fillSlot(s, k) {
  s.k = k;
  s.g.position.z = -(k + 0.5) * SEG;
  const r = rng(k * 7919 + 31);
  let n = 0;
  {
    for (const side of [-1, 1]) {
      const unit = 2 * k + (side > 0 ? 1 : 0);
      for (let level = 0; level < LEVELS.length; level++) {
        const y = LEVELS[level];
        const end = freeEnd(unit, level);
        if (end === null) continue;
        const high = level > 8;
        let z = -SHELF_LEN / 2 + 0.02;
        while (n < FILL_CAP) {
          if (r() < (high ? 0.04 : 0.025)) z += 0.05 + r() * 0.35;
          const t = high ? 0.03 + r() * 0.06 : 0.018 + r() * 0.045 + (r() < 0.1 ? r() * 0.04 : 0);
          if (z + t > end) break;
          const h = Math.min(GAP - 0.05, 0.19 + r() * 0.16);
          const d = 0.13 + r() * 0.12;
          dummy.position.set(side * (AISLE + 0.012 + d / 2 + r() * 0.02), y + h / 2, z + t / 2);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(d, h, t);
          dummy.updateMatrix();
          s.filler.setMatrixAt(n, dummy.matrix);
          tmpColor.set(LEATHER[(r() * LEATHER.length) | 0]).offsetHSL((r() - 0.5) * 0.03, (r() - 0.5) * 0.1, (r() - 0.5) * 0.06 - 0.02);
          s.filler.setColorAt(n, tmpColor);
          n++;
          z += t + 0.0015;
        }
      }
    }
  }
  s.filler.count = n;
  s.filler.instanceMatrix.needsUpdate = true;
  if (s.filler.instanceColor) s.filler.instanceColor.needsUpdate = true;

  // floor piles: towers against the shelves, a stack under the table, a spill
  let pn = 0;
  const PCAP = 260;
  const bookAt = (x, y, z, d, t, h, rx, ry, rz) => {
    dummy.position.set(x, y, z); dummy.rotation.set(rx, ry, rz); dummy.scale.set(d, t, h); dummy.updateMatrix();
    s.piles.setMatrixAt(pn, dummy.matrix);
    tmpColor.set(LEATHER[(r() * LEATHER.length) | 0]).offsetHSL(0, (r() - 0.5) * 0.1, (r() - 0.5) * 0.05 - 0.03);
    s.piles.setColorAt(pn, tmpColor);
    pn++;
  };
  const tower = (x, z, count, messy) => {
    let y = 0;
    for (let i = 0; i < count && pn < PCAP; i++) {
      const t = 0.025 + r() * 0.05, d = 0.16 + r() * 0.1, h = 0.22 + r() * 0.1;
      const j = messy ? 0.06 : 0.02;
      bookAt(x + (r() - 0.5) * j, y + t / 2, z + (r() - 0.5) * j, d, t, h, 0, (r() - 0.5) * (messy ? 1.0 : 0.3), 0);
      y += t;
    }
  };
  if (k >= userSegs) {
    const count = 4 + ((r() * 6) | 0);
    for (let i = 0; i < count; i++) {
      const side = r() < 0.5 ? -1 : 1;
      tower(side * (AISLE - 0.17 - r() * 0.07), (r() - 0.5) * (SHELF_LEN - 0.6), 2 + ((r() * 14) | 0), r() < 0.35);
    }
    if (r() < 0.6) tower((r() - 0.5) * 0.4, (r() - 0.5) * 1.8, 3 + ((r() * 8) | 0), false);   // under the table
    if (r() < 0.5) {                                                                        // a spill
      const side = r() < 0.5 ? -1 : 1, cx = side * (AISLE - 0.55), cz = (r() - 0.5) * (SHELF_LEN - 1.5);
      for (let i = 0; i < 7 && pn < PCAP; i++) {
        const t = 0.025 + r() * 0.04;
        bookAt(cx + (r() - 0.5) * 0.7, t / 2 + (r() < 0.3 ? 0.04 : 0), cz + (r() - 0.5) * 0.9, 0.16 + r() * 0.08, t, 0.22 + r() * 0.08,
          (r() - 0.5) * 0.15, r() * Math.PI, (r() - 0.5) * 0.15);
      }
    }
  }
  s.piles.count = pn;
  s.piles.instanceMatrix.needsUpdate = true;
  if (s.piles.instanceColor) s.piles.instanceColor.needsUpdate = true;
  let ln = 0;
  if (k >= userSegs) {
    const pages = 3 + ((r() * 14) | 0);
    for (; ln < pages; ln++) {
      dummy.position.set((r() - 0.5) * 2 * (AISLE - 0.4), 0.007 + ln * 0.0004, (r() - 0.5) * (SHELF_LEN - 0.4));
      dummy.rotation.set(0, r() * Math.PI * 2, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
      s.loose.setMatrixAt(ln, dummy.matrix);
    }
  }
  s.loose.count = ln;
  s.loose.instanceMatrix.needsUpdate = true;

  for (const c of s.chairs) {
    const { sx, sz } = c.userData.base;
    const toppled = k > 2 && r() < 0.06;
    const out = r() < 0.3 ? 0.15 + r() * 0.2 : r() * 0.05;
    c.position.set(sx * (0.8 + out), 0, sz * 0.62 + (r() - 0.5) * 0.12);
    c.rotation.set(0, -sx * Math.PI / 2 + (r() - 0.5) * (out > 0.1 ? 0.7 : 0.12), 0);
    if (toppled) { c.rotation.z = sx * 1.45; c.position.y = 0.2; c.position.x = sx * 1.25; }
  }
  s.plaques.forEach((p, i) => { p.visible = occ ? 2 * k + i <= occ.unit : k === 0 && i === 0; });

  // lamp on or dead
  s.on = lampState(k);
  s.lamp.getObjectByName('glow').visible = !!s.on;
  s.lamp.getObjectByName('shaft').visible = !!s.on;
  s.mats.bulb.emissiveIntensity = s.on ? 4.5 : 0;
  s.mats.inner.emissiveIntensity = s.on ? 0.45 : 0;
  s.poolMatT.opacity = s.on ? 0.2 : 0;
  s.poolMatF.opacity = s.on ? 0.08 : 0;

  // cobwebs in the top corners where the crown meets the columns
  s.webs.forEach((w, i) => {
    const side = i < 2 ? -1 : 1;
    const end = i % 2 ? 1 : -1;
    w.visible = k >= userSegs && r() < 0.45;
    w.position.set(side * (AISLE - 0.09), UNIT_H - 0.38, end * (SHELF_LEN / 2 - 0.35));
    w.rotation.set(0, side < 0 ? Math.PI / 2 : -Math.PI / 2, 0);
    w.scale.set(end * side * (0.8 + r() * 0.5), 0.8 + r() * 0.4, 1);
  });

  const ladderSide = r() < 0.5 ? -1 : 1;
  s.ladder.visible = k >= userSegs && r() < 0.4;
  s.ladder.position.set(ladderSide * (AISLE - 0.78), 0, (r() - 0.5) * (SHELF_LEN - 1.6));
  s.ladder.rotation.set(0, 0, ladderSide * -0.18);

  const P = s.props;
  P.open.visible = r() < 0.4;
  P.open.position.set(0, 0, (r() - 0.5) * 1.6);
  P.open.rotation.y = (r() - 0.5) * 0.6;
  P.stack.visible = r() < 0.4;
  P.stack.position.set((r() - 0.5) * 0.3, 0, (r() - 0.5) * 1.8);
  P.candle.visible = k === 0 || r() < 0.55;
  P.candle.position.set(k === 0 ? 0.2 : (r() - 0.5) * 0.5, 0.79, k === 0 ? 1.0 : (r() - 0.5) * 2);
  const waxH = 0.3 + r() * 0.7;
  P.candle.getObjectByName('wax').scale.y = waxH;
  P.candle.getObjectByName('wick').position.y = 0.085 + 0.11 * waxH + 0.006;
  P.candle.getObjectByName('flame').position.y = 0.085 + 0.11 * waxH + 0.035;
  P.candle.getObjectByName('cglow').position.y = 0.085 + 0.11 * waxH + 0.03;
  P.candle.userData.seed = r() * 100;
  P.fallen.visible = k >= userSegs && r() < 0.3;
  const fs = r() < 0.5 ? -1 : 1;
  P.fallen.position.set(fs * (AISLE - 0.5), 0, (r() - 0.5) * (SHELF_LEN - 1.6));
  P.fallen.rotation.y = r() * Math.PI;
}

for (let i = 0; i < POOL; i++) slots.push(makeSlot());

function updatePool(force = false) {
  const ks = Math.floor(-player.z / SEG);
  const base = Math.max(0, ks - 2);
  for (let k = base; k < base + POOL; k++) {
    const s = slots[k % POOL];
    if (force || s.k !== k) fillSlot(s, k);
  }
}

/* ============================================================
   Light: only the nearest lamps and sconces get real lights
   ============================================================ */
scene.add(new THREE.HemisphereLight(0x5a4a3c, 0x0a0604, 0.2));
const sconceLights = [];
for (let i = 0; i < 5; i++) { const l = new THREE.PointLight(0xffa252, 6, 9, 2); scene.add(l); sconceLights.push(l); }
const lampLights = [];
for (let i = 0; i < 6; i++) { const l = new THREE.PointLight(0xffb36b, 62, 18, 2); scene.add(l); lampLights.push(l); }

/* ============================================================
   Dust in the lamplight
   ============================================================ */
const DUST = 900;
const dustPos = new Float32Array(DUST * 3);
const dustSeed = new Float32Array(DUST);
{
  const r = rng(42);
  for (let i = 0; i < DUST; i++) {
    dustPos[i * 3] = (r() - 0.5) * 5;
    dustPos[i * 3 + 1] = r() * 4.6;
    dustPos[i * 3 + 2] = -r() * 16;
    dustSeed[i] = r() * 100;
  }
}
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
  size: 0.013, map: glowTex, color: 0xffd9a0, transparent: true, opacity: 0.5,
  blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
}));
dust.frustumCulled = false;
scene.add(dust);

/* ============================================================
   Storage (IndexedDB, falls back to memory)
   ============================================================ */
async function openStore() {
  try {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('divine-library', 3);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('diary')) d.createObjectStore('diary', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('pdfs')) d.createObjectStore('pdfs', { keyPath: 'id' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const run = (name, mode, fn) => new Promise((res, rej) => {
      const t = db.transaction(name, mode);
      const r = fn(t.objectStore(name));
      t.oncomplete = () => res(r.result);
      t.onerror = () => rej(t.error);
    });
    return {
      all: (name) => run(name, 'readonly', (s) => s.getAll()),
      get: (name, id) => run(name, 'readonly', (s) => s.get(id)),
      put: (name, v) => run(name, 'readwrite', (s) => s.put(v)),
      del: (name, id) => run(name, 'readwrite', (s) => s.delete(id)),
    };
  } catch (e) {
    console.warn('IndexedDB unavailable, nothing will be saved', e);
    const mem = { books: new Map(), diary: new Map(), pdfs: new Map() };
    return {
      all: async (n) => [...mem[n].values()],
      get: async (n, id) => mem[n].get(id),
      put: async (n, v) => mem[n].set(v.id, v),
      del: async (n, id) => mem[n].delete(id),
    };
  }
}
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

/* ============================================================
   Your books
   ============================================================ */
let books = [];
let bookMeshes = [];
const coverUrls = new Map();
const texLoader = new THREE.TextureLoader();

function dims(b) {
  const T = TYPES[b.type] || TYPES.other;
  const pages = Math.max(1, Math.min(5000, Number(b.pages) || 200));
  return { h: T.h, d: T.d, t: T.cover + pages * T.perPage };
}

function layout() {
  const out = [];
  let unit = 0, li = 0, cur = 0;
  const usable = SHELF_LEN - 0.06;
  for (const b of books) {
    const dm = dims(b);
    if (cur > 0 && cur + dm.t > usable) {
      li++; cur = 0;
      if (li >= LEVELS.length) { li = 0; unit++; }
    }
    out.push({ b, dm, unit, level: FILL_ORDER[li], lz: -SHELF_LEN / 2 + 0.03 + cur + dm.t / 2 });
    cur += dm.t + 0.002;
  }
  return { out, lastUnit: unit, li, cur };
}

function textOn(hex) {
  const c = new THREE.Color(hex);
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return lum > 0.45 ? '#24160c' : '#e7c98a';
}

function spineCanvas(b, dm) {
  const W = 64, H = Math.max(128, Math.min(1024, Math.round(64 * dm.h / dm.t)));
  const c = makeCanvas(W, H), g = c.getContext('2d');
  const color = b.color || '#6b2a1f';
  g.fillStyle = color; g.fillRect(0, 0, W, H);
  const r = rng(String(b.id).split('').reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7));
  for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${r() * 0.06})`; g.fillRect(r() * W, r() * H, 2, 2); }
  const shade = g.createLinearGradient(0, 0, W, 0);
  shade.addColorStop(0, 'rgba(0,0,0,.4)'); shade.addColorStop(0.3, 'rgba(255,255,255,.07)'); shade.addColorStop(1, 'rgba(0,0,0,.4)');
  g.fillStyle = shade; g.fillRect(0, 0, W, H);
  const ink = textOn(color);
  g.fillStyle = ink; g.globalAlpha = 0.85;
  const band = Math.max(3, H * 0.008);
  for (const y of [H * 0.06, H * 0.075, H * 0.925, H * 0.94]) g.fillRect(0, y, W, band);
  g.globalAlpha = 1;
  g.save();
  g.translate(W / 2, H / 2); g.rotate(Math.PI / 2);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  let fs = Math.min(38, H * 0.12);
  const title = b.title || 'Untitled';
  const maxW = H * 0.72;
  do { g.font = `600 ${fs}px "Cormorant Garamond", Georgia, serif`; } while (g.measureText(title).width > maxW && --fs > 14);
  let text = title;
  while (g.measureText(text).width > maxW && text.length > 3) text = text.slice(0, -2) + '…';
  g.fillText(text, 0, 2);
  g.restore();
  return c;
}

function coverCanvas(b) {
  const W = 300, H = 440, c = makeCanvas(W, H), g = c.getContext('2d');
  const color = b.color || '#6b2a1f';
  g.fillStyle = color; g.fillRect(0, 0, W, H);
  const v = g.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, 300);
  v.addColorStop(0, 'rgba(255,255,255,.08)'); v.addColorStop(1, 'rgba(0,0,0,.45)');
  g.fillStyle = v; g.fillRect(0, 0, W, H);
  const ink = textOn(color);
  g.strokeStyle = ink; g.globalAlpha = 0.75;
  g.lineWidth = 2; g.strokeRect(18, 18, W - 36, H - 36);
  g.lineWidth = 1; g.strokeRect(26, 26, W - 52, H - 52);
  g.globalAlpha = 1;
  g.fillStyle = ink; g.textAlign = 'center';
  g.font = '600 34px "Cormorant Garamond", Georgia, serif';
  const words = (b.title || 'Untitled').split(/\s+/);
  const lines = []; let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (g.measureText(test).width > W - 80 && line) { lines.push(line); line = w; } else line = test;
  }
  if (line) lines.push(line);
  const y0 = 170 - (lines.length - 1) * 20;
  lines.slice(0, 5).forEach((l, i) => g.fillText(l, W / 2, y0 + i * 40));
  g.fillRect(W / 2 - 20, y0 + lines.length * 40 - 6, 40, 1.5);
  if (b.author) { g.font = 'italic 500 20px "EB Garamond", Georgia, serif'; g.fillText(b.author, W / 2, y0 + lines.length * 40 + 30); }
  return c;
}

function coverUrl(b) {
  if (!b.cover) return null;
  const cached = coverUrls.get(b.id);
  if (cached && cached.blob === b.cover) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(b.cover);
  coverUrls.set(b.id, { blob: b.cover, url });
  return url;
}

function makeBookMesh(b, dm) {
  const geo = new RoundedBoxGeometry(dm.d, dm.h, dm.t, 2, Math.min(0.003, dm.t * 0.2));
  const color = new THREE.Color(b.color || '#6b2a1f');
  const sc = spineCanvas(b, dm);
  const spine = new THREE.MeshStandardMaterial({ map: tex(sc), normalMap: tex(normalCanvas(sc, 3), { srgb: false }), normalScale: V2(1.2, 1.2), roughness: 0.55, emissive: 0x000000 });
  const back = new THREE.MeshStandardMaterial({ color, roughness: 0.6, normalMap: grainN, normalScale: V2(0.8, 0.8) });
  const cover = new THREE.MeshStandardMaterial({ map: tex(coverCanvas(b)), roughness: 0.5 });
  const url = coverUrl(b);
  if (url) texLoader.load(url, (t) => {
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = MAX_ANISO;
    cover.map?.dispose(); cover.map = t; cover.needsUpdate = true;
  });
  // +x spine, -z front cover, +z back cover
  return new THREE.Mesh(geo, [spine, M.pages, M.pages, M.pages, back, cover]);
}

function disposeMesh(m) {
  scene.remove(m);
  m.geometry.dispose();
  for (const mat of m.material) {
    if (mat === M.pages) continue;
    mat.map?.dispose();
    if (mat.normalMap && mat.normalMap !== grainN) mat.normalMap.dispose();
    mat.dispose();
  }
}

// a brass bookend marks where your collection ends and the old books begin
const bookend = new THREE.Group();
box(0.13, 0.2, 0.006, M.brass, 0, 0.1, 0, bookend, 0.002);
box(0.13, 0.006, 0.07, M.brass, 0, 0.003, 0.035, bookend, 0.002);
bookend.visible = false;
scene.add(bookend);
function placeBookend(p) {
  bookend.visible = !!p;
  if (!p) return;
  const seg = Math.floor(p.unit / 2), side = p.unit % 2 === 0 ? -1 : 1;
  const zEnd = -(seg + 0.5) * SEG - (p.lz + p.dm.t / 2) - 0.008;
  bookend.position.set(side * (AISLE + 0.08), LEVELS[p.level], zEnd);
  bookend.rotation.y = Math.PI;      // base plate tucks under the next books
}

function rebuildBooks() {
  bookMeshes.forEach(disposeMesh);
  bookMeshes = [];
  books.sort((a, b) => a.added - b.added);
  const { out, lastUnit, li, cur } = layout();
  for (const p of out) {
    const seg = Math.floor(p.unit / 2);
    const side = p.unit % 2 === 0 ? -1 : 1;
    const zc = -(seg + 0.5) * SEG;
    const m = makeBookMesh(p.b, p.dm);
    m.position.set(side * (AISLE + 0.012 + p.dm.d / 2), LEVELS[p.level] + p.dm.h / 2, zc - p.lz);
    m.rotation.y = side < 0 ? 0 : Math.PI;
    m.userData = { book: p.b, side, home: m.position.clone(), pull: 0, pullTarget: 0, glow: 0 };
    scene.add(m);
    bookMeshes.push(m);
  }
  occ = books.length ? { unit: lastUnit, li, cur } : null;
  userSegs = occ ? Math.floor(occ.unit / 2) + 1 : 1;
  placeBookend(out[out.length - 1]);
  updatePool(true);          // example books shuffle back to make room
  $('count').textContent = books.length === 1 ? '1 volume shelved' : `${books.length} volumes shelved`;
}

/* ============================================================
   The diary on the first reading table
   ============================================================ */
const diaryObj = new THREE.Group();
{
  const cover = new THREE.MeshStandardMaterial({ color: 0x3a1410, roughness: 0.55, normalMap: grainN, normalScale: V2(1.2, 1.2), emissive: 0x000000 });
  diaryObj.add(new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.045, 0.27, 2, 0.006), cover));
  const pages = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.035, 0.255), M.pages);
  pages.position.x = 0.006; diaryObj.add(pages);
  box(0.03, 0.05, 0.28, M.leathers[11], 0.06, 0, 0, diaryObj, 0.006);
  box(0.02, 0.014, 0.03, M.brass, 0.105, 0, 0, diaryObj, 0.003);
  const ribbon = box(0.012, 0.002, 0.12, new THREE.MeshStandardMaterial({ color: 0x6a0f12, roughness: 0.4 }), -0.03, -0.02, 0.18, diaryObj, 0);
  ribbon.rotation.x = 0.4;
  diaryObj.position.set(-0.2, 0.79 + 0.0225, -SEG / 2 + 0.95);
  diaryObj.rotation.y = 0.35;
  diaryObj.userData = { diary: true, highlight: cover };
  scene.add(diaryObj);
}

/* ============================================================
   Player
   ============================================================ */
const START = new THREE.Vector3(0, 0, -0.62);
const player = START.clone();
const vel = new THREE.Vector3();
let yaw = 0, pitch = -0.04, bobPhase = 0;
const keys = new Set();

function collide() {
  const lim = AISLE - 0.36;
  player.x = Math.max(-lim, Math.min(lim, player.x));
  player.z = Math.min(-0.45, player.z);
  // the lectern at the head of the first table
  {
    const hx = 0.5, hz = 0.36, dx = player.x, dz = player.z - LECTERN_Z;
    if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
      if (hx - Math.abs(dx) < hz - Math.abs(dz)) player.x = Math.sign(dx || 1) * hx;
      else player.z = LECTERN_Z + Math.sign(dz || 1) * hz;
    }
  }
  const k = Math.floor(-player.z / SEG);
  const zc = -(k + 0.5) * SEG;
  const hx = 1.15, hz = 1.52;
  const dx = player.x, dz = player.z - zc;
  if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
    const px = hx - Math.abs(dx), pz = hz - Math.abs(dz);
    if (px < pz) player.x = Math.sign(dx || 1) * hx;
    else player.z = zc + Math.sign(dz || 1) * hz;
  }
}

/* ============================================================
   UI state
   ============================================================ */
const menu = $('intro'), hud = $('hud');
const formModal = $('form-modal'), bookModal = $('book-modal'), diaryModal = $('diary-modal');
const hoverLabel = $('hover-label'), crosshair = $('crosshair');
let started = false, freeMode = false, everLocked = false, modal = null, fading = false;
let hovered = null, opened = null, editing = null;
const mouse = new THREE.Vector2();
const ray = new THREE.Raycaster();
ray.far = 3.6;

function isLocked() { return document.pointerLockElement === canvas; }

async function lock() {
  if (freeMode) return;
  try {
    const p = canvas.requestPointerLock();
    if (p && p.then) await p;
  } catch (e) {
    if (!everLocked) enableFreeMode();
    else if (!isLocked() && !modal && !fading && !readingNow()) openMenu();
  }
}

function enableFreeMode() {
  freeMode = true;
  document.body.classList.add('free');
  hideMenu();
  $('keys').textContent = 'WASD walk · Drag to look · Click a book · E shelve a book · J diary · Esc menu';
}

document.addEventListener('pointerlockchange', () => {
  if (isLocked()) { everLocked = true; hideMenu(); }
  else if (started && !modal && !freeMode && !fading && !readingNow()) openMenu();
});
document.addEventListener('pointerlockerror', () => { if (!everLocked) enableFreeMode(); });

function openMenu() {
  menu.hidden = false;
  hud.hidden = true;
  keys.clear();
  setHover(null);
  $('enter').textContent = 'Return to the stacks';
  $('menu-eyebrow').textContent = 'The library waits';
  $('menu-extra').hidden = false;
  $('find').hidden = books.length === 0;
  $('find-input').value = '';
  renderFind('');
}

function hideMenu() {
  menu.hidden = true;
  if (started) hud.hidden = false;
}

function openModal(el) {
  modal = el; el.hidden = false;
  hideMenu();
  keys.clear();
  setHover(null);
  if (isLocked()) document.exitPointerLock();
}

function closeModal() {
  if (!modal) return;
  const was = modal;
  modal.hidden = true; modal = null;
  if (was === bookModal && opened) { opened.userData.pullTarget = 0; opened = null; }
  if (was === diaryModal) flushDiary();
  if (started) lock();
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3800);
}

function highlightMat(o) { return o.userData.book ? o.material[0] : o.userData.highlight; }

function setHover(o) {
  if (hovered === o) return;
  if (hovered) highlightMat(hovered).emissive.setHex(0x000000);
  hovered = o;
  crosshair.classList.toggle('on', !!o);
  if (!o) { hoverLabel.hidden = true; return; }
  highlightMat(o).emissive.setHex(0x2b1c08);
  if (o.userData.lectern) {
    const n = books.filter((b) => b.hasPdf).length;
    hoverLabel.querySelector('.t').textContent = 'The lectern';
    hoverLabel.querySelector('.m').textContent = n ? 'Click to choose a book to read' : 'Attach a PDF to a book to read it here';
  } else if (o.userData.diary) {
    hoverLabel.querySelector('.t').textContent = 'Your diary';
    hoverLabel.querySelector('.m').textContent = 'Click to open and write';
  } else {
    const b = o.userData.book;
    hoverLabel.querySelector('.t').textContent = b.title;
    hoverLabel.querySelector('.m').textContent = [b.author, `${TYPES[b.type]?.label || 'Book'} · ${b.pages} pages${b.hasPdf ? ' · readable' : ''}`].filter(Boolean).join(' — ');
  }
  hoverLabel.hidden = false;
}

function pick(ndcX, ndcY) {
  mouse.set(ndcX, ndcY);
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObjects([...bookMeshes, diaryObj, lectern.g], true)[0];
  if (!hit) return null;
  let o = hit.object;
  while (o && !o.userData.book && !o.userData.diary && !o.userData.lectern) o = o.parent;
  return o;
}

function activate(o) {
  if (o.userData.lectern) openLecternPicker();
  else if (o.userData.diary) openDiary();
  else openBook(o);
}

/* ---------- menu buttons ---------- */
$('enter').addEventListener('click', () => {
  const first = !started;
  started = true;
  hideMenu();
  lock();
  if (first && !books.length) setTimeout(() => toast('Your shelves are empty. Press E to shelve your first book.'), 900);
});
$('pause-add').addEventListener('click', () => openForm(null));
$('pause-diary').addEventListener('click', () => openDiary());
$('to-entrance').addEventListener('click', () => returnToStart());

function renderFind(q) {
  const list = $('find-list');
  list.innerHTML = '';
  const query = q.trim().toLowerCase();
  books
    .filter((b) => !query || b.title.toLowerCase().includes(query) || (b.author || '').toLowerCase().includes(query))
    .slice(0, 50)
    .forEach((b) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.textContent = b.title;
      const small = document.createElement('small');
      small.textContent = b.author || TYPES[b.type]?.label || '';
      btn.append(small);
      btn.addEventListener('click', () => walkTo(b.id));
      li.append(btn); list.append(li);
    });
}
$('find-input').addEventListener('input', (e) => renderFind(e.target.value));

function walkTo(id) {
  const m = bookMeshes.find((x) => x.userData.book.id === id);
  if (!m) return;
  const { side, home } = m.userData;
  player.set(side * (AISLE - 1.25), 0, home.z);
  collide();
  yaw = side < 0 ? Math.PI / 2 : -Math.PI / 2;
  pitch = Math.atan2(home.y - EYE, Math.abs(home.x - player.x) - 0.1);
  vel.set(0, 0, 0);
  hideMenu();
  m.userData.glow = 1;
  lock();
}

/* ============================================================
   Going back to the start: the library takes you there
   ============================================================ */
let audioCtx = null;
let dread = 0;   // 0..1, makes the lamps stutter

function playDread() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const ac = audioCtx, t = ac.currentTime;
    const out = ac.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.32, t + 2.6);
    out.gain.linearRampToValueAtTime(0.0, t + 7.5);
    out.connect(ac.destination);
    for (const f of [41.2, 43.7, 61.7, 116.5]) {
      const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      o.frequency.linearRampToValueAtTime(f * 0.94, t + 7);
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(160, t); lp.frequency.linearRampToValueAtTime(520, t + 2.8); lp.frequency.linearRampToValueAtTime(90, t + 7);
      const gn = ac.createGain(); gn.gain.value = 0.11;
      o.connect(lp).connect(gn).connect(out); o.start(t); o.stop(t + 8);
    }
    // a breath of air through the stacks
    const len = ac.sampleRate * 8, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const n = ac.createBufferSource(); n.buffer = buf;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 6;
    bp.frequency.setValueAtTime(400, t); bp.frequency.linearRampToValueAtTime(1400, t + 3.2); bp.frequency.linearRampToValueAtTime(300, t + 6);
    const ng = ac.createGain(); ng.gain.setValueAtTime(0, t); ng.gain.linearRampToValueAtTime(0.22, t + 3.2); ng.gain.linearRampToValueAtTime(0, t + 6);
    n.connect(bp).connect(ng).connect(out); n.start(t); n.stop(t + 8);
  } catch { /* sound is optional */ }
}

const RETURN_LINES = [
  'The stacks remember where you began.',
  'Something closed the book behind you.',
  'The halls have moved since you last looked.',
  'You were never lost. Only kept.',
  'It knows the way back. It always has.',
  'Every corridor folds toward the door.',
  'It has been reading you, too.',
  'Somewhere far below, a page turns.',
  'The dark between the shelves remembers your name.',
  'You return. You always return.',
];
let lastLine = -1;
function setFadeText() {
  const el = $('fade-text');
  let i;
  do { i = Math.floor(Math.random() * RETURN_LINES.length); } while (i === lastLine);
  lastLine = i;
  el.className = '';
  el.innerHTML = '';
  RETURN_LINES[i].split(' ').forEach((word, j) => {
    const sp = document.createElement('span');
    sp.className = 'w'; sp.textContent = word;
    sp.style.transitionDelay = `${j * 0.32}s`;
    el.append(sp, ' ');
  });
  void el.offsetWidth;       // start every word hidden before it rises
}

async function returnToStart() {
  if (fading) return;
  fading = true;
  setHover(null);
  hideMenu();
  lock();
  keys.clear();
  playDread();
  const fade = $('fade'), text = $('fade-text'), vig = $('vignette');
  canvas.classList.add('dread');
  vig.classList.add('close');
  const t0 = performance.now();
  const ramp = setInterval(() => { dread = Math.min(1, (performance.now() - t0) / 2200); }, 50);
  await wait(900);
  fade.classList.remove('out'); fade.classList.add('in');
  await wait(2700);
  clearInterval(ramp);
  setFadeText();
  text.classList.add('show');               // the words mist in and keep drifting
  player.copy(START); yaw = 0; pitch = -0.04; vel.set(0, 0, 0);
  dread = 0;
  canvas.classList.remove('dread');
  vig.classList.remove('close');
  await wait(4600);
  text.classList.add('leave');              // ...and dissolve as the dark lifts
  fade.classList.add('out'); fade.classList.remove('in');
  await wait(3400);
  text.className = ''; text.innerHTML = '';
  fading = false;
}

/* ---------- input ---------- */
document.addEventListener('keydown', (e) => {
  if (readingNow()) {
    if (e.target === $('r-goto') && e.key !== 'Escape') return;
    const k = e.code;
    if (e.key === 'Escape') { e.preventDefault(); closeReading(); }
    else if (k === 'ArrowRight' || k === 'KeyD' || k === 'PageDown' || k === 'Space') { e.preventDefault(); turnPage(1); }
    else if (k === 'ArrowLeft' || k === 'KeyA' || k === 'PageUp') { e.preventDefault(); turnPage(-1); }
    else if (e.key === '+' || e.key === '=') reader.zoomT = Math.min(3.4, reader.zoomT * 1.25);
    else if (e.key === '-') reader.zoomT = Math.max(1, reader.zoomT / 1.25);
    return;
  }
  if (modal) {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
    return;
  }
  if (!started || !menu.hidden || fading) return;
  if (e.key === 'Escape') { e.preventDefault(); openMenu(); return; }   // when the mouse isn't captured
  if (e.code === 'KeyE') { e.preventDefault(); openForm(null); return; }
  if (e.code === 'KeyJ') { e.preventDefault(); openDiary(); return; }
  keys.add(e.code);
});
document.addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

let drag = null;
document.addEventListener('mousemove', (e) => {
  if (readingNow()) { reader.aimT.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); return; }
  if (fading) return;
  if (isLocked()) {
    yaw -= e.movementX * 0.0022;
    pitch -= e.movementY * 0.0022;
  } else if (freeMode && drag) {
    yaw -= (e.clientX - drag.x) * 0.004;
    pitch -= (e.clientY - drag.y) * 0.004;
    drag.moved += Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y);
    drag.x = e.clientX; drag.y = e.clientY;
  }
  pitch = Math.max(-1.35, Math.min(1.35, pitch));
  if (freeMode && !drag) {
    mouse.x = (e.clientX / innerWidth) * 2 - 1; mouse.y = -(e.clientY / innerHeight) * 2 + 1;
    hoverLabel.style.left = e.clientX + 'px'; hoverLabel.style.top = e.clientY + 24 + 'px';
  }
});
canvas.addEventListener('mousedown', (e) => {
  if (readingNow()) { if (reader.phase === 'read' || reader.phase === 'enter') turnPage(e.clientX < innerWidth / 2 ? -1 : 1); return; }
  if (!started || modal || fading) return;
  if (isLocked()) { if (hovered) activate(hovered); return; }
  if (!freeMode && menu.hidden) { lock(); return; }      // take the mouse back after reading
  if (freeMode) drag = { x: e.clientX, y: e.clientY, moved: 0 };
});
addEventListener('mouseup', (e) => {
  if (!drag) return;
  const clicked = drag.moved < 5;
  drag = null;
  if (clicked) {
    const o = pick((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    if (o) activate(o);
  }
});

/* ============================================================
   Book panel
   ============================================================ */
const removeBtn = $('b-remove');
function resetRemove() { removeBtn.textContent = 'Remove'; removeBtn.dataset.armed = ''; }

function openBook(m) {
  const b = m.userData.book;
  opened = m;
  m.userData.pullTarget = 1;
  resetRemove();
  $('b-type').textContent = TYPES[b.type]?.label || 'Book';
  $('b-title').textContent = b.title;
  $('b-author').textContent = b.author || '';
  $('b-cover').src = coverUrl(b) || coverCanvas(b).toDataURL('image/jpeg', 0.9);
  const meta = $('b-meta'); meta.innerHTML = '';
  const add = (k, v) => { if (!v) return; const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; meta.append(dt, dd); };
  add('Pages', String(b.pages));
  add('Finished', b.finished ? new Date(b.finished + 'T12:00').toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '');
  add('Rating', b.rating ? '★'.repeat(b.rating) + '☆'.repeat(5 - b.rating) : '');
  add('Spine', `${(dims(b).t * 100).toFixed(1)} cm`);
  const entries = diary.filter((d) => d.bookId === b.id && d.updated).length;
  add('Diary', entries ? `${entries} ${entries === 1 ? 'entry' : 'entries'}` : '');
  add('PDF', readingNote(b));
  $('b-read').hidden = !b.hasPdf;
  $('b-notes').textContent = b.notes || '';
  modal = bookModal; // claim the modal now so the menu doesn't appear while the book slides out
  if (isLocked()) document.exitPointerLock();
  setTimeout(() => openModal(bookModal), 220);
}

function putBookBack() {
  if (opened) { opened.userData.pullTarget = 0; opened = null; }
  bookModal.hidden = true; modal = null;
}

$('b-edit').addEventListener('click', () => {
  const b = opened?.userData.book;
  if (!b) return;
  putBookBack();
  openForm(b);
});
// Two clicks to remove, so a book is never lost to a stray click
removeBtn.addEventListener('click', async () => {
  const b = opened?.userData.book;
  if (!b) return;
  if (!removeBtn.dataset.armed) {
    removeBtn.dataset.armed = '1';
    removeBtn.textContent = 'Click again to remove';
    setTimeout(() => { if (removeBtn.dataset.armed) resetRemove(); }, 6000);
    return;
  }
  resetRemove();
  try { await store.del('books', b.id); } catch (err) { console.error(err); toast('Could not remove it from storage.'); return; }
  if (b.hasPdf) store.del('pdfs', b.id).catch((err) => console.error(err));
  books = books.filter((x) => x.id !== b.id);
  const cached = coverUrls.get(b.id);
  if (cached) { URL.revokeObjectURL(cached.url); coverUrls.delete(b.id); }
  opened = null;
  bookModal.hidden = true; modal = null;
  rebuildBooks();
  toast(`"${b.title}" was taken from the shelves.`);
  lock();
});
$('b-read').addEventListener('click', () => { const b = opened?.userData.book; if (b) openOnLectern(b); });
$('b-diary').addEventListener('click', () => {
  const b = opened?.userData.book;
  putBookBack();
  openDiary(b ? { bookId: b.id, title: b.title } : null);
});
document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', closeModal));
[formModal, bookModal, diaryModal, $('lectern-modal')].forEach((el) => el.addEventListener('mousedown', (e) => { if (e.target === el) closeModal(); }));

/* ============================================================
   Add / edit form
   ============================================================ */
const form = $('book-form');
let formCover = null;
let formRating = 0;

function setRating(v) {
  formRating = v;
  document.querySelectorAll('#f-rating button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) <= v));
}
document.querySelectorAll('#f-rating button').forEach((b) => b.addEventListener('click', () => setRating(formRating === Number(b.dataset.v) ? 0 : Number(b.dataset.v))));

function updateThickness() {
  const t = dims({ type: $('f-type').value, pages: $('f-pages').value }).t;
  $('thick-out').textContent = `${(t * 100).toFixed(1)} cm`;
  $('thick-fill').style.width = `${Math.min(100, (t / 0.09) * 100)}%`;
}
$('f-type').addEventListener('change', updateThickness);
$('f-pages').addEventListener('input', updateThickness);

function setCoverPreview(blob) {
  formCover = blob;
  const img = $('cover-preview');
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  if (blob) { const u = URL.createObjectURL(blob); img.src = u; img.dataset.url = u; }
  else { img.removeAttribute('src'); delete img.dataset.url; }
  $('cover-hint').hidden = !!blob;
  $('cover-clear').hidden = !blob;
}

async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
  const c = makeCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.88));
}
async function takeFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  try { setCoverPreview(await shrinkImage(file)); } catch { toast('That image could not be read.'); }
}
$('f-cover').addEventListener('change', (e) => takeFile(e.target.files[0]));
$('cover-clear').addEventListener('click', () => { setCoverPreview(null); $('f-cover').value = ''; });
const drop = $('cover-drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); takeFile(e.dataTransfer.files[0]); });

/* ---------- attaching a PDF ---------- */
let formPdf;                     // undefined: unchanged · null: remove it · object: a new file
const pdfInfo = $('pdf-info'), pdfClear = $('pdf-clear');
const PDF_HINT = 'Attach one to read it on the lectern';
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
function showPdfInfo(text, removable) { pdfInfo.textContent = text; pdfClear.hidden = !removable; }
$('pdf-pick').addEventListener('click', () => $('f-pdf').click());
$('f-pdf').addEventListener('change', (e) => takePdf(e.target.files[0]));
pdfClear.addEventListener('click', () => { formPdf = null; $('f-pdf').value = ''; showPdfInfo(PDF_HINT, false); });

async function takePdf(file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { toast('That file is not a PDF.'); return; }
  const before = [pdfInfo.textContent, !pdfClear.hidden];
  showPdfInfo('Reading the PDF…', false);
  try {
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = doc.numPages;
    formPdf = { blob: file, name: file.name, size: file.size, pages };
    $('f-pages').value = pages;
    updateThickness();
    if (!$('f-title').value.trim()) $('f-title').value = file.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim();
    if (!formCover) {
      // no cover yet: use the first page
      const page = await doc.getPage(1);
      const vp0 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 900 / Math.max(vp0.width, vp0.height) });
      const c = makeCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      setCoverPreview(await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88)));
    }
    doc.destroy();
    showPdfInfo(`${file.name} · ${pages} pages · ${fmtSize(file.size)}`, true);
  } catch (err) {
    console.error(err);
    showPdfInfo(...before);
    $('f-pdf').value = '';
    toast(err?.name === 'PasswordException' ? 'That PDF is locked with a password.' : 'That PDF could not be opened.');
  }
}

function openForm(b) {
  editing = b;
  formPdf = undefined;
  $('f-pdf').value = '';
  showPdfInfo(b?.hasPdf ? `${b.pdfName} · ${b.pdfPages} pages` : PDF_HINT, !!b?.hasPdf);
  $('form-eyebrow').textContent = b ? 'Amend the record' : 'A new volume';
  $('form-heading').textContent = b ? 'Edit this book' : 'Shelve a book';
  $('form-submit').textContent = b ? 'Save changes' : 'Place on the shelf';
  $('f-title').value = b?.title || '';
  $('f-author').value = b?.author || '';
  $('f-type').value = b?.type || 'book';
  $('f-pages').value = b?.pages || 300;
  $('f-finished').value = b?.finished || new Date().toISOString().slice(0, 10);
  $('f-color').value = b?.color || LEATHER[Math.floor(Math.random() * LEATHER.length)];
  $('f-notes').value = b?.notes || '';
  $('f-cover').value = '';
  setRating(b?.rating || 0);
  setCoverPreview(b?.cover || null);
  updateThickness();
  openModal(formModal);
  setTimeout(() => $('f-title').focus(), 50);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const rec = {
    id: editing?.id || newId(),
    added: editing?.added || Date.now(),
    title: $('f-title').value.trim() || 'Untitled',
    author: $('f-author').value.trim(),
    type: $('f-type').value,
    pages: Math.max(1, Math.min(5000, parseInt($('f-pages').value, 10) || 200)),
    finished: $('f-finished').value,
    color: $('f-color').value,
    rating: formRating,
    notes: $('f-notes').value.trim(),
    cover: formCover,
    hasPdf: !!editing?.hasPdf,
    pdfName: editing?.pdfName || '',
    pdfPages: editing?.pdfPages || 0,
    pdfSize: editing?.pdfSize || 0,
    readPage: editing?.readPage || 0,
  };
  if (formPdf) {
    try {
      await store.put('pdfs', { id: rec.id, blob: formPdf.blob });
      Object.assign(rec, { hasPdf: true, pdfName: formPdf.name, pdfPages: formPdf.pages, pdfSize: formPdf.size, readPage: 0 });
    } catch (err) { console.error(err); toast('The PDF could not be kept — it may be too large for this browser.'); }
  } else if (formPdf === null && rec.hasPdf) {
    store.del('pdfs', rec.id).catch((err) => console.error(err));
    Object.assign(rec, { hasPdf: false, pdfName: '', pdfPages: 0, pdfSize: 0, readPage: 0 });
  }
  try { await store.put('books', rec); } catch (err) { console.error(err); toast('Could not save — your browser may be blocking storage.'); }
  const wasEdit = !!editing;
  books = books.filter((x) => x.id !== rec.id).concat(rec);
  rebuildBooks();
  const m = bookMeshes.find((x) => x.userData.book.id === rec.id);
  if (m) m.userData.glow = 1;
  closeModal();
  if (!wasEdit && m) {
    const seg = Math.floor(-m.userData.home.z / SEG);
    toast(`"${rec.title}" now rests on the ${m.userData.side < 0 ? 'left' : 'right'} shelf of hall ${seg + 1}.`);
  } else toast('Saved.');
});

/* ============================================================
   Diary
   ============================================================ */
let diary = [];
let current = null;          // entry being edited
let saveTimer = null;
const dTitle = $('d-title'), dDate = $('d-date'), dBook = $('d-book'), dBody = $('d-body');
const dDelete = $('d-delete');

const fmtDate = (iso) => iso ? new Date(iso + 'T12:00').toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
const bookTitle = (id) => books.find((b) => b.id === id)?.title || '';
const keptAt = (ts) => `Kept ${new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

function sortDiary() { diary.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.created - a.created); }

function renderDiaryList() {
  sortDiary();
  const list = $('d-entries');
  list.innerHTML = '';
  for (const d of diary) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = d === current ? 'on' : '';
    btn.textContent = d.title || 'Untitled entry';
    const small = document.createElement('small');
    small.textContent = [fmtDate(d.date), bookTitle(d.bookId)].filter(Boolean).join(' · ');
    btn.append(small);
    btn.addEventListener('click', () => { flushDiary(); showEntry(d); });
    li.append(btn); list.append(li);
  }
  $('d-empty').hidden = !!current;
  $('d-editor').hidden = !current;
}

function fillBookSelect() {
  dBook.innerHTML = '<option value="">Not about a particular book</option>';
  for (const b of [...books].sort((a, b) => a.title.localeCompare(b.title))) {
    const o = document.createElement('option'); o.value = b.id; o.textContent = b.title; dBook.append(o);
  }
}

function showEntry(d) {
  current = d;
  dTitle.value = d.title || '';
  dDate.value = d.date || '';
  dBook.value = books.some((b) => b.id === d.bookId) ? d.bookId : '';
  dBody.value = d.body || '';
  $('d-saved').textContent = d.updated ? keptAt(d.updated) : '';
  dDelete.textContent = 'Delete entry'; dDelete.dataset.armed = '';
  renderDiaryList();
}

function dropBlankEntry() {
  // an entry that was never written in disappears instead of cluttering the list
  if (current && !current.updated && !current.title.trim() && !current.body.trim()) {
    diary = diary.filter((x) => x !== current);
    current = null;
  }
}

function newEntry(about) {
  flushDiary();
  dropBlankEntry();
  const d = {
    id: newId(), created: Date.now(), updated: 0,
    date: new Date().toISOString().slice(0, 10),
    title: about?.title ? `On ${about.title}` : '',
    bookId: about?.bookId || '', body: '',
  };
  diary.push(d);
  showEntry(d);
  setTimeout(() => (about ? dBody : dTitle).focus(), 30);
}

function openDiary(about) {
  fillBookSelect();
  openModal(diaryModal);
  if (about) newEntry(about);
  else if (current && diary.includes(current)) showEntry(current);
  else { current = null; sortDiary(); if (diary[0]) showEntry(diary[0]); else renderDiaryList(); }
}

function markDirty() {
  if (!current) return;
  current.title = dTitle.value;
  current.date = dDate.value;
  current.bookId = dBook.value;
  current.body = dBody.value;
  $('d-saved').textContent = 'Writing…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushDiary, 600);
}
[dTitle, dDate, dBody].forEach((el) => el.addEventListener('input', markDirty));
dBook.addEventListener('change', () => { markDirty(); renderDiaryList(); });
dTitle.addEventListener('change', renderDiaryList);
dDate.addEventListener('change', renderDiaryList);

async function flushDiary() {
  clearTimeout(saveTimer);
  const d = current;
  if (!d) return;
  if (!d.updated && !d.title.trim() && !d.body.trim()) return;   // still blank: nothing to keep yet
  d.updated = Date.now();
  try { await store.put('diary', { ...d }); if (d === current) $('d-saved').textContent = keptAt(d.updated); }
  catch (err) { console.error(err); $('d-saved').textContent = 'Could not save'; }
}

$('d-new').addEventListener('click', () => newEntry());
$('d-first').addEventListener('click', () => newEntry());
dDelete.addEventListener('click', async () => {
  if (!current) return;
  if (!dDelete.dataset.armed) {
    dDelete.dataset.armed = '1'; dDelete.textContent = 'Click again to delete';
    setTimeout(() => { dDelete.dataset.armed = ''; dDelete.textContent = 'Delete entry'; }, 6000);
    return;
  }
  const d = current;
  clearTimeout(saveTimer);
  try { await store.del('diary', d.id); } catch (err) { console.error(err); }
  diary = diary.filter((x) => x !== d);
  current = null;
  sortDiary();
  if (diary[0]) showEntry(diary[0]); else renderDiaryList();
});

function savedEntries() {
  sortDiary();
  return diary.filter((d) => d.title.trim() || d.body.trim()).slice().reverse();   // oldest first
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$('d-txt').addEventListener('click', async () => {
  await flushDiary();
  const list = savedEntries();
  if (!list.length) { toast('There is nothing in your diary yet.'); return; }
  const rule = '─'.repeat(48);
  let out = `THE DIVINE LIBRARY — DIARY\nExported ${fmtDate(new Date().toISOString().slice(0, 10))}\n\n`;
  for (const d of list) {
    out += `${rule}\n${fmtDate(d.date)}\n${d.title || 'Untitled entry'}\n`;
    if (bookTitle(d.bookId)) out += `On: ${bookTitle(d.bookId)}\n`;
    out += `\n${d.body.trim()}\n\n`;
  }
  download(new Blob([out], { type: 'text/plain;charset=utf-8' }), 'divine-library-diary.txt');
});

function loadJsPDF() {
  if (window.jspdf) return Promise.resolve(window.jspdf);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.onload = () => res(window.jspdf); s.onerror = rej;
    document.head.append(s);
  });
}

$('d-pdf').addEventListener('click', async () => {
  await flushDiary();
  const list = savedEntries();
  if (!list.length) { toast('There is nothing in your diary yet.'); return; }
  let jsPDF;
  try { ({ jsPDF } = await loadJsPDF()); } catch { toast('Could not load the PDF maker. Check your connection.'); return; }
  const doc = new jsPDF({ unit: 'pt', format: 'a5' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), mx = 46, top = 56, bottom = H - 50;
  const paper = () => { doc.setFillColor(243, 236, 220); doc.rect(0, 0, W, H, 'F'); };
  const ink = () => doc.setTextColor(43, 29, 16);
  // title page
  paper(); ink();
  doc.setFont('times', 'normal'); doc.setFontSize(10); doc.setCharSpace(3);
  doc.text('EST. BEFORE MEMORY', W / 2, H / 2 - 54, { align: 'center' });
  doc.setCharSpace(0); doc.setFontSize(28);
  doc.text('The Divine Library', W / 2, H / 2 - 20, { align: 'center' });
  doc.setFont('times', 'italic'); doc.setFontSize(13);
  doc.text('A diary kept among the stacks', W / 2, H / 2 + 6, { align: 'center' });
  doc.setDrawColor(150, 120, 70); doc.line(W / 2 - 30, H / 2 + 24, W / 2 + 30, H / 2 + 24);
  doc.setFont('times', 'normal'); doc.setFontSize(10);
  doc.text(`${list.length} ${list.length === 1 ? 'entry' : 'entries'} - exported ${fmtDate(new Date().toISOString().slice(0, 10))}`, W / 2, H / 2 + 44, { align: 'center' });

  let y = top;
  const page = () => { doc.addPage(); paper(); ink(); y = top; };
  page();
  for (const d of list) {
    if (y > bottom - 90) page();
    doc.setFont('times', 'italic'); doc.setFontSize(10); doc.setTextColor(120, 95, 60);
    doc.text(fmtDate(d.date), mx, y); y += 20;
    ink(); doc.setFont('times', 'bold'); doc.setFontSize(16);
    for (const l of doc.splitTextToSize(d.title || 'Untitled entry', W - mx * 2)) { doc.text(l, mx, y); y += 20; }
    if (bookTitle(d.bookId)) { doc.setFont('times', 'italic'); doc.setFontSize(11); doc.text(`On ${bookTitle(d.bookId)}`, mx, y); y += 18; }
    y += 6;
    doc.setFont('times', 'normal'); doc.setFontSize(11.5);
    for (const para of d.body.trim().split(/\n/)) {
      const lines = para ? doc.splitTextToSize(para, W - mx * 2) : [''];
      for (const l of lines) { if (y > bottom) page(); doc.text(l, mx, y); y += 16; }
    }
    y += 12;
    doc.setDrawColor(190, 165, 120); doc.line(W / 2 - 20, y, W / 2 + 20, y);
    y += 30;
  }
  download(doc.output('blob'), 'divine-library-diary.pdf');
});

/* ============================================================
   The lectern, and the book that opens on it
   ============================================================ */
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let pdfjsPromise = null;
function loadPdfJs() {
  pdfjsPromise ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = PDFJS + 'pdf.min.js';
    s.onload = () => {
      const lib = window.pdfjsLib;
      lib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
      res(lib);
    };
    s.onerror = () => { pdfjsPromise = null; rej(new Error('Could not load pdf.js')); };
    document.head.append(s);
  });
  return pdfjsPromise;
}

const SLANT = 0.42;               // tilt of the reading desk
const LECTERN_Z = -1.32;
const READ_SPOT = new THREE.Vector3(0, 0, -0.62);
const READ_FOV = 36;
const lecternWood = woodMat(0x5a3720);

function buildLectern() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(lathe([[0, 0], [0.27, 0], [0.28, 0.025], [0.26, 0.045], [0.2, 0.065], [0.13, 0.095], [0.085, 0.13], [0, 0.13]], 48), M.woodDark));
  g.add(new THREE.Mesh(lathe([[0, 0.13], [0.075, 0.13], [0.08, 0.17], [0.055, 0.21], [0.045, 0.42], [0.068, 0.52], [0.074, 0.57], [0.05, 0.64], [0.042, 0.8], [0.06, 0.85], [0.07, 0.88], [0.07, 0.92], [0, 0.92]], 36), M.wood));
  box(0.24, 0.1, 0.2, M.woodDark, 0, 0.95, 0, g, 0.015);
  const top = new THREE.Group();
  top.position.set(0, 1.03, 0);
  top.rotation.x = SLANT;
  g.add(top);
  box(0.7, 0.035, 0.5, lecternWood, 0, 0, 0, top, 0.012);
  box(0.62, 0.07, 0.42, M.woodDark, 0, -0.05, 0, top, 0.012);
  box(0.7, 0.045, 0.035, lecternWood, 0, 0.03, 0.235, top, 0.012);          // ledge the book rests on
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.05, 0.04, 0.05, M.brass, sx * 0.33, 0.003, sz * 0.23, top, 0.008);
  // brass arm with a candle for reading by
  const arm = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.06, 0.66, 0), new THREE.Vector3(0.28, 0.63, 0.03),
    new THREE.Vector3(0.52, 0.68, 0.08), new THREE.Vector3(0.6, 0.78, 0.1),
  ]);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(arm, 24, 0.01, 8), M.brass));
  const candle = buildCandle();
  candle.position.set(0.6, 0.78, 0.1);
  candle.userData.seed = 3;
  g.add(candle);
  candles.push(candle);
  return { g, top, candle };
}

const lectern = buildLectern();
lectern.g.position.set(0, 0, LECTERN_Z);
lectern.g.userData = { lectern: true, highlight: lecternWood };
scene.add(lectern.g);
const lecternLight = new THREE.PointLight(0xffb066, 0.35, 3, 2);
lecternLight.position.set(0.6, 1.1, LECTERN_Z + 0.1);
scene.add(lecternLight);
const readLight = new THREE.PointLight(0xffd6a8, 0, 2.5, 2);
readLight.position.set(0.3, 1.6, LECTERN_Z + 0.35);
scene.add(readLight);

/* ---------- page art ---------- */
const LATIN = ['umbra', 'liber', 'memoria', 'silentium', 'lux', 'tempus', 'verba', 'noctis', 'in', 'et', 'sub', 'per', 'ad', 'quod',
  'est', 'non', 'sine', 'fine', 'domus', 'librorum', 'custos', 'aeternum', 'lucerna', 'pulvis', 'scriptum', 'legere', 'oblivio', 'gradus'];

function agePage(g, w, h) {
  g.globalCompositeOperation = 'multiply';
  const v = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.75);
  v.addColorStop(0, '#ffffff'); v.addColorStop(1, '#d8c39c');
  g.fillStyle = v; g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'source-over';
}

function fauxPageCanvas(seed, side) {
  const W = 700, H = 1000, c = makeCanvas(W, H), g = c.getContext('2d'), r = rng(seed);
  g.fillStyle = '#efe4c9'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(140,100,50,${r() * 0.07})`; g.beginPath(); g.arc(r() * W, r() * H, 2 + r() * 14, 0, 7); g.fill(); }
  g.fillStyle = 'rgba(38,24,12,.82)';
  let y = 120;
  if (side > 0) {
    g.textAlign = 'center';
    g.font = '600 50px "Cormorant Garamond", Georgia, serif';
    g.fillText('Liber Infinitus', W / 2, 150);
    g.font = 'italic 24px "EB Garamond", Georgia, serif';
    g.fillText('capitulum primum', W / 2, 192);
    y = 260;
  }
  g.textAlign = 'left';
  g.font = '21px "EB Garamond", Georgia, serif';
  const mx = 78;
  let indent = 36;
  for (; y < H - 110; y += 31) {
    let x = mx + indent; indent = 0;
    while (true) {
      const w = LATIN[(r() * LATIN.length) | 0];
      const ww = g.measureText(w).width;
      if (x + ww > W - mx) break;
      g.fillText(w, x, y);
      x += ww + 9;
    }
    if (r() < 0.12) { y += 14; indent = 36; }
  }
  g.textAlign = 'center';
  g.font = 'italic 22px "EB Garamond", Georgia, serif';
  g.fillText(String(side > 0 ? 1 : 'ii'), W / 2, H - 52);
  agePage(g, W, H);
  return c;
}

function endpaperCanvas() {
  const W = 512, H = 720, c = makeCanvas(W, H), g = c.getContext('2d'), r = rng(77);
  g.fillStyle = '#2a1410'; g.fillRect(0, 0, W, H);
  const cols = ['rgba(150,112,58,', 'rgba(50,72,76,', 'rgba(96,32,24,', 'rgba(190,168,128,'];
  for (let i = 0; i < 90; i++) {
    g.strokeStyle = cols[(r() * cols.length) | 0] + (0.05 + r() * 0.16) + ')';
    g.lineWidth = 2 + r() * 9;
    const y0 = r() * H, amp = 10 + r() * 40, f = 0.01 + r() * 0.03, ph = r() * 6;
    g.beginPath();
    for (let x = -10; x <= W + 10; x += 8) { const yy = y0 + Math.sin(x * f + ph) * amp + Math.sin(x * f * 2.7) * amp * 0.3; x < 0 ? g.moveTo(x, yy) : g.lineTo(x, yy); }
    g.stroke();
  }
  return c;
}

function blankPageCanvas() {
  const c = makeCanvas(350, 500), g = c.getContext('2d');
  g.fillStyle = '#efe4c9'; g.fillRect(0, 0, 350, 500);
  agePage(g, 350, 500);
  return c;
}

function flippedTex(t) { const f = t.clone(); f.repeat.x = -1; f.offset.x = 1; f.needsUpdate = true; return f; }
function staticEntry(c) { const t = tex(c); return { tex: t, flip: flippedTex(t) }; }
const PAGE_ART = {
  idleL: staticEntry(fauxPageCanvas(3, -1)),
  idleR: staticEntry(fauxPageCanvas(8, 1)),
  blank: staticEntry(blankPageCanvas()),
  end: staticEntry(endpaperCanvas()),
};

/* ---------- the 3D book ---------- */
const book3d = {
  g: new THREE.Group(),
  N: 28, W: 0, H: 0, cT: 0.007, maxStack: 0.02,
  parts: {},
  coverMat: new THREE.MeshStandardMaterial({ color: 0x3a1410, roughness: 0.55, normalMap: grainN, normalScale: V2(1.2, 1.2) }),
  mats: {},
};
lectern.top.add(book3d.g);
{
  const pageMat = () => new THREE.MeshStandardMaterial({ color: 0xd2c4a6, roughness: 0.92, emissive: 0xe8dcc2, emissiveIntensity: 0.05 });
  book3d.mats = { L: pageMat(), R: pageMat(), F: pageMat(), B: pageMat() };
  book3d.mats.B.side = THREE.BackSide;
}

const gutter = (u) => 0.005 * (1 - Math.pow(Math.max(0, 1 - u / (0.22 * book3d.W)), 2));
const sheetX = new Float32Array(64), sheetY = new Float32Array(64);

function pageGeo(W, H, N) {
  const geo = new THREE.PlaneGeometry(W, H, N, 1);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function setBookShape(W, H, total) {
  const B = book3d;
  for (const m of Object.values(B.parts)) { B.g.remove(m); m.geometry.dispose(); }
  B.parts = {};
  B.W = W; B.H = H;
  B.maxStack = Math.min(0.045, Math.max(0.008, total * 0.00006));
  const m = 0.012, cT = B.cT;
  for (const s of [-1, 1]) {
    const b = new THREE.Mesh(new RoundedBoxGeometry(W + m, cT, H + 2 * m, 2, 0.003), B.coverMat);
    b.position.set(s * ((W + m) / 2 + 0.004), cT / 2, 0);
    B.g.add(b); B.parts['board' + s] = b;
  }
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.014, cT * 0.8, H + 2 * m), B.coverMat);
  spine.position.y = cT * 0.4; B.g.add(spine); B.parts.spine = spine;
  for (const s of [-1, 1]) {
    const st = new THREE.Mesh(new THREE.BoxGeometry(W, 1, H), M.pages);
    st.position.x = s * W / 2;
    B.g.add(st); B.parts[s < 0 ? 'stackL' : 'stackR'] = st;
  }
  B.parts.pageL = new THREE.Mesh(pageGeo(W, H, B.N), B.mats.L);
  B.parts.pageR = new THREE.Mesh(pageGeo(W, H, B.N), B.mats.R);
  const sheet = pageGeo(W, H, B.N);
  B.parts.sheet = new THREE.Mesh(sheet, B.mats.F);
  B.parts.sheetBack = new THREE.Mesh(sheet, B.mats.B);       // both faces share one bending geometry
  for (const k of ['pageL', 'pageR', 'sheet', 'sheetBack']) B.g.add(B.parts[k]);
  B.parts.sheet.visible = B.parts.sheetBack.visible = false;
  // rest the bottom edge of the pages on the desk's ledge
  B.g.position.set(0, 0.0175, 0.2175 - H / 2 - m);
}

function shapeStatic(geo, side, base) {
  const B = book3d, N = B.N, W = B.W, pos = geo.attributes.position;
  for (let j = 0; j < pos.count; j++) {
    const s = (j % (N + 1)) / N * W;
    const u = side > 0 ? s : W - s;
    pos.setX(j, side > 0 ? s : s - W);
    pos.setY(j, base + gutter(u));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
}

function layoutStacks(p) {
  const B = book3d, P = B.parts;
  const tL = Math.max(0.0015, B.maxStack * p), tR = Math.max(0.0015, B.maxStack * (1 - p));
  P.stackL.scale.y = tL; P.stackL.position.y = B.cT + tL / 2;
  P.stackR.scale.y = tR; P.stackR.position.y = B.cT + tR / 2;
  const bL = B.cT + tL + 0.0004, bR = B.cT + tR + 0.0004;
  shapeStatic(P.pageL.geometry, -1, bL);
  shapeStatic(P.pageR.geometry, 1, bR);
  return { bL, bR };
}

function shapeSheet(theta, t, dir, base) {
  // The turning page bends as it lifts: its free edge lags behind the spine.
  const B = book3d, N = B.N, W = B.W, geo = B.parts.sheet.geometry, pos = geo.attributes.position;
  const seg = W / N, curl = 0.95 * Math.sin(Math.PI * t);
  let x = 0, y = 0;
  sheetX[0] = 0; sheetY[0] = 0;
  for (let k = 0; k < N; k++) {
    const a = THREE.MathUtils.clamp(theta - dir * curl * ((k + 0.5) / N), 0, Math.PI);
    x += seg * Math.cos(a); y += seg * Math.sin(a);
    sheetX[k + 1] = x; sheetY[k + 1] = y;
  }
  const flat = Math.abs(Math.cos(theta));
  for (let j = 0; j < pos.count; j++) {
    const ix = j % (N + 1);
    pos.setX(j, sheetX[ix]);
    pos.setY(j, base + 0.0012 + sheetY[ix] + gutter(ix / N * W) * flat);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
}

/* ---------- PDF pages as textures ---------- */
let pdfDoc = null, pdfTotal = 0;
const pageTex = new Map();        // page number -> { tex, flip, promise }
let heldTex = [];                 // textures left open on the lectern after reading

function texEntry(n) {
  if (typeof n === 'string') return PAGE_ART[n];
  if (n < 1 || n > pdfTotal) return PAGE_ART.end;
  const e = pageTex.get(n);
  if (e?.tex) return e;
  requestPage(n);
  return null;
}

function assign(mat, n) {
  mat.userData.page = n;
  const e = texEntry(n) || PAGE_ART.blank;
  const t = mat.side === THREE.BackSide ? e.flip : e.tex;
  if (mat.map !== t) {
    const first = !mat.map;
    mat.map = t; mat.emissiveMap = t;
    if (first) mat.needsUpdate = true;
  }
}

function refreshPages() { for (const mat of Object.values(book3d.mats)) if (mat.userData.page !== undefined) assign(mat, mat.userData.page); }

function requestPage(n) {
  if (pageTex.has(n)) return pageTex.get(n).promise;
  const doc = pdfDoc;
  const entry = { tex: null, flip: null };
  entry.promise = (async () => {
    const page = await doc.getPage(n);
    const vp0 = page.getViewport({ scale: 1 });
    const scale = Math.min(1700 / vp0.height, 2400 / vp0.width);
    const vp = page.getViewport({ scale });
    const c = makeCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    page.cleanup();
    if (doc !== pdfDoc) return;                     // the book was closed meanwhile
    agePage(g, c.width, c.height);
    entry.tex = tex(c);
    entry.flip = flippedTex(entry.tex);
    refreshPages();
  })().catch((err) => console.warn('Could not draw page', n, err));
  pageTex.set(n, entry);
  return entry.promise;
}

function prefetch(s) { for (let n = 2 * s - 2; n <= 2 * s + 5; n++) if (n >= 1 && n <= pdfTotal) requestPage(n); }

function evictPages(center) {
  const inUse = new Set(Object.values(book3d.mats).map((m) => m.userData.page));
  for (const [n, e] of pageTex) {
    if (Math.abs(n - center) <= 8 || inUse.has(n) || !e.tex) continue;
    e.tex.dispose(); e.flip.dispose();
    pageTex.delete(n);
  }
}

function closePdf(keepOpen) {
  const keep = new Set(keepOpen ? [book3d.mats.L.map, book3d.mats.R.map] : []);
  for (const t of heldTex) if (!keep.has(t)) t.dispose();
  heldTex = [];
  for (const e of pageTex.values()) {
    if (!e.tex) continue;
    if (keep.has(e.tex)) heldTex.push(e.tex); else e.tex.dispose();
    e.flip.dispose();
  }
  pageTex.clear();
  for (const mat of Object.values(book3d.mats)) mat.userData.page = undefined;
  if (pdfDoc) pdfDoc.destroy();
  pdfDoc = null; pdfTotal = 0;
}

function showIdleBook() {
  setBookShape(0.34 * 0.68, 0.34, 420);
  assign(book3d.mats.L, 'idleL');
  assign(book3d.mats.R, 'idleR');
  layoutStacks(0.42);
}
showIdleBook();

/* ---------- reading ---------- */
const reader = {
  phase: 'idle',             // idle | loading | enter | read | exit
  t: 0, mix: 0, book: null, spread: 0, maxSpread: 0,
  zoom: 1, zoomT: 1, aim: V2(0, 0), aimT: V2(0, 0),
  turn: null, queued: 0, saveTimer: null,
  from: { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 68 },
};
const camDummy = new THREE.PerspectiveCamera();
const poseP = new THREE.Vector3(), poseQ = new THREE.Quaternion(), tmpQ = new THREE.Quaternion();
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const readingNow = () => reader.phase !== 'idle';

function readingPose(outPos, outQuat) {
  const B = book3d;
  B.g.updateWorldMatrix(true, false);
  const q = B.g.getWorldQuaternion(tmpQ);
  const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const across = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const upPage = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  const center = new THREE.Vector3(0, B.cT + 0.02, 0).applyMatrix4(B.g.matrixWorld);
  const spreadW = 2 * B.W + 0.06, spreadH = B.H + 0.07;
  const half = THREE.MathUtils.degToRad(READ_FOV / 2);
  const dist = Math.max((spreadH / 2) / Math.tan(half), (spreadW / 2) / (Math.tan(half) * camera.aspect)) * 1.04;
  const k = 1 - 1 / reader.zoom;
  center.addScaledVector(across, reader.aim.x * (spreadW / 2) * k).addScaledVector(upPage, reader.aim.y * (spreadH / 2) * k);
  outPos.copy(center).addScaledVector(normal, dist / reader.zoom);
  camDummy.position.copy(outPos);
  camDummy.up.copy(upPage);
  camDummy.lookAt(center);
  outQuat.copy(camDummy.quaternion);
}

function standPose(outPos, outQuat) {
  outPos.set(READ_SPOT.x, EYE, READ_SPOT.z);
  outQuat.setFromEuler(new THREE.Euler(-0.42, 0, 0, 'YXZ'));
}

function updateReaderUI() {
  const L = 2 * reader.spread, R = L + 1, N = pdfTotal;
  const a = Math.max(1, L), b = Math.min(N, R);
  $('r-pages').textContent = a === b ? `Page ${a} of ${N}` : `Pages ${a}–${b} of ${N}`;
  $('r-prev').disabled = reader.spread <= 0;
  $('r-next').disabled = reader.spread >= reader.maxSpread;
  $('r-goto').max = N;
}

function showSpread(s) {
  reader.spread = s;
  assign(book3d.mats.L, 2 * s);
  assign(book3d.mats.R, 2 * s + 1);
  layoutStacks(s / Math.max(1, reader.maxSpread));
  book3d.parts.sheet.visible = book3d.parts.sheetBack.visible = false;
  updateReaderUI();
  prefetch(s);
  evictPages(2 * s);
}

function playRustle(strength = 1) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const ac = audioCtx, t = ac.currentTime, len = Math.floor(ac.sampleRate * 0.5);
    const buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (0.6 + 0.4 * Math.sin(i / 90));
    const src = ac.createBufferSource(); src.buffer = buf;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.8;
    const gn = ac.createGain();
    gn.gain.setValueAtTime(0, t);
    gn.gain.linearRampToValueAtTime(0.09 * strength, t + 0.06);
    gn.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    src.connect(bp).connect(gn).connect(ac.destination);
    src.start(t); src.stop(t + 0.5);
  } catch { /* sound is optional */ }
}

function turnPage(dir) {
  if (reader.phase !== 'read' && reader.phase !== 'enter') return;
  if (reader.turn) { reader.queued = dir; return; }
  const from = reader.spread, to = from + dir;
  if (to < 0 || to > reader.maxSpread) return;
  const Mt = book3d.mats;
  if (dir > 0) { assign(Mt.R, 2 * to + 1); assign(Mt.F, 2 * from + 1); assign(Mt.B, 2 * to); }
  else { assign(Mt.L, 2 * to); assign(Mt.F, 2 * to + 1); assign(Mt.B, 2 * from); }
  reader.turn = { dir, from, to, t: 0 };
  book3d.parts.sheet.visible = book3d.parts.sheetBack.visible = true;
  playRustle();
  prefetch(to);
}

function updateTurn(dt) {
  const tr = reader.turn;
  if (!tr) return;
  tr.t = Math.min(1, tr.t + dt / 0.8);
  const e = ease(tr.t);
  const p = THREE.MathUtils.lerp(tr.from, tr.to, e) / Math.max(1, reader.maxSpread);
  const { bL, bR } = layoutStacks(p);
  const theta = tr.dir > 0 ? Math.PI * e : Math.PI * (1 - e);
  const base = tr.dir > 0 ? THREE.MathUtils.lerp(bR, bL, e) : THREE.MathUtils.lerp(bL, bR, e);
  shapeSheet(theta, e, tr.dir, base);
  if (tr.t >= 1) {
    reader.turn = null;
    showSpread(tr.to);
    saveProgress();
    if (reader.queued) { const q = reader.queued; reader.queued = 0; turnPage(q); }
  }
}

function finishTurnNow() { if (reader.turn) { reader.turn.t = 1; reader.queued = 0; updateTurn(0); } }

function goToPage(n) {
  if (reader.phase !== 'read' && reader.phase !== 'enter') return;
  n = THREE.MathUtils.clamp(Math.round(n) || 1, 1, pdfTotal);
  const s = Math.floor(n / 2);
  finishTurnNow();
  if (s === reader.spread) return;
  showSpread(s);
  playRustle(1.6);
  saveProgress();
}

function saveProgress(now) {
  const b = reader.book;
  if (!b) return;
  b.readPage = reader.spread * 2;
  clearTimeout(reader.saveTimer);
  const save = () => store.put('books', b).catch((err) => console.error(err));
  if (now) save(); else reader.saveTimer = setTimeout(save, 800);
}

function readingNote(b) {
  if (!b.hasPdf) return '';
  return b.readPage > 0 ? `Read to page ${Math.min(b.pdfPages, b.readPage)} of ${b.pdfPages}` : `${b.pdfPages} pages, not yet opened`;
}

async function openOnLectern(b) {
  if (readingNow() || fading || !b?.hasPdf) return;
  if (modal) { if (modal === bookModal) putBookBack(); else { modal.hidden = true; modal = null; } }
  hideMenu();
  setHover(null);
  keys.clear();
  reader.phase = 'loading';
  document.body.classList.add('reading');
  if (isLocked()) document.exitPointerLock();
  $('reader').hidden = false;
  $('r-title').textContent = b.title;
  $('r-status').textContent = 'Opening the book…';
  $('r-pages').textContent = '';
  const far = player.distanceTo(READ_SPOT) > 4.5;
  try {
    const [lib, rec] = await Promise.all([loadPdfJs(), store.get('pdfs', b.id)]);
    if (!rec?.blob) throw new Error('The PDF is missing from storage');
    const doc = await lib.getDocument({ data: new Uint8Array(await rec.blob.arrayBuffer()) }).promise;
    closePdf(false);
    pdfDoc = doc; pdfTotal = doc.numPages;
    const vp = (await doc.getPage(1)).getViewport({ scale: 1 });
    const aspect = vp.width / vp.height;
    const H = Math.min(0.36, 0.29 / aspect);
    book3d.coverMat.color.set(b.color || '#3a1410');
    setBookShape(H * aspect, H, pdfTotal);
    reader.book = b;
    reader.maxSpread = Math.floor(pdfTotal / 2);
    showSpread(THREE.MathUtils.clamp(Math.floor((b.readPage || 0) / 2), 0, reader.maxSpread));
    await requestPage(Math.max(1, 2 * reader.spread));
  } catch (err) {
    console.error(err);
    reader.phase = 'idle';
    document.body.classList.remove('reading');
    $('reader').hidden = true;
    closePdf(false);
    showIdleBook();
    toast('This book’s PDF could not be opened.');
    lock();
    return;
  }
  if (far) {
    const fade = $('fade');
    fade.classList.add('quick', 'in');
    await wait(480);
    standPose(poseP, poseQ);
    camera.position.copy(poseP); camera.quaternion.copy(poseQ);
    fade.classList.remove('in');
    setTimeout(() => fade.classList.remove('quick'), 500);
  }
  player.copy(READ_SPOT); yaw = 0; pitch = -0.42; vel.set(0, 0, 0);
  reader.from.pos.copy(camera.position);
  reader.from.quat.copy(camera.quaternion);
  reader.from.fov = camera.fov;
  reader.zoom = reader.zoomT = 1;
  reader.aim.set(0, 0); reader.aimT.set(0, 0);
  reader.t = 0;
  reader.phase = 'enter';
  $('r-status').textContent = '';
}

function closeReading() {
  if (reader.phase !== 'read' && reader.phase !== 'enter') return;
  finishTurnNow();
  saveProgress(true);
  reader.from.pos.copy(camera.position);
  reader.from.quat.copy(camera.quaternion);
  reader.from.fov = camera.fov;
  reader.t = 0;
  reader.phase = 'exit';
  $('reader').hidden = true;
  lock();                    // ask for the mouse back while we still have the click
}

function finishExit() {
  reader.phase = 'idle';
  reader.book = null;
  document.body.classList.remove('reading');
  closePdf(true);            // the book stays open on the lectern where you left it
  hideMenu();
  if (!freeMode && !isLocked()) toast('Click anywhere to look around again.');
}

function openLecternPicker() {
  const list = $('lectern-list');
  list.innerHTML = '';
  const readable = books.filter((b) => b.hasPdf);
  $('lectern-empty').hidden = readable.length > 0;
  for (const b of readable) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.textContent = b.title;
    const small = document.createElement('small');
    small.textContent = [b.author, readingNote(b)].filter(Boolean).join(' · ');
    btn.append(small);
    btn.addEventListener('click', () => openOnLectern(b));
    li.append(btn); list.append(li);
  }
  openModal($('lectern-modal'));
}

function updateReader(dt) {
  const r = reader;
  const want = r.phase === 'enter' || r.phase === 'read' ? 1 : 0;
  r.mix += (want - r.mix) * Math.min(1, dt * 3);
  bloom.strength = THREE.MathUtils.lerp(1.45, 0.5, r.mix);
  bloom.threshold = THREE.MathUtils.lerp(0.85, 1.0, r.mix);
  readLight.intensity = 0.5 * r.mix;
  for (const mat of Object.values(book3d.mats)) mat.emissiveIntensity = THREE.MathUtils.lerp(0.05, 0.42, r.mix);
  if (r.phase === 'idle' || r.phase === 'loading') return;

  r.zoom += (r.zoomT - r.zoom) * Math.min(1, dt * 6);
  r.aim.lerp(r.aimT, Math.min(1, dt * 4));
  if (r.phase === 'enter' || r.phase === 'read') readingPose(poseP, poseQ);
  if (r.phase === 'enter') {
    r.t = Math.min(1, r.t + dt / 1.5);
    const e = ease(r.t);
    camera.position.lerpVectors(r.from.pos, poseP, e);
    camera.quaternion.slerpQuaternions(r.from.quat, poseQ, e);
    camera.fov = THREE.MathUtils.lerp(r.from.fov, READ_FOV, e);
    if (r.t >= 1) r.phase = 'read';
  } else if (r.phase === 'read') {
    camera.position.copy(poseP);
    camera.quaternion.copy(poseQ);
    camera.fov = READ_FOV;
  } else if (r.phase === 'exit') {
    r.t = Math.min(1, r.t + dt / 1.1);
    const e = ease(r.t);
    standPose(poseP, poseQ);
    camera.position.lerpVectors(r.from.pos, poseP, e);
    camera.quaternion.slerpQuaternions(r.from.quat, poseQ, e);
    camera.fov = THREE.MathUtils.lerp(r.from.fov, 68, e);
    if (r.t >= 1) finishExit();
  }
  camera.updateProjectionMatrix();
  updateTurn(dt);
}

$('r-prev').addEventListener('click', () => turnPage(-1));
$('r-next').addEventListener('click', () => turnPage(1));
$('r-close').addEventListener('click', closeReading);
$('r-goto').addEventListener('change', (e) => { goToPage(Number(e.target.value)); e.target.value = ''; e.target.blur(); });
addEventListener('wheel', (e) => {
  if (reader.phase !== 'read' && reader.phase !== 'enter') return;
  e.preventDefault();
  reader.zoomT = THREE.MathUtils.clamp(reader.zoomT * Math.exp(-e.deltaY * 0.0015), 1, 3.4);
}, { passive: false });

/* ============================================================
   Backup: the whole library in one file
   Layout: a magic line, 4 bytes of manifest length, the manifest
   (JSON), then every cover and PDF one after another. Blobs are
   referenced by offset, so even huge PDFs never pass through text.
   ============================================================ */
const BACKUP_MAGIC = 'DIVINE-LIBRARY-1\n';

async function saveBackup() {
  await flushDiary();
  const entries = diary.filter((d) => d.updated && (d.title.trim() || d.body.trim()));
  if (!books.length && !entries.length) { toast('There is nothing to back up yet.'); return; }
  toast('Gathering your library…');
  const parts = [];
  let offset = 0;
  const addBlob = (blob) => {
    if (!blob) return null;
    const ref = { o: offset, n: blob.size, t: blob.type };
    parts.push(blob); offset += blob.size;
    return ref;
  };
  const outBooks = [];
  for (const b of books) {
    const rec = { ...b, cover: addBlob(b.cover), pdf: null };
    if (b.hasPdf) rec.pdf = addBlob((await store.get('pdfs', b.id))?.blob);
    outBooks.push(rec);
  }
  const manifest = { app: 'the-divine-library', version: 1, saved: new Date().toISOString(), books: outBooks, diary: entries };
  const head = new TextEncoder().encode(JSON.stringify(manifest));
  const len = new DataView(new ArrayBuffer(4));
  len.setUint32(0, head.length, true);
  const file = new Blob([BACKUP_MAGIC, len.buffer, head, ...parts], { type: 'application/octet-stream' });
  download(file, `the-divine-library-${new Date().toISOString().slice(0, 10)}.library`);
  toast(`Backup saved: ${books.length} ${books.length === 1 ? 'book' : 'books'}, ${entries.length} diary ${entries.length === 1 ? 'entry' : 'entries'}.`);
}

async function restoreBackup(file) {
  const M = BACKUP_MAGIC.length;
  let manifest, base;
  try {
    if ((await file.slice(0, M).text()) !== BACKUP_MAGIC) throw new Error('wrong file');
    const len = new DataView(await file.slice(M, M + 4).arrayBuffer()).getUint32(0, true);
    manifest = JSON.parse(await file.slice(M + 4, M + 4 + len).text());
    base = M + 4 + len;
    if (manifest.app !== 'the-divine-library') throw new Error('wrong app');
  } catch (err) {
    console.error(err);
    toast('That file is not a Divine Library backup.');
    return;
  }
  toast('Restoring your library…');
  const blobAt = (ref) => (ref ? file.slice(base + ref.o, base + ref.o + ref.n, ref.t) : null);
  try {
    for (const b of manifest.books || []) {
      const pdf = blobAt(b.pdf);
      const rec = { ...b, cover: blobAt(b.cover) };
      delete rec.pdf;
      if (pdf) await store.put('pdfs', { id: b.id, blob: pdf });
      else rec.hasPdf = false;
      await store.put('books', rec);
    }
    for (const d of manifest.diary || []) await store.put('diary', d);
  } catch (err) {
    console.error(err);
    toast('Part of the backup could not be stored — your browser may be out of space.');
  }
  [books, diary] = await Promise.all([store.all('books'), store.all('diary')]);
  current = null;
  rebuildBooks();
  const nb = manifest.books?.length || 0, nd = manifest.diary?.length || 0;
  toast(`Restored ${nb} ${nb === 1 ? 'book' : 'books'} and ${nd} diary ${nd === 1 ? 'entry' : 'entries'}.`);
}

$('backup-save').addEventListener('click', () => saveBackup().catch((err) => { console.error(err); toast('The backup could not be made.'); }));
$('backup-restore').addEventListener('click', () => $('backup-file').click());
$('backup-file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreBackup(f); });

// Phones and tablets get a short note: the library needs a keyboard and mouse.
if (matchMedia('(hover: none) and (pointer: coarse)').matches) {
  $('device-note').hidden = false;
  $('device-anyway').addEventListener('click', () => { $('device-note').hidden = true; });
}

/* ============================================================
   Loop
   ============================================================ */
const fwd = new THREE.Vector3(), right = new THREE.Vector3(), want = new THREE.Vector3();
let last = performance.now(), hoverTimer = 0;

function flicker() {
  // steady light; it only sinks slowly while the library takes you back
  return 1 - dread * 0.7;
}

function update(dt, time) {
  const active = started && !modal && menu.hidden && !fading && !readingNow();
  fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  right.set(Math.cos(yaw), 0, -Math.sin(yaw));
  want.set(0, 0, 0);
  if (active) {
    if (keys.has('KeyW') || keys.has('ArrowUp')) want.add(fwd);
    if (keys.has('KeyS') || keys.has('ArrowDown')) want.sub(fwd);
    if (keys.has('KeyD') || keys.has('ArrowRight')) want.add(right);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) want.sub(right);
  }
  const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 5.2 : 2.4;
  if (want.lengthSq() > 0) want.normalize().multiplyScalar(speed);
  vel.lerp(want, Math.min(1, dt * 9));
  player.addScaledVector(vel, dt);
  collide();

  const moving = vel.length();
  bobPhase += moving * dt * 3.2;
  const bob = Math.sin(bobPhase) * 0.022 * Math.min(1, moving / 2.4);
  if (!readingNow()) {
    camera.position.set(player.x + Math.sin(time * 0.8) * dread * 0.03, EYE + bob - dread * 0.08, player.z);
    camera.rotation.set(pitch, yaw, 0);
  }
  updateReader(dt);

  following.position.z = Math.round(player.z / SEG) * SEG - RUN / 2 + 30;
  updatePool();

  // lamps: real lights on the nearest ones, flicker on all
  const ks = Math.floor(-player.z / SEG);
  const base = Math.max(0, ks - 1);
  lampLights.forEach((l, i) => {
    const k = base + i;
    l.position.set(0, LAMP_Y - 0.15, -(k + 0.5) * SEG);
    l.intensity = 62 * lampState(k) * flicker();
  });
  for (const s of slots) {
    if (!s.on) continue;
    const f = flicker();
    s.mats.bulb.emissiveIntensity = 4.5 * f;
    s.mats.inner.emissiveIntensity = 0.45 * f;
    s.mats.glow.opacity = 0.4 * f;
    s.mats.shaft.opacity = 0.022 * f;
    s.poolMatT.opacity = 0.2 * f;
    s.poolMatF.opacity = 0.08 * f;
  }
  sconceLights.forEach((l, i) => {
    const k = Math.max(0, ks - 1) + i;
    l.position.set(0, SCONCE_Y, -k * SEG);
    // your own shelves are kept a little brighter so the spines stay readable
    l.intensity = (k <= userSegs ? 12 : 9) * flicker();
  });

  // candles
  for (const c of candles) {
    if (!c.visible) continue;
    const sd = c.userData.seed || 0;
    const fl = c.getObjectByName('flame');
    const w = 1 + Math.sin(time * 13 + sd) * 0.08 + Math.sin(time * 31 + sd * 2) * 0.05;
    fl.scale.set(0.035 * (2 - w), 0.07 * w, 1);
  }

  // dust
  for (let i = 0; i < DUST; i++) {
    const s = dustSeed[i];
    let y = dustPos[i * 3 + 1] + dt * (0.02 + Math.sin(time * 0.3 + s) * 0.03);
    if (y > 4.6) y = 0.1;
    dustPos[i * 3 + 1] = y;
    dustPos[i * 3] += Math.sin(time * 0.4 + s) * dt * 0.03;
    let z = dustPos[i * 3 + 2];
    if (z > player.z + 4) z -= 16;
    if (z < player.z - 12) z += 16;
    dustPos[i * 3 + 2] = z;
  }
  dustGeo.attributes.position.needsUpdate = true;

  // books sliding out / glowing
  for (const m of bookMeshes) {
    const u = m.userData;
    if (u.pull !== u.pullTarget) {
      u.pull += (u.pullTarget - u.pull) * Math.min(1, dt * 10);
      if (Math.abs(u.pull - u.pullTarget) < 0.002) u.pull = u.pullTarget;
      m.position.set(u.home.x - u.side * 0.18 * u.pull, u.home.y + 0.015 * u.pull, u.home.z);
    }
    if (u.glow > 0) {
      u.glow = Math.max(0, u.glow - dt * 0.25);
      if (m !== hovered) m.material[0].emissive.setRGB(0.5 * u.glow, 0.32 * u.glow, 0.1 * u.glow);
    }
  }

  hoverTimer -= dt;
  if (active && hoverTimer <= 0) {
    hoverTimer = 0.05;
    if (isLocked()) setHover(pick(0, 0));
    else if (freeMode && !drag) setHover(pick(mouse.x, mouse.y));
  }
}

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt, now / 1000);
  composer.render();
  requestAnimationFrame(frame);
}

addEventListener('resize', () => {
  if (!innerWidth || !innerHeight) return;   // hidden window
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

/* ============================================================
   Start
   ============================================================ */
// The title is written out in ink, one letter after another.
function writeTitle() {
  const t = $('title-text');
  t.textContent = '';
  [...'The Divine Library'].forEach((ch, i) => {
    const sp = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
    sp.textContent = ch;
    sp.style.animationDelay = `${0.25 + i * 0.11}s`;
    t.append(sp);
  });
  fitTitle();
  $('title').classList.add('write');
  document.querySelector('.intro-inner').classList.add('ready');
}
// frame the SVG tightly around the written words so it always sits centred
function fitTitle() {
  const t = $('title-text'), bb = t.getBBox();
  if (!bb.width) return;
  t.closest('svg').setAttribute('viewBox', `${bb.x - 40} ${bb.y - 24} ${bb.width + 80} ${bb.height + 48}`);
}
document.fonts.addEventListener?.('loadingdone', fitTitle);

const store = await openStore();
try {
  await Promise.race([
    Promise.all([
      document.fonts.load('600 30px "Cormorant Garamond"'),
      document.fonts.load('italic 500 20px "EB Garamond"'),
      document.fonts.load('80px "Pinyon Script"'),
    ]),
    wait(2500),
  ]);
} catch { /* fonts are optional */ }
plaqueTex.image = plaqueCanvas('YOUR COLLECTION'); plaqueTex.needsUpdate = true;
signTex.image = plaqueCanvas(...SIGN); signTex.needsUpdate = true;
PAGE_ART.idleL.tex.image = fauxPageCanvas(3, -1); PAGE_ART.idleL.tex.needsUpdate = true;
PAGE_ART.idleR.tex.image = fauxPageCanvas(8, 1); PAGE_ART.idleR.tex.needsUpdate = true;

[books, diary] = await Promise.all([store.all('books'), store.all('diary')]);
updatePool(true);
rebuildBooks();
writeTitle();
// compile the shaders off the main thread while the title is written, so the ink doesn't stall
try { if (renderer.compileAsync) await renderer.compileAsync(scene, camera); } catch (err) { console.warn(err); }
requestAnimationFrame(frame);

// for debugging in the console
window.__library = { scene, lectern, book3d, camera, player, gtao, bloom, returnToStart, reader, openOnLectern, turnPage, goToPage, closeReading, books: () => books, setView(x, z, y = 0, p = 0) { player.set(x, 0, z); yaw = y; pitch = p; } };
