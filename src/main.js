import Lenis from 'lenis';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { initScene, noorReveal } from './scene.js';
import './style.css';

gsap.registerPlugin(ScrollTrigger);
gsap.registerEase('noorReveal', noorReveal);

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isMobile = window.matchMedia('(max-width: 640px)').matches;

// ---------------------------------------------------------------------------
// Constantes de ajuste del pin del hero (fáciles de tocar)
// ---------------------------------------------------------------------------
// Cuánto dura el pin: scroll EXTRA (además del alto del hero) durante el
// cual el hero queda fijo en pantalla. '+=320%' = 320% de un alto de
// viewport de scroll extra. Súbelo para que el producto se quede más rato
// en pantalla girando; bájalo para un hero más corto. Subido de 220%→320%
// para dar más tiempo de pantalla al producto (se quería que se viera más).
const HERO_PIN_LENGTH = '+=320%';
// Cuánto crece (transform: scale) el botón COMPRAR en el clímax final del pin.
const CTA_CLIMAX_SCALE = 1.12;
// Separación (en "tiempo" de timeline de GSAP, ver TL_UNITS más abajo) entre
// la aparición de cada ítem de "lo que incluye" durante el reveal escalonado.
const REVEAL_STAGGER = 0.15;

// En móvil acortamos el pin — menos scroll "cautivo" en pantallas donde
// cada segundo de scroll pesa más (dedo, no rueda de ratón). Escala
// HERO_PIN_LENGTH en vez de hardcodear un segundo valor, para que solo haya
// una fuente de verdad si se retoca HERO_PIN_LENGTH.
const MOBILE_PIN_SCALE = 0.65; // 220% → ~143% en móvil
function scalePinLength(pinLength, scale) {
  const match = /^\+=(\d+(?:\.\d+)?)%$/.exec(pinLength);
  if (!match) return pinLength;
  return `+=${Math.round(parseFloat(match[1]) * scale)}%`;
}
const effectiveHeroPinLength = isMobile ? scalePinLength(HERO_PIN_LENGTH, MOBILE_PIN_SCALE) : HERO_PIN_LENGTH;

// Fracciones (0→1) del progreso TOTAL del pin en las que ocurre cada fase —
// mismo eje 0→1 que self.progress / noorScene.setScrollProgress. El
// timeline de GSAP (heroPinTl, ver abajo) es la ANIMACIÓN del ScrollTrigger,
// así que su progreso normalizado (posición/TL_UNITS) SIEMPRE coincide
// exactamente con self.progress — por eso podemos derivar las posiciones de
// los tweens multiplicando estas fracciones por TL_UNITS y que el fundido
// del modelo (que usa self.progress en bruto) quede sincronizado sin más.
const INCLUDES_IN_START = 0.07; // "LO QUE INCLUYE" empieza a aparecer
const SECONDARY_RECEDE_START = 0.5; // "lo que incluye" + subtítulo empiezan a retroceder
const SECONDARY_RECEDE_END = 0.58;
const CTA_CLIMAX_START = 0.6; // el botón COMPRAR empieza a crecer/iluminarse
const CTA_CLIMAX_END = 0.7;
const HERO_FADE_START = 0.9; // modelo+llama+niebla Y el resto del hero se apagan juntos aquí, justo antes de que el pin termine

// Unidad de "tiempo" interna del timeline de GSAP — arbitraria, no son
// segundos reales: el scrub reparte proporcionalmente TODO el timeline
// (0 → TL_UNITS) sobre el scroll del pin. Se fija en 6 porque con
// REVEAL_STAGGER=0.15 y 5 ítems (eyebrow + 4 líneas) el reveal-in cabe justo
// en la ventana INCLUDES_IN_START→~0.23 (ver más abajo).
const TL_UNITS = 6;

function remap01(value, start, end) {
  if (start === end) return value < start ? 0 : 1;
  return Math.min(1, Math.max(0, (value - start) / (end - start)));
}

// ---------------------------------------------------------------------------
// Lenis (scroll suave) conectado al ticker de GSAP / ScrollTrigger
// ---------------------------------------------------------------------------
let lenis = null;

if (!prefersReducedMotion) {
  lenis = new Lenis({
    duration: 1.15,
    smoothWheel: true,
  });

  lenis.on('scroll', ScrollTrigger.update);

  gsap.ticker.add((time) => {
    lenis.raf(time * 1000);
  });
  gsap.ticker.lagSmoothing(0);
}

// ---------------------------------------------------------------------------
// Escena 3D del hero
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scene-canvas');
const noorScene = initScene(canvas);

function loop() {
  noorScene.render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------------------------------------------------------------------------
// Pin del hero + coreografía de scroll (ÚNICO ScrollTrigger del hero; no se
// monta ningún sistema de scroll en paralelo, y Lenis sigue siendo el único
// motor de scroll suave, arriba).
//
// *** REGLA DURA: nada de lo de aquí abajo toca la rotación idle del difusor.
// noorScene.setScrollProgress() solo alimenta la rotación EXTRA y el dolly de
// cámara dentro de scene.js — el idle (diffuserGroup.rotation.y += idleSpeed
// * dt) vive en el render loop de scene.js, corre en CADA frame vía el rAF de
// más abajo, y es completamente independiente de scroll/pin/ScrollTrigger.
// Aunque el hero esté fijado y no haya scroll, el render loop sigue llamando
// a render() cada frame y el difusor sigue girando. ***
//
// El hero conduce el progreso de scroll (0→1) hacia la escena 3D; la escena
// misma se encarga de amortiguar (damp/lerp) cualquier cambio de cámara. El
// mismo progreso también desvanece el <canvas> 3D (difusor + llama + niebla)
// a opacidad 0 — ver HERO_FADE_START.
//
// Con prefers-reduced-motion: SIN pin (el pin largo forzaría un scroll
// "cautivo" que es justo el tipo de movimiento que este ajuste pide evitar)
// — se mantiene el comportamiento simple de siempre: el hero se desplaza con
// normalidad y el difusor se desvanece rápido en su tramo final.
// ---------------------------------------------------------------------------
if (prefersReducedMotion) {
  const CANVAS_FADE_START = 0.5;
  ScrollTrigger.create({
    trigger: '#hero',
    start: 'top top',
    end: 'bottom top',
    scrub: true,
    onUpdate: (self) => {
      noorScene.setScrollProgress(self.progress);
      const fadeP = remap01(self.progress, CANVAS_FADE_START, 1);
      canvas.style.opacity = String(1 - fadeP);
      noorScene.setFadeFactor(fadeP);
    },
  });
} else {
  const includeRevealTargets = gsap.utils.toArray('.hero-includes-eyebrow, .hero-includes-list li');

  const heroPinTl = gsap.timeline({
    scrollTrigger: {
      trigger: '#hero',
      start: 'top top',
      end: effectiveHeroPinLength,
      scrub: true,
      pin: true,
      pinSpacing: true, // clave: empuja "Cómo funciona" y el resto exactamente lo que dura el pin — sin solapes ni saltos
      onUpdate: (self) => {
        noorScene.setScrollProgress(self.progress);

        // Modelo + llama + niebla se desvanecen SOLO en el tramo final del
        // pin (mismo mecanismo setFadeFactor de siempre), coincidiendo con
        // el fundido del resto del hero (ver tween más abajo) — todo
        // desaparece junto justo cuando el pin suelta, paso limpio a
        // "Cómo funciona" sin blob flotando.
        const fadeP = remap01(self.progress, HERO_FADE_START, 1);
        canvas.style.opacity = String(1 - fadeP);
        noorScene.setFadeFactor(fadeP);

        // Realce cálido opcional de luz/bloom durante el clímax del CTA:
        // sube en CTA_CLIMAX_START→END, se mantiene, y baja junto con el
        // fundido final para no cortar en seco.
        const glowBoost =
          self.progress < HERO_FADE_START
            ? remap01(self.progress, CTA_CLIMAX_START, CTA_CLIMAX_END)
            : 1 - remap01(self.progress, HERO_FADE_START, 1);
        noorScene.setGlowBoost(glowBoost);
      },
    },
    defaults: { ease: 'none' },
  });

  // Fase 1 — "LO QUE INCLUYE": eyebrow + 4 ítems aparecen escalonados
  // (fade + leve subida) con REVEAL_STAGGER de separación.
  heroPinTl.fromTo(
    includeRevealTargets,
    { opacity: 0, y: 16 },
    { opacity: 1, y: 0, stagger: REVEAL_STAGGER, duration: 0.32 },
    INCLUDES_IN_START * TL_UNITS
  );

  // Fase 2 — lo secundario retrocede: "lo que incluye" se desvanece y el
  // subtítulo se atenúa (no desaparece del todo, solo cede protagonismo).
  heroPinTl
    .to(
      includeRevealTargets,
      { opacity: 0, y: -12, duration: (SECONDARY_RECEDE_END - SECONDARY_RECEDE_START) * TL_UNITS },
      SECONDARY_RECEDE_START * TL_UNITS
    )
    .to(
      '.hero-subtitle',
      { opacity: 0.28, y: -6, duration: (SECONDARY_RECEDE_END - SECONDARY_RECEDE_START) * TL_UNITS },
      SECONDARY_RECEDE_START * TL_UNITS
    );

  // Fase 3 — clímax: el botón COMPRAR crece y su halo cálido (#F0824E →
  // #FFE7C4) se intensifica. Sin rojo — la paleta ya es ámbar-coral por
  // css (--glow-1/--glow-2 en .btn-cta-glow).
  heroPinTl
    .fromTo(
      '.btn-cta',
      { scale: 1 },
      { scale: CTA_CLIMAX_SCALE, duration: (CTA_CLIMAX_END - CTA_CLIMAX_START) * TL_UNITS, ease: 'power2.out' },
      CTA_CLIMAX_START * TL_UNITS
    )
    .fromTo(
      '.btn-cta-glow',
      { opacity: 0, scale: 0.85 },
      { opacity: 1, scale: 1.3, duration: (CTA_CLIMAX_END - CTA_CLIMAX_START) * TL_UNITS, ease: 'power2.out' },
      CTA_CLIMAX_START * TL_UNITS
    );

  // Fase 4 — fundido final: el resto del hero (logo, H1, precio, botón+halo)
  // se apaga junto con el modelo/llama/niebla (ver fadeP en onUpdate, arriba,
  // con el mismo HERO_FADE_START) — paso limpio a "Cómo funciona".
  heroPinTl.to(
    '.hero-inner',
    { opacity: 0, duration: (1 - HERO_FADE_START) * TL_UNITS },
    HERO_FADE_START * TL_UNITS
  );
}

// ---------------------------------------------------------------------------
// Reveal del titular por máscara (overflow:hidden + traslación Y)
// ---------------------------------------------------------------------------
const titleLines = gsap.utils.toArray('.line-inner');

if (prefersReducedMotion) {
  gsap.set(titleLines, { y: 0, opacity: 1 });
  gsap.set(['.hero-logo', '.hero-subtitle', '.hero-purchase'], { opacity: 1, y: 0 });
} else {
  gsap.set(titleLines, { y: '110%' });

  const tl = gsap.timeline({ delay: 0.2 });
  tl.to('.hero-logo', { opacity: 1, duration: 0.8, ease: 'noorReveal' }, 0)
    .to(
      titleLines,
      {
        y: '0%',
        duration: 1.1,
        stagger: 0.12,
        ease: 'noorReveal',
      },
      0.15
    )
    .to(
      '.hero-subtitle',
      { opacity: 1, y: 0, duration: 0.9, ease: 'noorReveal' },
      0.55 // solapada: empieza antes de que termine el reveal del titular
    )
    .to(
      '.hero-purchase',
      { opacity: 1, y: 0, duration: 0.8, ease: 'noorReveal' },
      0.75 // también solapada con la animación anterior
    );
}

// ---------------------------------------------------------------------------
// Reveal de las secciones de contenido al hacer scroll (eyebrows, títulos,
// tarjetas, panel de compra…). Parte de un estado visible por CSS/noscript;
// no toca el Lenis ni el ScrollTrigger del hero de arriba.
// ---------------------------------------------------------------------------
const revealEls = gsap.utils.toArray('.reveal');

if (prefersReducedMotion) {
  gsap.set(revealEls, { opacity: 1, y: 0 });
} else {
  ScrollTrigger.batch(revealEls, {
    start: 'top 88%',
    once: true,
    onEnter: (batch) =>
      gsap.to(batch, {
        opacity: 1,
        y: 0,
        duration: 0.9,
        ease: 'noorReveal',
        stagger: 0.12,
      }),
  });
}

// ---------------------------------------------------------------------------
// CTA de compra → checkout de Shopify (botón del hero y de #comprar)
// ---------------------------------------------------------------------------
// URL de checkout de Shopify — cambiar aquí si cambia el producto/variante
const CHECKOUT_URL = 'https://f0mm5w-yn.myshopify.com/cart/55282723357001:1';

document.querySelectorAll('[data-checkout-link]').forEach((link) => {
  link.href = CHECKOUT_URL;
});
