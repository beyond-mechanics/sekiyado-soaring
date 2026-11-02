// 大気散乱の空、太陽位置（関宿の緯度経度と日付・時刻から計算）、光源、環境光、霞。
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

const LAT = 36.0157, LON = 139.8166;

export function sunPosition(hour, date = new Date()) {
  const start = new Date(date.getFullYear(), 0, 0);
  const N = Math.floor((date - start) / 864e5);
  const B = 2 * Math.PI * (N - 81) / 364;
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); // 分
  const solar = hour + (LON - 135) / 15 + eot / 60;
  const decl = 23.44 * Math.sin(2 * Math.PI * (284 + N) / 365) * Math.PI / 180;
  const H = (solar - 12) * 15 * Math.PI / 180, phi = LAT * Math.PI / 180;
  const el = Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) + Math.PI;
  return { elevation: el, azimuth: az,
    dir: new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)) };
}

export class Environment {
  constructor(renderer, scene) {
    this.renderer = renderer; this.scene = scene;
    this.sky = new Sky(); this.sky.scale.setScalar(450000);
    scene.add(this.sky);
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0x5d6b4a, 0.35);
    scene.add(this.hemi);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.skyScene = new THREE.Scene();
    this.envSky = new Sky(); this.envSky.scale.setScalar(1000); this.skyScene.add(this.envSky);
    this.fogColor = new THREE.Color();
    scene.fog = new THREE.FogExp2(0xb8c8d4, 1e-5);
    this.sunDir = new THREE.Vector3(0, 1, 0);
  }

  set({ hour, visibility }) {
    const sp = sunPosition(hour);
    this.sunDir.copy(sp.dir);
    const el = sp.elevation;
    const turbidity = visibility < 40000 ? 7.5 : visibility < 90000 ? 4 : 2.2;
    for (const sky of [this.sky, this.envSky]) {
      const u = sky.material.uniforms;
      u.turbidity.value = turbidity;
      u.rayleigh.value = el < 0.25 ? 2.6 : 2.0;
      u.mieCoefficient.value = visibility < 40000 ? 0.012 : 0.004;
      u.mieDirectionalG.value = 0.82;
      u.sunPosition.value.copy(sp.dir);
    }
    // 太陽光の色：低いほど暖色・弱く
    const t = THREE.MathUtils.clamp(el / 0.6, 0, 1);
    this.sun.color.setRGB(1, 0.62 + 0.36 * t, 0.38 + 0.55 * t);
    this.sun.intensity = 0.4 + 3.2 * Math.pow(THREE.MathUtils.clamp(el / 0.9, 0, 1), 0.6);
    this.hemi.intensity = 0.15 + 0.3 * t;
    // 霞の色（地平線付近の空の色に合わせる）
    const haze = new THREE.Color(visibility < 40000 ? 0xc3c8c6 : 0xb4c6d4);
    const warm = new THREE.Color(0xe0b892);
    this.fogColor.copy(haze).lerp(warm, (1 - t) * 0.55).multiplyScalar(0.55 + 0.45 * t);
    this.scene.fog.color.copy(this.fogColor);
    this.scene.fog.density = 1.15 / visibility;
    // 環境光（IBL）を空から生成
    this.env?.dispose();
    this.env = this.pmrem.fromScene(this.skyScene, 0, 1, 2000).texture;
    this.scene.environment = this.env;
    this.scene.environmentIntensity = 0.55 + 0.35 * t;
    this.renderer.toneMappingExposure = 0.42 + 0.12 * (1 - t);
    this.elevation = el;
  }

  // 影の範囲は機体周辺のみ（高解像度）
  // 光線は機体を通るので、機体の影が落ちる地面も同じ影カメラに入る。
  follow(target, agl, quality) {
    const r = quality >= 3 ? 170 : 130;
    const d = 400, far = d + Math.min(6000, Math.max(0, agl) / Math.max(0.15, this.sunDir.y)) + 300;
    this.sun.position.copy(target).addScaledVector(this.sunDir, d);
    this.sun.target.position.copy(target);
    const c = this.sun.shadow.camera;
    if (c.right !== r || Math.abs(c.far - far) > 50) {
      c.left = -r; c.right = r; c.top = r; c.bottom = -r; c.near = 1; c.far = far; c.updateProjectionMatrix();
    }
  }
}
