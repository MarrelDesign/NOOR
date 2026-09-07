import Lenis from 'lenis';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { initScene, noorReveal } from './scene.js';
import './style.css';

gsap.registerPlugin(ScrollTrigger);
gsap.registerEase('noorReveal', noorReveal);

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

// El hero conduce el progreso de scroll (0→1) hacia la escena 3D; la escena
// misma se encarga de amortiguar (damp/lerp) cualquier cambio de cámara.
ScrollTrigger.create({
  trigger: '#hero',
  start: 'top top',
  end: 'bottom top',
  scrub: true,
  onUpdate: (self) => {
    noorScene.setScrollProgress(self.progress);
  },
});

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
