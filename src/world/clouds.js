// 積雲：上昇気流の上（雲底）にできる。柔らかいスプライトを重ねて立体感を出す。
import * as THREE from 'three';

function puffTexture() {
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 26; i++) {
    const r = S * (0.12 + rnd() * 0.2), a = rnd() * 6.28, d = rnd() * S * 0.22;
    const x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.4)'); grad.addColorStop(0.6, 'rgba(255,255,255,0.18)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.beginPath(); g.arc(x, y, r, 0, 6.29); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function buildClouds(scene, atmo, height, sunDir, quality, enabled) {
  const group = new THREE.Group(); scene.add(group);
  if (!enabled) return { group, update() {} };
  const tex = puffTexture();
  let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const base = atmo.cloudBase;
  const centers = [];
  // 上昇気流の上に雲（風で流された位置）
  for (const t of atmo.thermals) {
    const [cx, cz] = atmo.thermalCenter(t, base);
    centers.push({ x: cx, z: cz, size: t.r * 1.6 + 150, tall: 250 + t.w * 120 });
  }
  // 遠くの雲（景観用）
  const extra = [8, 25, 45, 70][quality];
  for (let i = 0; i < extra; i++) {
    const a = rnd() * 6.28, d = 5000 + rnd() * 45000;
    centers.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, size: 400 + rnd() * 900, tall: 200 + rnd() * 600 });
  }
  const per = [14, 24, 34, 46][quality];
  const sprites = [];
  const sunUp = Math.max(0.1, sunDir.y);
  for (const c of centers) {
    const g0 = height(c.x, c.z) + base;
    for (let i = 0; i < per; i++) {
      const a = rnd() * 6.28, r = Math.sqrt(rnd()) * c.size * 0.55;
      const h = Math.pow(rnd(), 1.4) * c.tall;
      const shrink = 1 - h / c.tall * 0.55;
      const x = c.x + Math.cos(a) * r * shrink, z = c.z + Math.sin(a) * r * shrink, y = g0 + h + c.size * 0.18;
      const s = (c.size * 0.45 + rnd() * c.size * 0.3) * (0.7 + shrink * 0.4);
      // 上ほど明るく、底は灰色
      const lightness = 0.62 + 0.38 * Math.min(1, h / c.tall + 0.15) * (0.7 + 0.3 * sunUp);
      const mat = new THREE.SpriteMaterial({ map: tex, color: new THREE.Color().setScalar(lightness * 2.4), transparent: true, depthWrite: false, fog: true, opacity: 0.9 });
      const sp = new THREE.Sprite(mat); sp.position.set(x, y, z); sp.scale.set(s, s * 0.8, 1);
      sp.material.rotation = rnd() * 6.28;
      group.add(sp); sprites.push(sp);
    }
  }
  return {
    group,
    update(camPos) {
      // カメラが雲の中に入ったときに描画が破綻しないよう、近い雲は薄くする
      for (const sp of sprites) {
        const d = sp.position.distanceTo(camPos) / sp.scale.x;
        sp.material.opacity = 0.9 * THREE.MathUtils.clamp((d - 0.25) / 0.6, 0, 1);
      }
    }
  };
}
