// Austritt aus dem Hyperraum: die Station „fällt“ an ihren Platz – ein heller Blitz, eine Druckwelle (expandierender Ring) und kurze Strahlen,
// danach steht sie still. Kein Flug durch das Bild: Der Effekt beginnt in dem Bild, in dem sie erscheint (t = 0 Sekunden seit Austritt).
// Reine Darstellung; wann und wo sie erscheint, bestimmt die Regie.
import * as THREE from 'three/webgpu';
import { Fn, uniform, vec4, float, pow, uv, color, smoothstep, abs, sub } from 'three/tsl';

function zufall(i) { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

function blitzTextur() {
	const c = document.createElement('canvas'); c.width = c.height = 256;
	const g = c.getContext('2d');
	const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
	r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.1, 'rgba(200,230,255,0.95)'); r.addColorStop(0.35, 'rgba(90,160,255,0.35)'); r.addColorStop(1, 'rgba(0,0,0,0)');
	g.fillStyle = r; g.fillRect(0, 0, 256, 256);
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.premultiplyAlpha = true; return t;
}

export const AUSTRITT_DAUER = 1.6;   // Sekunden, nach denen der Effekt ganz verklungen ist

/** `huelle` = Radius der Station in Szeneneinheiten (bestimmt Größe von Blitz, Ring und Strahlen) */
export function erzeugeAustritt(szene, huelle) {
	const gruppe = new THREE.Group();
	gruppe.visible = false;
	const uSt = uniform(0);
	// Druckwelle: flacher Ring (Kreisscheibe mit Loch im Pixelshader), zur Kamera gedreht wie ein Sprite
	const ringMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
	ringMat.colorNode = Fn(() => {
		const d = uv().sub(0.5).length().mul(2);                                   // 0 Mitte … 1 Rand
		const kante = smoothstep(0.78, 0.92, d).mul(float(1).sub(smoothstep(0.92, 1.0, d)));
		return vec4(color(0.45, 0.72, 1.6).mul(kante).mul(uSt), 1);
	})();
	const ring = new THREE.Sprite(ringMat); ring.renderOrder = 13; ring.visible = false; gruppe.add(ring);
	// Blitz
	const blitz = new THREE.Sprite(new THREE.SpriteNodeMaterial({ map: blitzTextur(), transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
	blitz.renderOrder = 14; blitz.visible = false; gruppe.add(blitz);
	// Strahlen: dünne Zylinder, strahlenförmig vom Mittelpunkt, kurz
	const geo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2);
	const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
	m.colorNode = Fn(() => vec4(color(0.6, 0.85, 1.6).mul(pow(float(1).sub(uv().y), 1.5)).mul(uSt), 1))();
	const strahlen = [];
	for (let i = 0; i < 26; i++) {
		const mesh = new THREE.Mesh(geo, m);
		const a = zufall(i) * Math.PI * 2, b = (zufall(i + 50) - 0.5) * Math.PI * 0.9;
		mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(Math.cos(a) * Math.cos(b), Math.sin(b), Math.sin(a) * Math.cos(b)));
		const dicke = huelle * (0.006 + 0.012 * zufall(i + 100));
		mesh.userData.l = huelle * (2 + 5 * zufall(i + 200));
		mesh.scale.set(dicke, dicke, 1);
		mesh.frustumCulled = false; mesh.renderOrder = 13;
		gruppe.add(mesh); strahlen.push(mesh);
	}
	szene.add(gruppe);
	const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
	return {
		/** t: Sekunden seit dem Austritt (< 0 = noch nicht); pos: Mitte der Station (Szene) */
		update(t, pos) {
			const an = t >= 0 && t < AUSTRITT_DAUER;
			gruppe.visible = an;
			if (!an) return;
			gruppe.position.copy(pos);
			// Blitz: sofort hell, klingt in ~0,5 s ab
			const b = Math.exp(-t * 7) * (1 - sm(0, 0.02, -t));
			blitz.visible = b > 0.01;
			blitz.scale.setScalar(huelle * (4 + 6 * sm(0, 0.35, t)));
			blitz.material.color.setScalar(Math.min(1, b * 1.4));
			// Druckwelle: Radius wächst von 0,6 auf 5 Hüllenradien, Helligkeit fällt
			const re = 1 - Math.pow(1 - Math.min(1, t / 1.1), 3);
			uSt.value = 2.4 * Math.max(0, 1 - t / 1.1);
			ring.visible = uSt.value > 0.01;
			ring.scale.setScalar(huelle * 2 * (0.6 + 4.4 * re));
			// Strahlen: schießen kurz nach außen und verlöschen
			const st = Math.max(0, 1 - t / 0.55);
			for (const s of strahlen) { s.visible = st > 0.01; s.scale.z = s.userData.l * (0.2 + 1.8 * sm(0, 0.25, t)); }
			m.colorNode.needsUpdate = false;
		},
		/** Stationsmodell: Erscheinen mit kurzem Flackern und leichtem Nachfedern (0 = unsichtbar … 1 = fest), t: Sekunden seit Austritt */
		erscheinen(t) {
			if (t < 0) return { sichtbar: false, skala: 1 };
			if (t < 0.2) return { sichtbar: Math.floor(t * 40) % 2 === 0 || t > 0.12, skala: 0.94 + 0.06 * sm(0, 0.2, t) };
			return { sichtbar: true, skala: 1 };
		},
		dispose() { geo.dispose(); m.dispose(); ringMat.dispose(); blitz.material.map.dispose(); blitz.material.dispose(); szene.remove(gruppe); },
	};
}
