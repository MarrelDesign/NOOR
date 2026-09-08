import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

// ---------------------------------------------------------------------------
// Tokens de marca (deben coincidir con src/style.css)
// ---------------------------------------------------------------------------
const COLORS = {
  ink: 0x141019,
  glow1: 0xffe7c4,
  glow2: 0xf0824e,
  glow3: 0xe8674c,
};

// ---------------------------------------------------------------------------
// Difusor real (.glb): parámetros ajustables de encaje, orientación y
// materiales. Todo lo que se pueda tunear rápido vive aquí.
// ---------------------------------------------------------------------------
const MODEL = {
  path: '/models/diffuser.glb',
  height: 2.0, // altura final del difusor en unidades de escena — producto en escaparate, no losa
  groupY: 0.0, // altura del "suelo" del grupo (sube/baja el difusor entero en pantalla)
  restRotationY: Math.PI / 6, // orientación de reposo: 3/4 hacia cámara
  bodyColor: 0x1c1b1f,
  bodyRoughness: 0.45,
  bodyMetalness: 0.2,
  bodyEnvMapIntensity: 0.35, // reflejos SUTILES — más alto y el negro se lava a gris/blanco
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

// Tamaño de la llama como fracción de MODEL.height, para que se mantenga
// proporcionada automáticamente si se retoca la escala del modelo.
const FLAME_SCALE = { width: 0.21, height: 0.33 };

function buildBodyMaterial() {
  return new THREE.MeshStandardMaterial({
    color: MODEL.bodyColor,
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

function buildGlassMaterial() {
  return new THREE.MeshPhysicalMaterial({
    color: MODEL.glassColor,
    roughness: 0.12,
    metalness: 0,
    transparent: true,
    opacity: MODEL.glassOpacity,
    depthWrite: false,
    side: THREE.DoubleSide,
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
  sprite.scale.set(MODEL.height * FLAME_SCALE.width, MODEL.height * FLAME_SCALE.height, 1); // pequeña, proporcional al modelo
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
  attribute vec3 aRandom; // x: fase, y: velocidad, z: radio de deriva
  varying float vAlpha;

  void main() {
    float cycle = fract(uTime * (0.035 + aRandom.y * 0.03) + aRandom.x);

    float startY = 0.0;
    float endY = 3.2;
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
  varying float vAlpha;

  void main() {
    vec4 tex = texture2D(uSprite, gl_PointCoord);
    gl_FragColor = vec4(uColor, tex.a * vAlpha);
  }
`;

function buildMist(sprite) {
  const count = 220;
  const positions = new Float32Array(count * 3);
  const randoms = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * 0.35;
    positions[i * 3 + 0] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = Math.sin(angle) * radius;

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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // --- Environment de estudio (solo para reflejos, NO como fondo) -----------
  // Un cuerpo negro (#1c1b1f) sobre un fondo casi negro (#141019) es ilegible
  // sin algo que reflejar: un env map de estudio genérico (sin archivos
  // externos) le da a los bordes metálicos el brillo que revela su forma.
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const envRenderTarget = pmremGenerator.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRenderTarget.texture;
  pmremGenerator.dispose();

  // --- Iluminación -----------------------------------------------------
  const ambient = new THREE.AmbientLight(0x342b3a, 0.55);
  scene.add(ambient);

  const flameLight = new THREE.PointLight(COLORS.glow2, 4.5, 8, 2);
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
  // Posiciones por defecto (válidas para la primitiva placeholder); se
  // reanclan a la ranura real ("mist_slot") en cuanto carga el .glb.
  const flame = buildFlame();
  flame.position.set(0, 1.5, 0);
  diffuserGroup.add(flame);

  const mistSprite = makeSoftDiscTexture();
  const mist = buildMist(mistSprite);
  mist.position.set(0, 1.55, 0);
  diffuserGroup.add(mist);

  flameLight.position.set(0, 1.9, 0.15);

  // Carga el modelo real. Si falla (404, archivo ausente), se conserva la
  // primitiva de fallback y las posiciones por defecto de llama/niebla/luz
  // sin romper nada.
  const loader = new GLTFLoader();
  loader.load(
    MODEL.path,
    (gltf) => {
      diffuserGroup.remove(primitive);

      const model = gltf.scene;

      // Centra el modelo en X/Z y apoya su base en el suelo del grupo
      // (y=0 local), escalándolo para que tenga la altura objetivo.
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      box.getSize(size);
      const scale = MODEL.height / size.y;

      model.scale.setScalar(scale);
      model.position.set(
        -((box.min.x + box.max.x) / 2) * scale,
        -box.min.y * scale,
        -((box.min.z + box.max.z) / 2) * scale
      );

      const bodyMaterial = buildBodyMaterial();
      const logMaterial = buildLogMaterial();
      const glassMaterial = buildGlassMaterial();

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
          node.material = bodyMaterial; // frame_*, foot_*, back_wall, btn_*
        }
      });

      diffuserGroup.add(model);
      diffuserGroup.updateMatrixWorld(true);

      // Ancla la llama, la niebla y la luz cálida a la ranura superior real.
      const mistSlot = model.getObjectByName('mist_slot');
      if (mistSlot) {
        const slotWorld = mistSlot.getWorldPosition(new THREE.Vector3());
        const slotLocal = diffuserGroup.worldToLocal(slotWorld.clone());
        flame.position.copy(slotLocal);
        mist.position.copy(slotLocal);
        flameLight.position.copy(slotWorld).add(new THREE.Vector3(0, 0.15, 0));
      }
    },
    undefined,
    () => {
      // 404 esperado si el .glb no está disponible: mantenemos la primitiva.
      console.info('[noor] diffuser.glb no encontrado — usando primitiva placeholder.');
    }
  );

  // --- Postprocesado: bloom controlado (sin blowout) ------------------------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.55, // strength — moderado, solo realza la llama y los reflejos cálidos
    0.45, // radius
    0.82  // threshold — alto: evita que el difusor/niebla exploten a blanco
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

    mist.userData.material.uniforms.uTime.value = t;

    // flicker orgánico de la llama: escala + opacidad, nunca la silueta
    // (que siempre es el gradiente suave de la textura)
    const flicker = 0.85 + 0.15 * Math.sin(t * 9.0) * Math.sin(t * 3.3 + 1.0);
    flame.userData.material.opacity = flame.userData.baseOpacity * flicker;
    flame.scale.set(
      flame.userData.baseScale.x * (0.94 + 0.06 * Math.sin(t * 2.4)),
      flame.userData.baseScale.y * (0.97 + 0.05 * Math.sin(t * 3.1 + 0.6)),
      1
    );

    // rotación idle lenta (base) + rotación extra por scroll (amortiguada)
    const idleSpeed = prefersReducedMotion ? 0.02 : 0.08;
    diffuserGroup.rotation.y += idleSpeed * dt;

    const targetExtraRotation = prefersReducedMotion ? 0 : scrollProgress * Math.PI * 0.6;
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

  return { render, resize, setScrollProgress, scene, camera, renderer };
}
