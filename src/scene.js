import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
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
  height: 2.35, // altura final del difusor en unidades de escena
  restRotationY: Math.PI / 6, // orientación de reposo: 3/4 hacia cámara
  bodyColor: 0x1c1b1f,
  bodyRoughness: 0.55,
  bodyMetalness: 0.25,
  logColor: 0x3a332c,
  glassColor: 0x0d0c10,
  glassOpacity: 0.3,
};

function buildBodyMaterial() {
  return new THREE.MeshStandardMaterial({
    color: MODEL.bodyColor,
    roughness: MODEL.bodyRoughness,
    metalness: MODEL.bodyMetalness,
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
// Llama procedural (ShaderMaterial): 3 planos cruzados con flicker orgánico
// y degradado --glow-1 → --glow-2 → --glow-3.
// ---------------------------------------------------------------------------
const flameVertexShader = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;

  // ruido pseudo-orgánico barato (sin dependencias externas)
  float hash(float n) { return fract(sin(n) * 43758.5453123); }

  void main() {
    vUv = uv;
    vec3 pos = position;

    // estrechamiento hacia la punta de la llama
    float taper = smoothstep(0.0, 1.0, uv.y);
    pos.x *= mix(1.0, 0.15, taper);

    // ondulación orgánica lateral (mezcla de senos desfasados + hash)
    float sway = sin(uTime * 2.2 + pos.y * 3.0) * 0.06
               + sin(uTime * 5.3 + pos.y * 6.0) * 0.025
               + (hash(floor(uTime * 6.0)) - 0.5) * 0.02;
    pos.x += sway * uv.y;
    pos.z += cos(uTime * 1.7 + pos.y * 2.5) * 0.04 * uv.y;

    // la punta "respira" ligeramente en altura
    pos.y += sin(uTime * 3.1) * 0.03 * taper;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const flameFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uGlow1;
  uniform vec3 uGlow2;
  uniform vec3 uGlow3;
  varying vec2 vUv;

  void main() {
    // degradado vertical: base cálida-roja -> naranja -> punta pálida
    vec3 color = mix(uGlow3, uGlow2, smoothstep(0.0, 0.55, vUv.y));
    color = mix(color, uGlow1, smoothstep(0.55, 1.0, vUv.y));

    // silueta: se desvanece en los bordes laterales y en la punta
    float edge = 1.0 - smoothstep(0.15, 0.5, abs(vUv.x - 0.5));
    float tip = 1.0 - smoothstep(0.75, 1.0, vUv.y);
    float base = smoothstep(0.0, 0.08, vUv.y);

    // parpadeo suave y orgánico de intensidad global
    float flicker = 0.85 + 0.15 * sin(uTime * 9.0) * sin(uTime * 3.3 + 1.0);

    float alpha = edge * tip * base * flicker;
    gl_FragColor = vec4(color, alpha);
  }
`;

function buildFlame() {
  const group = new THREE.Group();
  const geometry = new THREE.PlaneGeometry(0.5, 1.05, 1, 24);
  geometry.translate(0, 0.525, 0); // pivote en la base de la llama

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uGlow1: { value: new THREE.Color(COLORS.glow1) },
      uGlow2: { value: new THREE.Color(COLORS.glow2) },
      uGlow3: { value: new THREE.Color(COLORS.glow3) },
    },
    vertexShader: flameVertexShader,
    fragmentShader: flameFragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  // 3 planos cruzados a 60° para dar volumen sin billboarding real
  for (let i = 0; i < 3; i++) {
    const plane = new THREE.Mesh(geometry, material);
    plane.rotation.y = (Math.PI / 3) * i;
    group.add(plane);
  }

  group.userData.material = material;
  return group;
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
    36,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  const cameraRestPosition = new THREE.Vector3(0, 1.5, 5.6);
  const cameraTarget = new THREE.Vector3(0, 1.25, 0);
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

  // --- Iluminación -----------------------------------------------------
  const ambient = new THREE.AmbientLight(0x342b3a, 0.55);
  scene.add(ambient);

  const flameLight = new THREE.PointLight(COLORS.glow2, 6.5, 8, 2);
  scene.add(flameLight);

  const rimLight = new THREE.DirectionalLight(0x6a5a72, 0.4);
  rimLight.position.set(-3, 4, -2);
  scene.add(rimLight);

  // --- Difusor -----------------------------------------------------------
  const diffuserGroup = new THREE.Group();
  diffuserGroup.position.y = -0.9;
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
    0.65, // strength — moderado, solo realza la llama
    0.45, // radius
    0.78  // threshold — alto: evita que el difusor/niebla exploten a blanco
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

    flame.userData.material.uniforms.uTime.value = t;
    mist.userData.material.uniforms.uTime.value = t;

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
    cameraTargetLook.set(0, 1.25 + scrollProgress * 0.25, 0);

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
