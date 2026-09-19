import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

export default function PrivacyScene({ privateMode, running }: { privateMode: boolean; running: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const state = useRef({ privateMode, running });
  state.current = { privateMode, running };
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" }); }
    catch { setUnavailable(true); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setClearColor(0x000000, 0);
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
    camera.position.set(0, 0.7, 12);
    camera.lookAt(0, 0, 0);
    scene.add(new THREE.AmbientLight(0xb4c0ff, 2));
    const key = new THREE.DirectionalLight(0xffffff, 4); key.position.set(3, 5, 6); scene.add(key);
    const rim = new THREE.PointLight(0x8376ff, 35); rim.position.set(-3, 1, 3); scene.add(rim);
    const group = new THREE.Group(); scene.add(group);
    const accent = new THREE.Color(0xa99bff), mint = new THREE.Color(0x70efc7);
    const metal = new THREE.MeshStandardMaterial({ color: accent, metalness: 0.72, roughness: 0.24 });
    const glow = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.52 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.028, 12, 96), glow);
    ring.rotation.x = 0.5; group.add(ring);
    const orbit = new THREE.Mesh(new THREE.TorusGeometry(1.65, 0.012, 8, 96), glow);
    orbit.rotation.set(1.1, 0.5, 0); group.add(orbit);
    const shape = new THREE.Shape();
    shape.moveTo(0, 1.05); shape.lineTo(0.78, 0.72); shape.lineTo(0.68, -0.22);
    shape.quadraticCurveTo(0.55, -0.77, 0, -1.05); shape.quadraticCurveTo(-0.55, -0.77, -0.68, -0.22);
    shape.lineTo(-0.78, 0.72); shape.closePath();
    const shield = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.16, bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: 0.06, bevelThickness: 0.06 }), metal);
    const shieldGroup = new THREE.Group(); shieldGroup.add(shield); group.add(shieldGroup);
    const lockMat = new THREE.MeshStandardMaterial({ color: 0x10192c, roughness: 0.3, metalness: 0.4 });
    const lock = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.13), lockMat); lock.position.set(0, -0.04, 0.3); shieldGroup.add(lock);
    const arch = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.044, 10, 32, Math.PI), lockMat); arch.position.set(0, 0.16, 0.3); shieldGroup.add(arch);
    const keyhole = new THREE.Mesh(new THREE.SphereGeometry(0.044, 12, 12), new THREE.MeshBasicMaterial({ color: 0xd8fff1 })); keyhole.position.set(0, -0.015, 0.38); shieldGroup.add(keyhole);
    const publicCore = new THREE.Mesh(new THREE.IcosahedronGeometry(0.92, 1), new THREE.MeshBasicMaterial({ color: 0xa99bff, wireframe: true, transparent: true, opacity: 0.65 }));
    group.add(publicCore);
    const paths: THREE.CatmullRomCurve3[] = [];
    const tokens: THREE.Mesh[] = [];
    for (let i = 0; i < 3; i++) {
      const y = (i - 1) * 0.75;
      const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-4, y, -1), new THREE.Vector3(-1.7, y + 0.25, 0), new THREE.Vector3(0, 0, 0), new THREE.Vector3(1.7, y - 0.25, 0), new THREE.Vector3(4, y, -1)]);
      paths.push(curve);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(60)), new THREE.LineBasicMaterial({ color: 0x8575df, transparent: true, opacity: 0.18 })); scene.add(line);
      const coin = new THREE.Mesh(new THREE.OctahedronGeometry(0.095), metal); tokens.push(coin); scene.add(coin);
    }
    const dots = new Float32Array(120 * 3);
    for (let i = 0; i < 120; i++) {
      // Deterministic positions avoid a new star field on every React remount.
      dots[i * 3] = Math.sin(i * 127.1) * 7;
      dots[i * 3 + 1] = Math.cos(i * 311.7) * 4;
      dots[i * 3 + 2] = -2 - (i % 7) * 0.4;
    }
    const stars = new THREE.Points(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(dots, 3)), new THREE.PointsMaterial({ color: 0xb7b7e9, size: 0.022, transparent: true, opacity: 0.45 })); scene.add(stars);
    let time = 0, blend = privateMode ? 1 : 0, previous = 0, frame = 0, visible = true;
    const render = (now: number) => {
      const delta = previous ? Math.min((now - previous) / 1000, 0.05) : 0; previous = now;
      if (state.current.running) time += delta;
      const target = state.current.privateMode ? 1 : 0;
      blend = THREE.MathUtils.damp(blend, target, 5, delta);
      if (!state.current.running) blend = target;
      shieldGroup.scale.setScalar(Math.max(0.001, blend));
      shieldGroup.rotation.y = -0.25 + Math.sin(time * 0.55) * 0.15;
      publicCore.scale.setScalar(Math.max(0.001, 1 - blend));
      publicCore.rotation.y = time * 0.18;
      group.position.y = Math.sin(time * 0.8) * 0.1;
      ring.rotation.z = time * 0.12; orbit.rotation.z = -time * 0.09;
      metal.color.copy(accent).lerp(mint, blend); glow.color.copy(metal.color);
      tokens.forEach((token, i) => { token.position.copy(paths[i].getPoint((time * 0.11 + i / 3) % 1)); token.rotation.y = time; });
      renderer.render(scene, camera);
      if (visible && !document.hidden && (state.current.running || Math.abs(blend - target) > 0.005)) frame = requestAnimationFrame(render);
      else frame = 0;
    };
    const wake = () => { if (!frame && visible && !document.hidden) { previous = 0; frame = requestAnimationFrame(render); } };
    const resize = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      renderer.setSize(width, height); camera.aspect = width / Math.max(height, 1);
      // Keep the central symbol visible between the HTML payment and ledger panels.
      camera.position.z = width < 600 ? 14 : 12; camera.updateProjectionMatrix(); wake();
    }); resize.observe(element);
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) wake(); else if (frame) { cancelAnimationFrame(frame); frame = 0; } }); intersection.observe(element);
    element.addEventListener("privacy-scene-update", wake);
    document.addEventListener("visibilitychange", wake);
    const lost = (event: Event) => { event.preventDefault(); setUnavailable(true); if (frame) cancelAnimationFrame(frame); };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    wake();
    return () => {
      cancelAnimationFrame(frame); resize.disconnect(); intersection.disconnect();
      document.removeEventListener("visibilitychange", wake); element.removeEventListener("privacy-scene-update", wake);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      const materials = new Set<THREE.Material>();
      scene.traverse(object => { if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
        object.geometry.dispose(); (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => materials.add(material));
      } });
      materials.forEach(material => material.dispose()); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    };
  }, []);
  useEffect(() => { host.current?.dispatchEvent(new Event("privacy-scene-update")); }, [privateMode, running]);
  return <div className="privacy-scene" ref={host} aria-hidden="true">{unavailable && <div className="privacy-scene-fallback">{privateMode ? "◈" : "◇"}</div>}</div>;
}
