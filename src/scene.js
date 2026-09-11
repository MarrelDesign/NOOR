import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

// Móvil: menos partículas de niebla y pixelRatio más bajo — el tráfico será
// mayormente móvil (paso 4), y esto es lo único de la escena 3D que pesa en
// gama baja durante el pin largo del hero.
const IS_MOBILE = typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches;

// --- Ajuste de la llama y la niebla dentro de la chimenea ---
// flameMistGroup vive en el centro-superior del modelo (ver más abajo); estos
// offsets son relativos a ese punto de anclaje. En (0,0,0) la llama y la
// niebla quedan justo en el origen del grupo, es decir arriba-centro.
const FLAME_POS = { x: 0.0, y: 0.0, z: 0.0 };
const FLAME_SCALE = 0.9; // tamaño de la llama (relativo al actual)
const MIST_POS = { x: 0.0, y: 0.0, z: 0.0 };
const MIST_SPREAD = { x: 1.6, y: 0.0, z: 0.25 }; // ancho del área de emisión de niebla
// Altura que sube la niebla desde MIST_POS antes de reiniciar el ciclo (en
// unidades de escena). Contenida cerca de la boca de la chimenea, no una
// columna larga.
const MIST_RISE_HEIGHT = 0.9;

// --- Brillo cálido (familia ámbar-coral, paleta de marca) ------------------
const FLAME_LIGHT_INTENSITY = 4.5; // intensidad base (antes del fade del hero, ver setFadeFactor)
const FLAME_LIGHT_COLOR = 0xf0824e; // = COLORS.glow2, acento cálido de marca
const BLOOM_STRENGTH = 0.55; // moderado, solo realza la llama y los reflejos cálidos
const BLOOM_RADIUS = 0.45;
const BLOOM_THRESHOLD = 0.82; // alto: evita que el difusor/niebla exploten a blanco

// ---------------------------------------------------------------------------
// Tokens de marca (deben coincidir con src/style.css)
// ---------------------------------------------------------------------------
const COLORS = {
  ink: 0x141019,
  glow1: 0xffe7c4,
  glow2: 0xf0824e,
  glow3: 0xe8674c,
};

// Modelo optimizado (Meshy, texturizado).
const MODEL_URL = '/models/diffuser_web.glb';

// El trimesh viejo usa nodos con nombre (glass, log_*, mist_slot) y depende
// de que se le fuercen materiales propios; el modelo Meshy trae sus propias
// texturas horneadas y NUNCA debe recibir esos overrides de material.
const APPLY_NAMED_MATERIAL_OVERRIDES = MODEL_URL === '/models/diffuser.glb';

// Único número a tocar para agrandar/reducir el difusor en pantalla (altura
// final en unidades de escena, tras auto-centrar y auto-escalar el modelo).
const TARGET_HEIGHT = 3.0;

// ---------------------------------------------------------------------------
// Difusor real (.glb): parámetros ajustables de encaje, orientación y
// materiales. Todo lo que se pueda tunear rápido vive aquí.
// ---------------------------------------------------------------------------
const MODEL = {
  path: MODEL_URL,
  groupY: 0.35, // altura del "suelo" del grupo (sube/baja el difusor entero en pantalla)
  restRotationY: Math.PI / 6, // orientación de reposo: 3/4 hacia cámara
  bodyColor: 0x141217,
  bodyRoughness: 0.7,
  bodyMetalness: 0.1,
  bodyEnvMapIntensity: 0.08, // casi nada — el cuerpo depende de las luces, no del entorno
  logColor: 0x3a332c,
  glassColor: 0x0d0c10,
  glassOpacity: 0.3,
};

// Encuadre de cámara del hero — separado de MODEL para poder tunear la
// composición (qué tan "subido" y con cuánto aire respira el difusor) sin
// tocar la escala del modelo.
const HERO_CAMERA = {
  fov: 36,
  restPosition: new THREE.Vector3(0, 1.3, 7.6),
  target: new THREE.Vector3(0, 0.85, 0),
};

// Proporción (ancho/alto) del sprite de la llama como fracción de
// TARGET_HEIGHT; FLAME_SCALE (arriba) escala esto relativamente.
const FLAME_SPRITE_ASPECT = { width: 0.21, height: 0.33 };

// Crea SIEMPRE una instancia nueva (nunca se reutiliza ni se comparte con el
// material que traía el .glb) — cada malla del cuerpo recibe su propio
// MeshStandardMaterial forzado a negro carbón.
function buildBodyMaterial() {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(MODEL.bodyColor),
    roughness: MODEL.bodyRoughness,
    metalness: MODEL.bodyMetalness,
    envMapIntensity: MODEL.bodyEnvMapIntensity,
  });
}

function buildLogMaterial() {
  return new THREE.MeshStandardMaterial({
    color: MODEL.logColor,
    roughness: 0.85,
    metalness: 0,
  });
}

function buildGlassMaterial(envMap) {
  return new THREE.MeshPhysicalMaterial({
    color: MODEL.glassColor,
    roughness: 0.12,
    metalness: 0,
    transparent: true,
    opacity: MODEL.glassOpacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMap: envMap ?? null, // reflejo de estudio SOLO en el cristal, nunca global
    envMapIntensity: 0.6,
  });
}

/**
 * damp: interpolación exponencial independiente del framerate (Lerp/Smoothing
 * "a la Unity/Framer"). Usada SIEMPRE para mover la cámara — nunca se asigna
 * la posición de la cámara directamente desde el progreso de scroll.
 */
function damp(current, target, lambda, dt) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

function dampVec3(currentVec, targetVec, lambda, dt) {
  currentVec.x = damp(currentVec.x, targetVec.x, lambda, dt);
  currentVec.y = damp(currentVec.y, targetVec.y, lambda, dt);
  currentVec.z = damp(currentVec.z, targetVec.z, lambda, dt);
}

// Ease con nombre, propio de Noor: entrada suave y salida muy suave
// (usado también por GSAP en main.js vía gsap.registerEase).
export function noorReveal(p) {
  return 1 - Math.pow(1 - p, 3.2);
}

// ---------------------------------------------------------------------------
// Textura de partícula suave (círculo con caída radial) generada por canvas,
// usada como sprite para la niebla.
// ---------------------------------------------------------------------------
function makeSoftDiscTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,0.9)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Difusor (placeholder): perfil tipo urna revolucionado con LatheGeometry.
// ---------------------------------------------------------------------------
function buildDiffuserPrimitive() {
  const profile = [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.5, 0.02),
    new THREE.Vector2(0.58, 0.12),
    new THREE.Vector2(0.64, 0.4),
    new THREE.Vector2(0.66, 0.75),
    new THREE.Vector2(0.62, 1.05),
    new THREE.Vector2(0.5, 1.35),
    new THREE.Vector2(0.34, 1.58),
    new THREE.Vector2(0.2, 1.74),
    new THREE.Vector2(0.14, 1.86),
    new THREE.Vector2(0.13, 1.92),
    new THREE.Vector2(0.16, 1.96),
  ];
  const geometry = new THREE.LatheGeometry(profile, 96);
  geometry.scale(1.25, 1.25, 1.25);

  const mesh = new THREE.Mesh(geometry, buildBodyMaterial());
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Llama (sprite con textura de gradiente radial suave): NUNCA geometría con
// bordes rectos — toda la silueta la define el alpha, siempre difuminado.
// El flicker orgánico se anima en JS sobre scale/opacity (ver render()).
// ---------------------------------------------------------------------------
function makeFlameTexture() {
  const w = 128;
  const h = 200;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  const drawBlob = (cx, cy, r, colorStops) => {
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    colorStops.forEach(([offset, color]) => gradient.addColorStop(offset, color));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  };

  ctx.globalCompositeOperation = 'lighter'; // funde las capas sin costuras duras

  // capa exterior cálida-roja, ancha en la base
  drawBlob(w / 2, h * 0.74, w * 0.62, [
    [0, 'rgba(232,103,76,0.5)'],
    [0.6, 'rgba(232,103,76,0.2)'],
    [1, 'rgba(232,103,76,0)'],
  ]);
  // capa media naranja
  drawBlob(w / 2, h * 0.56, w * 0.44, [
    [0, 'rgba(240,130,78,0.7)'],
    [0.6, 'rgba(240,130,78,0.28)'],
    [1, 'rgba(240,130,78,0)'],
  ]);
  // núcleo cálido-pálido, pequeño y alto — nunca blanco puro (evita el blowout)
  drawBlob(w / 2, h * 0.34, w * 0.24, [
    [0, 'rgba(255,231,196,0.85)'],
    [0.6, 'rgba(255,231,196,0.3)'],
    [1, 'rgba(255,231,196,0)'],
  ]);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function buildFlame() {
  const material = new THREE.SpriteMaterial({
    map: makeFlameTexture(),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.85,
  });

  const sprite = new THREE.Sprite(material);
  sprite.center.set(0.5, 0.02); // pivote casi en la base: crece hacia arriba desde la ranura
  sprite.scale.set(
    TARGET_HEIGHT * FLAME_SPRITE_ASPECT.width * FLAME_SCALE,
    TARGET_HEIGHT * FLAME_SPRITE_ASPECT.height * FLAME_SCALE,
    1
  ); // pequeña, proporcional al modelo
  sprite.userData.material = material;
  sprite.userData.baseScale = sprite.scale.clone();
  sprite.userData.baseOpacity = material.opacity;
  return sprite;
}

// ---------------------------------------------------------------------------
// Niebla ascendente (GPU-driven): posiciones y opacidad calculadas 100% en
// el vertex/fragment shader a partir de uTime, sin tocar buffers por frame.
// ---------------------------------------------------------------------------
const mistVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uRiseHeight;
  attribute vec3 aRandom; // x: fase, y: velocidad, z: radio de deriva
  varying float vAlpha;

  void main() {
    float cycle = fract(uTime * (0.035 + aRandom.y * 0.03) + aRandom.x);

    float startY = 0.0;
    float endY = uRiseHeight;
    float y = mix(startY, endY, cycle);

    float driftAngle = aRandom.x * 6.2831853 + uTime * 0.15;
    float driftRadius = aRandom.z * (0.25 + cycle * 0.35);
    float x = position.x + cos(driftAngle) * driftRadius;
    float z = position.z + sin(driftAngle) * driftRadius;

    vAlpha = sin(cycle * 3.14159265) * 0.35;

    vec4 mvPosition = modelViewMatrix * vec4(x, y, z, 1.0);
    gl_PointSize = (60.0 + aRandom.y * 40.0) * (1.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const mistFragmentShader = /* glsl */ `
  uniform sampler2D uSprite;
  uniform vec3 uColor;
  uniform float uFade; // 1 = visible, 0 = invisible — mismo factor que el fade del hero
  varying float vAlpha;

  void main() {
    vec4 tex = texture2D(uSprite, gl_PointCoord);
    gl_FragColor = vec4(uColor, tex.a * vAlpha * uFade);
  }
`;

function buildMist(sprite) {
  const count = IS_MOBILE ? 110 : 220; // la mitad en móvil — menos partículas, mismo aspecto de niebla
  const positions = new Float32Array(count * 3);
  const randoms = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    // Distribución elíptica uniforme en área (sqrt del radio, no radio
    // lineal) para no concentrar partículas en el centro — franja ancha en
    // x y poco profunda en z, como vapor saliendo de la boca de la
    // chimenea, no una columna estrecha de humo.
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random());
    positions[i * 3 + 0] = Math.cos(angle) * radius * (MIST_SPREAD.x / 2);
    positions[i * 3 + 1] = (Math.random() - 0.5) * MIST_SPREAD.y;
    positions[i * 3 + 2] = Math.sin(angle) * radius * (MIST_SPREAD.z / 2);

    randoms[i * 3 + 0] = Math.random();
    randoms[i * 3 + 1] = Math.random();
    randoms[i * 3 + 2] = Math.random();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aRandom', new THREE.BufferAttribute(randoms, 3));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSprite: { value: sprite },
      uColor: { value: new THREE.Color(0xf6efe6) },
      uRiseHeight: { value: MIST_RISE_HEIGHT },
      uFade: { value: 1 },
    },
    vertexShader: mistVertexShader,
    fragmentShader: mistFragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.userData.material = material;
  return points;
}

// ---------------------------------------------------------------------------
// Escena principal
// ---------------------------------------------------------------------------
export function initScene(canvas) {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.ink);
  scene.fog = new THREE.FogExp2(COLORS.ink, 0.045);

  const camera = new THREE.PerspectiveCamera(
    HERO_CAMERA.fov,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  const cameraRestPosition = HERO_CAMERA.restPosition.clone();
  const cameraTarget = HERO_CAMERA.target.clone();
  camera.position.copy(cameraRestPosition);
  camera.lookAt(cameraTarget);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_MOBILE ? 1.5 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2; // más luz general: el difusor debe leerse claro contra el fondo tinta, no fundirse en él
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // --- Environment de estudio: SOLO para el cristal, nunca global ---------
  // Un scene.environment global ilumina también el cuerpo vía IBL y es lo
  // que lo lavaba a gris/blanco. El cuerpo debe depender solo de las luces;
  // el env map de estudio se asigna a mano únicamente al material del
  // cristal (ver glassMaterial.envMap más abajo).
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const envRenderTarget = pmremGenerator.fromScene(new RoomEnvironment(), 0.04);
  pmremGenerator.dispose();

  // --- Iluminación -----------------------------------------------------
  const ambient = new THREE.AmbientLight(0x342b3a, 0.4); // subido de 0.25: el difusor se perdía contra el fondo tinta
  scene.add(ambient);

  const flameLight = new THREE.PointLight(FLAME_LIGHT_COLOR, FLAME_LIGHT_INTENSITY, 8, 2);
  scene.add(flameLight);

  // Key light: cálida, desde arriba-frente — dibuja la silueta y la lectura
  // de volumen del cuerpo del difusor.
  const keyLight = new THREE.DirectionalLight(0xfff1de, 1.3);
  keyLight.position.set(2.2, 5, 4);
  scene.add(keyLight);

  // Rim light: fría/neutra, detrás — recorta el difusor contra el fondo.
  const rimLight = new THREE.DirectionalLight(0x9db3d9, 0.9);
  rimLight.position.set(-2.5, 3.5, -3.8);
  scene.add(rimLight);

  // --- Difusor -----------------------------------------------------------
  const diffuserGroup = new THREE.Group();
  diffuserGroup.position.y = MODEL.groupY;
  diffuserGroup.rotation.y = MODEL.restRotationY;
  scene.add(diffuserGroup);

  const primitive = buildDiffuserPrimitive();
  diffuserGroup.add(primitive);

  // --- Llama y niebla --------------------------------------------------
  // Colocación provisional en TARGET_HEIGHT/2 (techo aproximado) mientras
  // carga el .glb real y no conocemos su altura escalada exacta; el loader
  // de más abajo la reancla a la altura REAL del techo del modelo en cuanto
  // carga. Al ser hijo de diffuserGroup, gira con la chimenea
  // automáticamente (idle + scroll).
  const flame = buildFlame();
  flame.position.set(FLAME_POS.x, FLAME_POS.y, FLAME_POS.z);

  const mistSprite = makeSoftDiscTexture();
  const mist = buildMist(mistSprite);
  mist.position.set(MIST_POS.x, MIST_POS.y, MIST_POS.z);

  const flameMistGroup = new THREE.Group();
  flameMistGroup.add(flame);
  flameMistGroup.add(mist);
  flameMistGroup.position.set(0, TARGET_HEIGHT / 2, 0);
  diffuserGroup.add(flameMistGroup);

  // La luz de la llama no es hija de diffuserGroup (no debe heredar rotación
  // del difusor), así que se posiciona en mundo a mano — pero SIGUE a la
  // llama: se calcula desde flameMistGroup.position + FLAME_POS (el mismo
  // punto donde queda la llama).
  diffuserGroup.updateMatrixWorld(true);
  const flameWorldAnchor = new THREE.Vector3(
    flameMistGroup.position.x + FLAME_POS.x,
    flameMistGroup.position.y + FLAME_POS.y,
    flameMistGroup.position.z + FLAME_POS.z
  );
  flameLight.position.copy(diffuserGroup.localToWorld(flameWorldAnchor));

  // Carga el modelo real. Si falla (404, archivo ausente), se conserva la
  // primitiva de fallback y las posiciones por defecto de llama/niebla/luz
  // sin romper nada.
  const loader = new GLTFLoader();
  loader.load(
    MODEL.path,
    (gltf) => {
      diffuserGroup.remove(primitive);

      const model = gltf.scene;

      // Bounding box ANTES de recentrar/escalar — se loguea siempre, tanto
      // en dev como en build, para poder calibrar TARGET_HEIGHT a ojo.
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      console.log(`[noor] ${MODEL.path} — bbox size:`, size, 'center:', center);

      // Auto-centra el modelo en el origen (resta el center) y auto-escala
      // según su dimensión MÁS GRANDE (no siempre size.y): diffuser_web.glb
      // es una chimenea ancha y baja (size.x >> size.y), así que escalar
      // solo por altura desbordaba el ancho del hero muy por encima del
      // viewport. Math.max(size.x, size.y) garantiza que TARGET_HEIGHT es el
      // techo del lado más grande, sea cual sea la forma del modelo.
      const scale = TARGET_HEIGHT / Math.max(size.x, size.y);
      model.scale.setScalar(scale);
      model.position.copy(center).multiplyScalar(-scale);

      if (APPLY_NAMED_MATERIAL_OVERRIDES) {
        // Pipeline del trimesh viejo: fuerza materiales propios por nombre
        // de nodo (glass, log_*, mist_slot, resto = cuerpo).
        const logMaterial = buildLogMaterial();
        const glassMaterial = buildGlassMaterial(envRenderTarget.texture);

        model.traverse((node) => {
          if (!node.isMesh) return;
          node.castShadow = false;
          node.receiveShadow = false;

          if (node.name === 'glass') {
            node.material = glassMaterial;
            node.renderOrder = 2; // dibuja el cristal después de los troncos
          } else if (node.name.startsWith('log_')) {
            node.material = logMaterial;
          } else if (node.name === 'mist_slot') {
            node.visible = false; // marcador de la ranura, no se renderiza
          } else {
            // frame_*, foot_*, back_wall, btn_* — material NUEVO por malla,
            // nunca el que traía el .glb ni una instancia compartida.
            node.material = buildBodyMaterial();
          }
        });
      } else {
        // Modelo Meshy: conserva tal cual sus materiales/texturas horneadas.
        model.traverse((node) => {
          if (!node.isMesh) return;
          node.castShadow = false;
          node.receiveShadow = false;
        });
      }

      diffuserGroup.add(model);

      // Reancla flameMistGroup a la altura REAL del techo del modelo. Antes
      // vivía fijo en TARGET_HEIGHT/2, que solo coincide con el techo real
      // cuando el modelo escala por altura — pero diffuser_web.glb escala
      // por su lado más ancho (ver `scale` arriba), así que su altura real
      // es menor que TARGET_HEIGHT y la llama/niebla quedaban flotando muy
      // por encima de la chimenea, cerca del logo, desconectadas del
      // producto. Con esto la niebla nace justo en la boca de la chimenea,
      // como si saliera del humidificador de verdad.
      const realHalfHeight = (size.y * scale) / 2;
      flameMistGroup.position.y = realHalfHeight;
      diffuserGroup.updateMatrixWorld(true);
      const reanchoredFlameWorld = new THREE.Vector3(
        flameMistGroup.position.x + FLAME_POS.x,
        flameMistGroup.position.y + FLAME_POS.y,
        flameMistGroup.position.z + FLAME_POS.z
      );
      flameLight.position.copy(diffuserGroup.localToWorld(reanchoredFlameWorld));
    },
    undefined,
    () => {
      // 404 esperado si el .glb no está disponible: mantenemos la primitiva.
      console.info(`[noor] ${MODEL.path} no encontrado — usando primitiva placeholder.`);
    }
  );

  // --- Postprocesado: bloom controlado (sin blowout) ------------------------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    BLOOM_STRENGTH,
    BLOOM_RADIUS,
    BLOOM_THRESHOLD
  );
  composer.addPass(bloomPass);

  // --- Movimiento: idle + interacción por scroll (siempre damp/lerp) -------
  let scrollProgress = 0; // 0..1, escrito desde main.js vía ScrollTrigger
  const cameraTargetPos = cameraRestPosition.clone();
  const cameraTargetLook = cameraTarget.clone();
  const currentLook = cameraTarget.clone();
  let currentExtraRotation = 0; // rotación adicional del difusor por scroll (amortiguada)

  function setScrollProgress(p) {
    scrollProgress = THREE.MathUtils.clamp(p, 0, 1);
  }

  // 0 = difusor a pleno, 1 = totalmente desvanecido. Mismo factor que usa
  // main.js para desvanecer el <canvas> por CSS (fadeP en el ScrollTrigger
  // del hero) — aquí se aplica ADEMÁS a la opacidad real de los materiales
  // de llama/niebla y a la intensidad de la luz de la llama, para que el
  // brillo/bloom se apague de verdad y no quede un blob luminoso flotando
  // cuando el canvas ya está casi transparente por CSS.
  let fadeFactor = 0;

  function setFadeFactor(f) {
    fadeFactor = THREE.MathUtils.clamp(f, 0, 1);
  }

  // 0 = brillo normal, 1 = realce máximo. Opcional: main.js lo sube durante
  // el clímax del CTA para que la luz de la llama y el bloom acompañen
  // —sutilmente— el crecimiento del botón COMPRAR.
  let glowBoost = 0;

  function setGlowBoost(b) {
    glowBoost = THREE.MathUtils.clamp(b, 0, 1);
  }

  const clock = new THREE.Clock();

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
  }

  function render() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;

    const visibility = 1 - fadeFactor; // 1 = a pleno, 0 = invisible

    mist.userData.material.uniforms.uTime.value = t;
    mist.userData.material.uniforms.uFade.value = visibility;

    // flicker orgánico de la llama: escala + opacidad, nunca la silueta
    // (que siempre es el gradiente suave de la textura)
    const flicker = 0.85 + 0.15 * Math.sin(t * 9.0) * Math.sin(t * 3.3 + 1.0);
    flame.userData.material.opacity = flame.userData.baseOpacity * flicker * visibility;
    // glowBoost realza intensidad de luz y bloom en el clímax del CTA — leve
    // (+35%/+40% máx), nunca sustituye al flicker ni al fade.
    flameLight.intensity = FLAME_LIGHT_INTENSITY * visibility * (1 + glowBoost * 0.35);
    bloomPass.strength = BLOOM_STRENGTH * (1 + glowBoost * 0.4);
    flame.scale.set(
      flame.userData.baseScale.x * (0.94 + 0.06 * Math.sin(t * 2.4)),
      flame.userData.baseScale.y * (0.97 + 0.05 * Math.sin(t * 3.1 + 0.6)),
      1
    );

    // rotación idle lenta (base) + rotación extra por scroll (amortiguada)
    // *** REGLA DURA: la rotación idle SIEMPRE se aplica, en cada frame del
    // render loop, sin condicionarla a scrollProgress ni a ningún estado del
    // pin. El scroll solo AÑADE una rotación extra encima (currentExtraRotation).
    // NUNCA sustituir esta línea por una rotación derivada directamente del
    // scroll: eso deja el producto estático en cuanto el usuario no scrollea. ***
    const idleSpeed = prefersReducedMotion ? 0.02 : 0.08;
    diffuserGroup.rotation.y += idleSpeed * dt;

    const targetExtraRotation = prefersReducedMotion ? 0 : scrollProgress * Math.PI * 0.22; // bajado de 0.6: giraba demasiado rápido en la última toma (justo antes del fundido)
    currentExtraRotation = damp(currentExtraRotation, targetExtraRotation, 3.5, dt);
    diffuserGroup.rotation.y += currentExtraRotation * dt; // deriva suave, no salto

    // objetivo de cámara: dolly suave hacia el difusor al hacer scroll
    cameraTargetPos.set(
      cameraRestPosition.x + scrollProgress * 0.9,
      cameraRestPosition.y - scrollProgress * 0.35,
      cameraRestPosition.z - scrollProgress * 1.8
    );
    cameraTargetLook.set(0, cameraTarget.y + scrollProgress * 0.25, 0);

    if (prefersReducedMotion) {
      // movimiento esencial reducido: sin dolly de scroll, cámara en reposo
      camera.position.copy(cameraRestPosition);
      currentLook.copy(cameraTarget);
    } else {
      dampVec3(camera.position, cameraTargetPos, 4.0, dt);
      dampVec3(currentLook, cameraTargetLook, 4.0, dt);
    }
    camera.lookAt(currentLook);

    composer.render();
  }

  window.addEventListener('resize', resize);

  return { render, resize, setScrollProgress, setFadeFactor, setGlowBoost, scene, camera, renderer };
}
