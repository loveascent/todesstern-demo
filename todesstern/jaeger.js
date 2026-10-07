// Jägerstaffel („Leichter Jäger“, 25 m lang): fliegt auf die Kamera zu und an ihr vorbei, mit Triebwerksglut und Kondensstreifen.
// Zweck: Größenmaßstab. Weit weg sind es Lichtpunkte mit Schweif, nah ein echtes Schiff – daran liest man, wie weit die Station entfernt ist.
// Alle Maße in Szeneneinheiten (Modelleinheiten der Station, 1 Einheit = 0,6 km); die Staffel liegt in der Gruppe der Welt (Kamera im Ursprung).
// Das Modell ist ein einfaches Low-Poly-Schiff; ein besseres Modell kann über `modell` (Object3D, Nase +z, Länge 1) eingesetzt werden.
import * as THREE from 'three/webgpu';
import { attribute, color, float, pow, abs, max } from 'three/tsl';

export const JAEGER_LAENGE_KM = 0.025;     // 25 m

function schiffGeometrie() {
	const T = [];   // Dreiecke aus Punkten [x, y, z]
	const tri = (a, b, c) => T.push(a, b, c);
	const N = [0, 0, 0.5];
	const f = [[0.06, 0, 0.1], [0, 0.045, 0.1], [-0.06, 0, 0.1], [0, -0.035, 0.1]];
	const h = [[0.055, 0, -0.5], [0, 0.05, -0.5], [-0.055, 0, -0.5], [0, -0.04, -0.5]];
	for (let i = 0; i < 4; i++) {
		const j = (i + 1) % 4;
		tri(N, f[j], f[i]);                      // Nase
		tri(f[i], f[j], h[j]); tri(f[i], h[j], h[i]);   // Rumpf
	}
	tri(h[0], h[1], h[2]); tri(h[0], h[2], h[3]);
	// Tragflächen (gepfeilt)
	tri([-0.06, 0, 0.05], [-0.055, 0, -0.45], [-0.5, -0.02, -0.45]);
	tri([0.06, 0, 0.05], [0.5, -0.02, -0.45], [0.055, 0, -0.45]);
	// Leitwerke
	tri([-0.05, 0.04, -0.2], [-0.05, 0.04, -0.5], [-0.07, 0.22, -0.5]);
	tri([0.05, 0.04, -0.2], [0.07, 0.22, -0.5], [0.05, 0.04, -0.5]);
	const pos = new Float32Array(T.length * 3);
	T.forEach((p, i) => pos.set(p, i * 3));
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	g.computeVertexNormals();
	return g;
}

function glutTextur() {
	const c = document.createElement('canvas'); c.width = c.height = 64;
	const g = c.getContext('2d');
	const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
	r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(150,200,255,0.8)'); r.addColorStop(1, 'rgba(0,0,0,0)');
	g.fillStyle = r; g.fillRect(0, 0, 64, 64);
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.premultiplyAlpha = true; return t;
}

const FORMATION = [[0, 0, 0], [-1, -0.45, -0.9], [1, -0.45, -0.9], [-2, -0.9, -1.8], [2, -0.9, -1.8], [-3, -1.35, -2.7], [3, -1.35, -2.7]];   // (rechts, oben, zurück) in Schiffsabständen

export function erzeugeJaeger(gruppe, { anzahl = 7, modell = null } = {}) {
	const geo = schiffGeometrie();
	const mat = new THREE.MeshStandardNodeMaterial({ color: 0x9aa0aa, metalness: 0.55, roughness: 0.5, side: THREE.DoubleSide });
	const glut = glutTextur();
	const N = Math.min(anzahl, FORMATION.length);
	const schiffe = [];
	const TRAIL = 220;       // Punkte je Schweif
	const SPUR_ALTER = 3.6;  // Sekunden, nach denen der Schweif ganz verschwunden ist
	for (let i = 0; i < N; i++) {
		const mesh = modell ? modell.clone() : new THREE.Mesh(geo, mat);
		mesh.visible = false;
		gruppe.add(mesh);
		const g1 = new THREE.Sprite(new THREE.SpriteNodeMaterial({ map: glut, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0x9fd0ff }));
		g1.renderOrder = 12; g1.visible = false; gruppe.add(g1);
		// Schweif: Band zur Kamera gedreht, Alpha je Punkt
		const bg = new THREE.BufferGeometry();
		const pos = new Float32Array(TRAIL * 2 * 3), al = new Float32Array(TRAIL * 2), qu = new Float32Array(TRAIL * 2), idx = [];
		for (let k = 0; k < TRAIL; k++) { qu[2 * k] = -1; qu[2 * k + 1] = 1; }
		for (let k = 0; k < TRAIL - 1; k++) { const a = 2 * k; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
		bg.setIndex(idx);
		bg.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
		bg.setAttribute('alpha', new THREE.BufferAttribute(al, 1).setUsage(THREE.DynamicDrawUsage));
		bg.setAttribute('quer', new THREE.BufferAttribute(qu, 1));
		const bm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
		bm.colorNode = color(0.82, 0.9, 1.0);
		bm.opacityNode = attribute('alpha', 'float').mul(pow(max(float(1).sub(abs(attribute('quer', 'float'))), 0), 1.4));
		const band = new THREE.Mesh(bg, bm);
		band.frustumCulled = false; band.renderOrder = 9; band.visible = false; gruppe.add(band);
		schiffe.push({ mesh, g1, band, bg, pos, al, hist: [], versatz: FORMATION[i] });
	}
	let flug = null;
	const v = new THREE.Vector3(), r = new THREE.Vector3(), q = new THREE.Quaternion(), z = new THREE.Vector3(0, 0, 1), s = new THREE.Vector3();

	return {
		get aktiv() { return !!flug; },
		/**
		 * Flug starten. Die Staffel nähert sich im Abstand d(t) = (√d0 − k·t/2)² dem Vorbeiflugpunkt `ziel` (Abbremsen der scheinbaren Geschwindigkeit nahe der Kamera:
		 * weit weg schnell, nah langsam genug, dass man das Schiff erkennt) und fliegt danach weiter.
		 * start: Punkt des Beginns, ziel: Vorbeiflugpunkt, k: Geschwindigkeitsfaktor in Szeneneinheiten^0,5 je Sekunde
		 */
		starte({ start, ziel, k = 7, einheitKm = 0.6 }) {
			const S = new THREE.Vector3(...start), Zp = new THREE.Vector3(...ziel);
			const d0 = S.distanceTo(Zp);
			flug = { S, Z: Zp, richtung: Zp.clone().sub(S).normalize(), d0, k, t: 0, L: JAEGER_LAENGE_KM / einheitKm };
			for (const sch of schiffe) sch.mesh.scale.setScalar(flug.L);
			for (const sch of schiffe) { sch.hist.length = 0; }
		},
		stoppe() { flug = null; for (const sch of schiffe) { sch.mesh.visible = sch.g1.visible = sch.band.visible = false; sch.hist.length = 0; } },
		/** dt: Sekunden; pxWelt: Weltgröße eines Pixels in 1 Einheit Abstand; sonne: Richtung zur Sonne (Einheitsvektor) */
		update(dt, pxWelt) {
			if (!flug) return;
			flug.t += dt;
			const w0 = Math.sqrt(flug.d0), sRest = w0 - flug.k * flug.t / 2;
			const d = sRest >= 0 ? sRest * sRest : -sRest * sRest;   // Abstand zum Vorbeiflugpunkt (negativ = schon vorbei)
			const spitze = flug.Z.clone().addScaledVector(flug.richtung, -d);   // d > 0: vor dem Punkt
			let sichtbarJe = 0;
			for (const sch of schiffe) {
				const o = sch.versatz;
				// Formation: Seiten- und Höhenabstand quer zur Flugrichtung, Rückversatz entlang
				r.set(0, 1, 0).cross(flug.richtung).normalize();                 // rechts
				if (r.lengthSq() < 1e-6) r.set(1, 0, 0);
				const up = v.copy(flug.richtung).cross(r).normalize();
				const L = flug.L * 3.2;
				const p = spitze.clone().addScaledVector(r, o[0] * L).addScaledVector(up, o[1] * L).addScaledVector(flug.richtung, o[2] * L);
				sch.mesh.position.copy(p);
				q.setFromUnitVectors(z, flug.richtung);
				sch.mesh.quaternion.copy(q);
				const abs = p.length();
				const hinterKamera = false;
				sch.mesh.visible = !hinterKamera;
				// Glut: mindestens ~2 Pixel groß, damit auch das weit entfernte Schiff als Lichtpunkt sichtbar bleibt
				const tail = p.clone().addScaledVector(flug.richtung, -flug.L * 0.5);
				sch.g1.position.copy(tail);
				sch.g1.visible = !hinterKamera;
				const px = Math.max(2.2, flug.L * 0.45 / (abs * pxWelt));
				sch.g1.scale.setScalar(px * pxWelt * abs);
								// Schweif
				const h = sch.hist;
				h.push({ p: tail.clone(), t: flug.t });
				while (h.length > 220 || (h.length && flug.t - h[0].t > 2.6)) h.shift();
				const n = h.length;
				sch.band.visible = n > 1 && !hinterKamera;
				if (n > 1) {
					for (let i = 0; i < n; i++) {
						const a = h[i], bP = h[Math.min(n - 1, i + 1)].p, aP = h[Math.max(0, i - 1)].p;
						v.copy(bP).sub(aP);
						if (v.lengthSq() < 1e-12) v.copy(flug.richtung);
						r.copy(a.p).negate();                                   // zur Kamera (Ursprung)
						s.copy(v).cross(r).normalize();
						const alter = (flug.t - a.t) / 2.6;
						// Breite: am Schiff dünn, nach hinten breiter (Aufweitung), mindestens ~1,2 Pixel
						const dist = a.p.length();
						const breite = Math.max(flug.L * (0.12 + 1.1 * alter), dist * pxWelt * 1.6) * 0.5;
						sch.pos.set([a.p.x + s.x * breite, a.p.y + s.y * breite, a.p.z + s.z * breite], 6 * i);
						sch.pos.set([a.p.x - s.x * breite, a.p.y - s.y * breite, a.p.z - s.z * breite], 6 * i + 3);
						const al = Math.pow(1 - alter, 1.8) * 0.5 * Math.min(1, (flug.t - a.t) * 12 + 0.15);
						sch.al[2 * i] = sch.al[2 * i + 1] = al;
					}
					// Rest des Puffers entwerten (degenerierte Dreiecke am letzten Punkt)
					for (let i = n; i < 220; i++) { sch.pos.copyWithin(6 * i, 6 * (n - 1), 6 * (n - 1) + 6); sch.al[2 * i] = sch.al[2 * i + 1] = 0; }
					sch.bg.attributes.position.needsUpdate = true; sch.bg.attributes.alpha.needsUpdate = true;
				}
				if (sch.mesh.visible) sichtbarJe++;
			}
			// Ende: Staffel weit hinter dem Vorbeiflugpunkt oder hinter der Kamera und die Schweife ausgeklungen
			if (sRest < -w0 * 0.6 && flug.t > 6) this.stoppe();
		},
		dispose() { for (const sch of schiffe) { gruppe.remove(sch.mesh, sch.g1, sch.band); sch.bg.dispose(); sch.band.material.dispose(); sch.g1.material.dispose(); } geo.dispose(); mat.dispose(); glut.dispose(); },
	};
}
