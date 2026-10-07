// Todesstern für three.js r186 (WebGPURenderer, Rückfall WebGL 2 automatisch).
// Modell: GLB aus Blender (Materialien gebacken, gltfpack: meshopt + KTX2).
// Effekte (Blitze, Plasmaschein, Emitterlichter, Schuss) laufen hier im Code, Werte 1:1 aus der Blender-Szene
// (Treiberausdrücke, Knotengruppe TS_Blitze/TS_Blitz_Ziel, Materialien) – siehe README.md.
//
//   import { ladeTodesstern, STUFEN } from './todesstern.js';
//   const ts = await ladeTodesstern(renderer, { stufe: 'mittel', basis: './' });
//   scene.add(ts.gruppe);  ... in der Bildschleife: ts.update(sekunden, kamera);  ts.feuer();

import * as THREE from 'three/webgpu';
import {
	Fn, attribute, uniform, vec3, vec4, float, sin, mix, normalize, cross, cameraPosition, abs, pow, max,
	smoothstep, select, varying, mx_fractal_noise_vec3, positionWorld, normalWorld, dot, PI, color,
	positionLocal, positionView, modelWorldMatrixInverse, viewportDepthTexture, perspectiveDepthToViewZ, cameraNear, cameraFar,
	Loop, sqrt, min, length, vec2,
} from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// ---------------------------------------------------------------- Qualitätsstufen
// dpr: max. Pixelverhältnis · lichter: Emitter-Punktlichter (Blender: 16) · blitzPunkte: Stützpunkte je Blitz
// (Blender: 72/40/24) · bloom: Auflösung des Bloom-Durchgangs (0 = aus) · halo: Mindestbreite der Blitze in Pixeln
export const STUFEN = {
	hoch:    { glb: 'todesstern_hoch.glb',    himmel: 'himmel_4096.jpg', dpr: 2,   lichter: 16, blitzPunkte: 72, bloom: 1,   szene: 1,    dunstSchritte: 8, schatten: 3, schattenKarte: 2048 },
	mittel:  { glb: 'todesstern_mittel.glb',  himmel: 'himmel_2048.jpg', dpr: 1.5, lichter: 4,  blitzPunkte: 40, bloom: 0.5, szene: 1,    dunstSchritte: 4, schatten: 1, schattenKarte: 1024 },
	niedrig: { glb: 'todesstern_niedrig.glb', himmel: 'himmel_1024.jpg', dpr: 1,   lichter: 2,  blitzPunkte: 20, bloom: 0,   szene: 0.85, dunstSchritte: 0, schatten: 0, schattenKarte: 0 },
};

const FPS_BLENDER = 30; // Zeitbasis aller Treiber („frame")

// Abgleich an Blender-Bildern (Nahkamera CAM_Nah_Emitter): Rauschskala MaterialX->Blender, Scheinanteil, Dunst
// Werte aus Bildvergleich mit Blender (werkzeuge/vergleich.py; CAM_Icon Abweichung 57 -> 7.4 von 255):
// bloomStaerke 0.12: Blender-Glare 0.6 / Summe der 5 Mip-Gewichte von BloomNode (3.0) ≈ 0.2, am Bild auf 0.12 gesenkt.
export const ABGLEICH = { rausch: 1 / 2.35, schein: 0.3, dunst: 1, kern: 1, licht: 1, sonne: 1, bloomRadius: 0.3, bloomStaerke: 0.12 };

// ---------------------------------------------------------------- Blender -> glTF (Y oben)
const achse = ([x, y, z]) => new THREE.Vector3(x, z, -y);
// Kamera: nur die Weltseite umrechnen (Blickrichtung -Z / oben +Y ist in beiden gleich): q' = C · q
const C_ACHSE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const kamQuat = ([w, x, y, z]) => C_ACHSE.clone().multiply(new THREE.Quaternion(x, y, z, w));

// Kameras aus der Blender-Szene (Weltlage, Blickwinkel horizontal bei AUTO-Sensor)
export const KAMERAS = {
	icon:       { pos: [18.7111, 9.5338, 0], q: [0.49120, 0.23021, 0.66858, 0.50865], fov: 0.69111, shift: [0.06, -0.08] },
	front:      { pos: [-8.9006, -31.0402, 3.6791], q: [0.73880, 0.65940, -0.09267, -0.10383], fov: 0.41736, shift: [0, 0.0337] },
	ueberblick: { pos: [17, -19, 9], q: [0.76142, 0.53445, 0.21078, 0.30029], fov: 0.84571, shift: [0, 0] },
	emitter:    { pos: [10.5, -2.2, 2.2], q: [0.60888, 0.48414, 0.39109, 0.49186], fov: 1.02478, shift: [0, 0] },
};

export function setzeKamera(kamera, name) {
	const k = KAMERAS[name];
	kamera.position.copy(achse(k.pos));
	kamera.quaternion.copy(kamQuat(k.q));
	kameraProjektion(kamera, name);
}

// Nur Bildwinkel + Objektivverschiebung (nach Größenänderung erneut aufrufen)
export function kameraProjektion(kamera, name) {
	const k = KAMERAS[name];
	// Blender AUTO: Winkel gilt für die längere Seite (Querformat = Breite). Hochformat (Handy): ebenfalls an der
	// Breite ausrichten, sonst ist die Station seitlich abgeschnitten.
	const a = kamera.aspect;
	kamera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(k.fov / 2) / a));
	// Objektivverschiebung (Blender shift, Anteil der längeren Seite) als View-Offset
	const Wv = 1000 * Math.max(a, 1), Hv = Wv / a, L = Wv; // Hochformat: auf die Breite bezogen (Station bleibt mittig)
	if (k.shift[0] || k.shift[1]) kamera.setViewOffset(Wv, Hv, k.shift[0] * L, -k.shift[1] * L, Wv, Hv);
	else kamera.clearViewOffset();
	kamera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- Steuerkurven (Aktion der STEUERUNG, 480 Bilder)
const KURVEN = {
	ladung:  [[1, 0], [90, 0], [192, 1], [300, 0.55], [338, 0]],
	bluete:  [[1, 0], [150, 0], [190, 1], [324, 1], [370, 0]],
	strahl:  [[1, 0], [195, 0], [200, 1], [220, 0.72], [300, 0.7], [318, 0]],
};
function kurve(k, f) {
	if (f <= k[0][0]) return k[0][1];
	for (let i = 1; i < k.length; i++) {
		if (f <= k[i][0]) {
			const [f0, v0] = k[i - 1], [f1, v1] = k[i];
			const x = (f - f0) / (f1 - f0);
			return v0 + (v1 - v0) * x * x * (3 - 2 * x); // Bezier mit flachen Griffen ≈ smoothstep
		}
	}
	return k[k.length - 1][1];
}

// ---------------------------------------------------------------- Zufall wie „Random Value" je (Gruppe, Takt)
function hash(a, b) {
	let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
	h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
	return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- Blitze (GPU)
// Nachbau der Knotengruppe TS_Blitze: Kante A->B, neu abgetastet, 2 Rausch-Oktavenbänder (Skala 1 und 4.5,
// Gewicht 1 und 0.28), Detail 3, Rauheit 0.65, Enden fest (sin(pi*t)), Bogen je Gruppe, Kern + additiver Schein.
// Statt Röhren: zur Kamera gedrehte Bänder mit Röhrenprofil im Pixelshader (2 statt 10–16 Dreiecke je Abschnitt),
// Mindestbreite in Pixeln gegen Flimmern, Helligkeit dabei energieerhaltend verringert.
class Blitzsystem {
	constructor(daten, p, punkte) {
		this.p = p;
		const kanten = daten.E;
		this.n = kanten.length;
		this.A = kanten.map(e => new THREE.Vector3(...daten.V[e[0]]));
		this.B = kanten.map(e => new THREE.Vector3(...daten.V[e[1]]));
		this.gruppe = kanten.map(e => Math.round(daten.gruppe[e[0]]));
		if (daten.ende) {
			this.endeA = kanten.map(e => daten.ende[e[0]] > 0.5);
			this.endeB = kanten.map(e => daten.ende[e[1]] > 0.5);
			this.zielwinkel = kanten.map(e => daten.zielwinkel[e[0]]);
		}
		// Bogenrichtung je Gruppe (fest, Blender: Random Value Seed 31)
		this.bogen = this.gruppe.map(g => new THREE.Vector3(hash(g, 31) * 2 - 1, hash(g, 32) * 2 - 1, hash(g, 33) * 2 - 1).normalize());

		const g = new THREE.InstancedBufferGeometry();
		const tt = new Float32Array(punkte * 2), seite = new Float32Array(punkte * 2), pos = new Float32Array(punkte * 6);
		for (let i = 0; i < punkte; i++) {
			tt[2 * i] = tt[2 * i + 1] = i / (punkte - 1);
			seite[2 * i] = -1; seite[2 * i + 1] = 1;
		}
		const idx = [];
		for (let i = 0; i < punkte - 1; i++) { const a = 2 * i; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
		g.setIndex(idx);
		g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		g.setAttribute('tt', new THREE.BufferAttribute(tt, 1));
		g.setAttribute('seite', new THREE.BufferAttribute(seite, 1));
		this.iA = new THREE.InstancedBufferAttribute(new Float32Array(this.n * 3), 3);
		this.iB = new THREE.InstancedBufferAttribute(new Float32Array(this.n * 3), 3);
		this.iBow = new THREE.InstancedBufferAttribute(new Float32Array(this.n * 3), 3);
		this.iHell = new THREE.InstancedBufferAttribute(new Float32Array(this.n), 1);
		for (const a of [this.iA, this.iB, this.iBow, this.iHell]) a.setUsage(THREE.DynamicDrawUsage);
		g.setAttribute('iA', this.iA); g.setAttribute('iB', this.iB); g.setAttribute('iBow', this.iBow); g.setAttribute('iHell', this.iHell);
		g.instanceCount = this.n;
		g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 8);

		this.uW = uniform(0);          // Fluss * 1.618 (Blender: W des 4D-Rauschens)
		this.uKern = uniform(30);      // Kernhelligkeit (Material TS_Blitz)
		this.uSchein = uniform(3.2);   // Scheinhelligkeit (TS_Blitz_Halo)
		this.uPx = uniform(0.001);     // Weltgröße eines Pixels in 1 m Abstand

		const F = float(p.feinheit), amp = float(p.amplitude * ABGLEICH.rausch); // MaterialX-fBm unnormiert: 1+.65+.42+.27
		const dicke = float(p.dicke), halo = float(p.dicke * p.halo);
		const punkt = Fn(([t]) => {
			const A = attribute('iA', 'vec3'), B = attribute('iB', 'vec3'), bow = attribute('iBow', 'vec3');
			const basis = mix(A, B, t);
			const w = this.uW;
			const n1 = mx_fractal_noise_vec3(basis.mul(F).add(vec3(w, w.mul(0.71), w.mul(1.37))), 4, 2.0, 0.65, 1.0);
			const n2 = mx_fractal_noise_vec3(basis.mul(F.mul(4.5)).add(vec3(w.mul(1.9), w, w.mul(0.53))), 4, 2.0, 0.65, 1.0);
			const off = n1.add(n2.mul(0.28)).mul(amp).add(bow);
			return basis.add(off.mul(sin(t.mul(PI))));
		});
		// Breiten (Kern, Schein, Band) aus dem Abstand zur Kamera – im Vertex-Shader berechnet, per varying weitergereicht
		const breiten = Fn(() => {
			const basis = mix(attribute('iA', 'vec3'), attribute('iB', 'vec3'), attribute('tt', 'float'));
			const px = cameraPosition.sub(basis).length().mul(this.uPx);
			const kern = max(dicke, px.mul(0.7)), schein = max(halo, px.mul(2.5));
			return vec3(max(kern, schein), kern, schein);
		});
		const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
		m.positionNode = Fn(() => {
			const t = attribute('tt', 'float'), s = attribute('seite', 'float'), hell = attribute('iHell', 'float');
			const p1 = punkt(t), p2 = punkt(t.add(0.01));
			const tang = normalize(p2.sub(p1));
			const quer = normalize(cross(tang, normalize(cameraPosition.sub(p1))));
			return select(hell.greaterThan(0), p1.add(quer.mul(s.mul(breiten().x))), vec3(0));
		})();
		const vB = varying(breiten()), vS = varying(attribute('seite', 'float')), vH = varying(attribute('iHell', 'float'));
		m.colorNode = Fn(() => {
			const d = abs(vS).mul(vB.x);
			const kernMaske = float(1).sub(smoothstep(vB.y.mul(0.6), vB.y, d));
			const kernI = this.uKern.mul(vH).mul(dicke.div(vB.y));
			const x = d.div(vB.z);
			const scheinI = this.uSchein.mul(vH).mul(halo.div(vB.z)).mul(pow(max(float(1).sub(x.mul(x)), 0), 1.5));
			return vec4(color(0.72, 0.87, 1.0).mul(kernI.mul(kernMaske)).add(color(0.12, 0.42, 1.0).mul(scheinI)), 1);
		})();
		this.mesh = new THREE.Mesh(g, m);
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 10;
	}

	// f = Blender-Bild, anteil = sichtbarer Anteil, takt/fluss wie die Treiber, dreh = Trommelwinkel (Blender rot.y)
	update(f, { takt, fluss, anteil, dreh, ziel, kern, schein, pxScale }) {
		const T = Math.floor(takt);
		this.uW.value = fluss * 1.618;
		this.uKern.value = kern * ABGLEICH.kern; this.uSchein.value = schein * ABGLEICH.schein; this.uPx.value = pxScale;
		const a = this.iA.array, b = this.iB.array, bw = this.iBow.array, h = this.iHell.array;
		for (let i = 0; i < this.n; i++) {
			const g = this.gruppe[i];
			let sicht = anteil > 0 && hash(g, T) <= anteil;
			let A = this.A[i], B = this.B[i];
			if (sicht && ziel) {
				// TS_Blitz_Ziel: auf den nächsten Empfänger einrasten, über Lücken löschen
				const rel = ((this.zielwinkel[i] + dreh) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
				const sn = (Math.floor(rel / ziel.Teilung) + 0.5) * ziel.Teilung;
				const drin = (sn > ziel.Bogen1_von + ziel.Rand && sn < ziel.Bogen1_bis - ziel.Rand) ||
					(sn > ziel.Bogen2_von + ziel.Rand && sn < ziel.Bogen2_bis - ziel.Rand);
				if (!drin) sicht = false;
				const an = sn - dreh;
				const rast = (P) => { const r = Math.hypot(P.x, P.y); return new THREE.Vector3(r * Math.cos(an), r * Math.sin(an), P.z); };
				if (this.endeA[i]) A = rast(A);
				if (this.endeB[i]) B = rast(B);
			}
			a[3 * i] = A.x; a[3 * i + 1] = A.y; a[3 * i + 2] = A.z;
			b[3 * i] = B.x; b[3 * i + 1] = B.y; b[3 * i + 2] = B.z;
			const bo = this.bogen[i].clone().multiplyScalar(this.p.bogen || 0);
			bw[3 * i] = bo.x; bw[3 * i + 1] = bo.y; bw[3 * i + 2] = bo.z;
			h[i] = sicht ? 0.35 + 1.25 * hash(g, T + 977) : 0; // Blender: Random Value 0.35..1.6, Seed Takt+977
		}
		this.iA.needsUpdate = this.iB.needsUpdate = this.iBow.needsUpdate = this.iHell.needsUpdate = true;
	}
}

// ---------------------------------------------------------------- Leuchthüllen (Plasma, Strahl)
function huelle(geo, farbe, profil) {
	// Emission * (Blickwinkel-Profil) additiv – wie Layer Weight „Facing" + Transparent in Blender
	const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
	const staerke = uniform(0);
	m.colorNode = Fn(() => {
		const v = normalize(cameraPosition.sub(positionWorld));
		const zu = abs(dot(normalWorld, v));
		return vec4(color(...farbe).mul(pow(zu, profil)).mul(staerke), 1);
	})();
	const mesh = new THREE.Mesh(geo, m);
	mesh.renderOrder = 11;
	return { mesh, staerke };
}

function dunstVolumen(N) {
	const R = 3.39, Z0 = -1.95, Z1 = 2.2;
	const geo = new THREE.CylinderGeometry(R, R, Z1 - Z0, 48, 1, false).rotateX(Math.PI / 2).translate(0, 0, (Z0 + Z1) / 2);
	const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.BackSide });
	const staerke = uniform(0.95);
	m.colorNode = Fn(() => {
		const ro = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
		const zuFrag = positionLocal.sub(ro);
		const tFrag = length(zuFrag);
		const rd = zuFrag.div(tFrag);
		// Zylindermantel x²+y²=R²
		const a = rd.x.mul(rd.x).add(rd.y.mul(rd.y)).max(1e-6);
		const bq = ro.x.mul(rd.x).add(ro.y.mul(rd.y));
		const c = ro.x.mul(ro.x).add(ro.y.mul(ro.y)).sub(R * R);
		const w = sqrt(max(bq.mul(bq).sub(a.mul(c)), 0));
		const t0 = bq.negate().sub(w).div(a), t1 = bq.negate().add(w).div(a);
		// Deckel z0..z1
		const iz = float(1).div(select(abs(rd.z).lessThan(1e-5), float(1e-5), rd.z));
		const za = float(Z0).sub(ro.z).mul(iz), zb = float(Z1).sub(ro.z).mul(iz);
		const tein = max(max(min(za, zb), t0), 0);
		// Szenentiefe (opake Geometrie) entlang des Strahls
		const szeneZ = perspectiveDepthToViewZ(viewportDepthTexture(), cameraNear, cameraFar);
		const tSzene = tFrag.mul(szeneZ.div(positionView.z));
		const taus = min(min(max(za, zb), t1), min(tFrag, tSzene));
		const len = max(taus.sub(tein), 0);
		const dt = len.div(N);
		const summe = float(0).toVar();
		Loop(N, ({ i }) => {
			const p = ro.add(rd.mul(tein.add(dt.mul(float(i).add(0.5)))));
			const r = length(vec2(p.x, p.y));
			summe.addAssign(pow(max(float(3.4).sub(r), 0).div(1.65), 1.6));
		});
		return vec4(color(0.04, 0.46, 1).mul(summe.mul(dt).mul(0.45).mul(staerke)), 1);
	})();
	const mesh = new THREE.Mesh(geo, m);
	mesh.renderOrder = 9;
	mesh.frustumCulled = false;
	return { mesh, staerke };
}

// ---------------------------------------------------------------- Laden
export async function ladeTodesstern(renderer, { stufe = 'mittel', basis = './', onFortschritt, glb, strahlExtern = false } = {}) {
	const S = { ...STUFEN[stufe], ...(glb ? { glb } : {}) };
	const ktx2 = new KTX2Loader().setTranscoderPath(new URL('./vendor/three-0.186.1/examples/jsm/libs/basis/', import.meta.url).href).detectSupport(renderer);
	const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
	const [gltf, blitzDaten] = await Promise.all([
		loader.loadAsync(basis + S.glb, e => onFortschritt?.(e.loaded / (e.total || 1))),
		fetch(basis + 'blitze.json').then(r => r.json()),
	]);
	const wurzel = gltf.scene;
	const knoten = n => wurzel.getObjectByName(n);
	const trommel = knoten('ROTOR_TROMMEL'), ring = knoten('ROTOR_RING');
	const blaetter = [];
	for (let i = 1; i <= 8; i++) {
		const b = knoten(`WEB_Blatt_${i}`);
		blaetter.push({ o: b, ruhe: b.quaternion.clone() });
	}
	let iris = knoten('WEB_Iris');
	if (iris && !iris.isMesh) iris.traverse(o => { if (o.isMesh && !iris.isMesh) iris = o; });
	if (iris) iris.material = iris.material.clone(); // eigene Leuchtstärke
	const irisBasis = iris?.material?.emissiveIntensity ?? 0;
	wurzel.traverse(o => { if (o.isMesh) { o.castShadow = o.receiveShadow = S.schatten > 0; } });

	const gruppe = new THREE.Group();
	gruppe.name = 'Todesstern';
	gruppe.add(wurzel);

	// Blitze
	const saeule = new Blitzsystem(blitzDaten.saeule, { amplitude: 0.13, feinheit: 1.1, dicke: 0.011, halo: 7, bogen: 0.38 }, S.blitzPunkte);
	const waffe = new Blitzsystem(blitzDaten.waffe, { amplitude: 0.16, feinheit: 2.4, dicke: 0.016, halo: 3 }, Math.max(12, Math.round(S.blitzPunkte * 40 / 72)));
	const plasma = new Blitzsystem(blitzDaten.plasma, { amplitude: 0.07, feinheit: 3.5, dicke: 0.014, halo: 4 }, Math.max(8, Math.round(S.blitzPunkte * 24 / 72)));
	gruppe.add(saeule.mesh, waffe.mesh, plasma.mesh);

	// Emitterlichter (16 in Blender; Stufen: 16 / 4 / 0). Energie-Treiber:
	// b*(1+0.7*l)*(240+170*sin(frame*0.93+1.7*i)*sin(frame*0.41+0.8*i)), glTF-Umrechnung W/(4π)
	const LP = [[2.256, -1.1, 0.449], [2.256, 0.8, 0.449], [1.278, -1.1, 1.912], [1.278, 0.8, 1.912], [-0.449, -1.1, 2.256], [-0.449, 0.8, 2.256],
		[-1.912, -1.1, 1.278], [-1.912, 0.8, 1.278], [-2.256, -1.1, -0.449], [-2.256, 0.8, -0.449], [-1.278, -1.1, -1.912], [-1.278, 0.8, -1.912],
		[0.449, -1.1, -2.256], [0.449, 0.8, -2.256], [1.912, -1.1, -1.278], [1.912, 0.8, -1.278]];
	const lichter = [];
	const wahl = S.lichter === 16 ? LP.map((_, i) => i) : S.lichter === 4 ? [0, 5, 8, 13] : S.lichter === 2 ? [1, 9] : [];
	for (const i of wahl) {
		const l = new THREE.PointLight(new THREE.Color(0.18, 0.62, 1), 0, 0, 2);
		l.position.copy(achse(LP[i]));
		gruppe.add(l);
		lichter.push({ l, i, faktor: 16 / wahl.length });
	}

	// Plasmadunst im Blitzraum = Volumen TS_Plasma_Dunst (nur Emission, keine Dichte):
	// e(r) = ((3.4 - r) / 1.65)^1.6 · (1.6·Rauschen^2.5 + 0.15) · 0.95·b·(1+0.8·l), Farbe (0.04, 0.46, 1),
	// Zylinder r 3.39, Achse glTF-z von -1.95 bis 2.2. Hier: Strahl-Zylinder-Schnitt, Integration in N Schritten,
	// am Szenen-Tiefenpuffer abgeschnitten (Wände/Säule verdecken den Dunst wie in Blender). Rauschen als Mittelwert (0.45).
	const dunst = S.dunstSchritte ? dunstVolumen(S.dunstSchritte) : null;
	if (dunst) gruppe.add(dunst.mesh);

	// Sockel des Strahls: Ort der Iris im Modell (aus dem Knoten gemessen, nicht eingetragen). Ein externer Strahl (strahl.js) wird Kind dieses Knotens,
	// dann stimmt seine Richtung immer mit der Station überein, egal wie diese gedreht ist. Achse = +z des Modells.
	wurzel.updateMatrixWorld(true);
	const sockel = new THREE.Object3D();
	sockel.name = 'Strahlsockel';
	const irisKnoten = knoten('WEB_Iris');   // der Knoten selbst, nicht das Netz darunter (dessen Ursprung liegt nicht in der Mitte)
	if (irisKnoten) sockel.position.setFromMatrixPosition(irisKnoten.matrixWorld);
	else sockel.position.set(0, 0, 4.45);
	gruppe.add(sockel);

	// Schuss: Strahl_Kern/Mantel/Schein (Radius 0.14/0.3/0.6, Start 5.35 vor der Mitte, 400 lang), Mündungsblitz (nur ohne externen Strahl)
	const strahl = strahlExtern ? [] : [[0.14, [0.85, 0.95, 1]], [0.3, [0.25, 0.6, 1]], [0.6, [0.15, 0.45, 1]]].map(([r, f]) => {
		const h = huelle(new THREE.CylinderGeometry(r, r, 1, 24, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2), f, 2.0);
		h.mesh.position.z = 5.35;
		h.mesh.visible = false;
		gruppe.add(h.mesh);
		return h;
	});
	const muendung = strahlExtern ? null : huelle(new THREE.SphereGeometry(1, 24, 12), [0.45, 0.72, 1], 2.0);
	if (muendung) { muendung.mesh.position.z = 6.2; muendung.mesh.visible = false; gruppe.add(muendung.mesh); }

	let schussStart = -1, letzteSek = 0;
	const zustand = { ladung: 0, bluete: 0, strahl: 0 };

	function update(sek, kamera, hoehePx) {
		const f = sek * FPS_BLENDER + 1;
		const dtS = sek - letzteSek; letzteSek = sek;
		if (schussStart >= 0) {
			let fs = (sek - schussStart) * FPS_BLENDER + 1;
			if (zustand.halte && fs > 300) { schussStart += Math.min(dtS, 0.1); fs = 300; }   // Strahl bleibt stehen, bis der Schnitt fertig ist
			if (fs > 480) schussStart = -1;
			zustand.fs = fs;
			zustand.ladung = kurve(KURVEN.ladung, fs); zustand.bluete = kurve(KURVEN.bluete, fs); zustand.strahl = kurve(KURVEN.strahl, fs);
		} else zustand.ladung = zustand.bluete = zustand.strahl = 0;
		const { ladung: l, bluete: o, strahl: s } = zustand, b = 1;

		// Rotoren (Treiber: (frame-1)/30*0.026180 bzw. *-0.064577, Blender-Y = glTF -Z)
		const drehT = (f - 1) / 30 * 0.026180, drehR = (f - 1) / 30 * -0.064577;
		trommel.rotation.set(0, 0, -drehT);
		ring.rotation.set(0, 0, -drehR);
		const qx = new THREE.Quaternion();
		for (const bl of blaetter) bl.o.quaternion.copy(bl.ruhe).multiply(qx.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.785398 * o));
		if (iris) iris.material.emissiveIntensity = irisBasis * (0.15 + 6 * l * l + 8 * s) / 0.15;

		for (const { l: L, i, faktor } of lichter)
			L.intensity = ABGLEICH.licht * faktor * b * (1 + 0.7 * l) * (240 + 170 * Math.sin(f * 0.93 + 1.7 * i) * Math.sin(f * 0.41 + 0.8 * i)) / (4 * Math.PI);

		const pxScale = kamera ? 2 * Math.tan(THREE.MathUtils.degToRad(kamera.fov) / 2) / (hoehePx || 1000) : 0.001;
		saeule.update(f, { takt: f / 10, fluss: f * 0.012, anteil: Math.min(0.9, 0.55 * b * (1 + 0.5 * l)), dreh: drehT, ziel: blitzDaten.ziel,
			kern: 30 * b * (1 + 0.5 * l), schein: 3.2 * b * (1 + 0.6 * l), pxScale });
		waffe.update(f, { takt: f / 1.5 + 100, fluss: f / 1.5 + 100, anteil: Math.min(0.35, 0.5 * l * o), kern: 30 * b * (1 + 0.5 * l), schein: 3.2 * b * (1 + 0.6 * l), pxScale });
		plasma.update(f, { takt: f / 1.2 + 200, fluss: f / 1.2 + 200, anteil: Math.min(0.55, 0.3 + 0.3 * l), kern: 30 * b * (1 + 0.5 * l), schein: 3.2 * b * (1 + 0.6 * l), pxScale });

		const sl = Math.max(0.0005, Math.min(1, s * 1.4)) * (zustand.strahlMax ?? 400);   // OgameX-Login: strahlMax kuerzt den Strahl am Planeten
		const hs = [14 * s + 6 * l * l, 3.5 * s + 0.8 * l * l, 0.18 * s];
		strahl.forEach((h, k) => { h.mesh.visible = s > 0.001; h.mesh.scale.set(1, 1, sl); h.staerke.value = hs[k]; });
		const mb = 0.06 * l + 0.16 * s;
		if (muendung) { muendung.mesh.visible = mb > 0.002; muendung.mesh.scale.setScalar(Math.max(mb, 1e-3)); muendung.staerke.value = 14 * s + 6 * l * l; }
		if (dunst) dunst.staerke.value = ABGLEICH.dunst * 0.95 * b * (1 + 0.8 * l);
	}

	return {
		gruppe, update, zustand, sockel,
		feuer(sek) { if (schussStart < 0) schussStart = sek; },
		get schiesst() { return schussStart >= 0; },
		dispose() { gruppe.traverse(o => { o.geometry?.dispose(); if (o.material) [].concat(o.material).forEach(m => { for (const k in m) m[k]?.isTexture && m[k].dispose(); m.dispose(); }); }); ktx2.dispose(); },
	};
}

// ---------------------------------------------------------------- Szene wie in Blender
// Welt: Hintergrund = gebackenes Sternfeld (nur Kamerastrahlen), Beleuchtung = gleichmäßig (0.011, 0.036, 0.080)·0.6.
// Sonnen: Haupt 7.5 (1, .8, .58), Füll 2.5 (.75, .82, 1) hängen an der Kamera, Blau 2.2 (.35, .62, 1) fest.
export function szeneEinrichten(scene, kamera, { basis = './', stufe = 'mittel', renderer, ohneHimmel = false } = {}) {
	const S = STUFEN[stufe];
	const env = new THREE.DataTexture(new Float32Array(8 * 4 * 4).map((v, i) => [0.011 * 0.6, 0.0356 * 0.6, 0.0802 * 0.6, 1][i % 4]), 8, 4, THREE.RGBAFormat, THREE.FloatType);
	env.mapping = THREE.EquirectangularReflectionMapping;
	env.needsUpdate = true;
	scene.environment = env;
	if (!ohneHimmel) new THREE.TextureLoader().load(basis + S.himmel, t => {
		t.mapping = THREE.EquirectangularReflectionMapping;
		t.colorSpace = THREE.SRGBColorSpace;
		scene.background = t;
	});
	scene.backgroundRotation.set(0, Math.PI / 2, 0);
	if (renderer && S.schatten) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; }

	// Richtungen: Blau fest (Welt), Haupt/Füll hängen in Blender an CAM_Icon -> im Kamerasystem gespeichert
	const qIcon = kamQuat(KAMERAS.icon.q).invert();
	const sonnen = [
		{ farbe: [1, 0.8, 0.58], staerke: 7.5, dir: achse([-0.475, -0.002, -0.88]).applyQuaternion(qIcon), kamera: true },
		{ farbe: [0.75, 0.82, 1], staerke: 2.5, dir: achse([0.898, -0.413, 0.15]).applyQuaternion(qIcon), kamera: true },
		{ farbe: [0.35, 0.62, 1], staerke: 2.2, dir: achse([-0.211, 0.919, 0.332]), kamera: false },
	].map((d, k) => {
		const l = new THREE.DirectionalLight(new THREE.Color(...d.farbe), d.staerke);
		if (k < S.schatten) {
			l.castShadow = true;
			l.shadow.mapSize.set(S.schattenKarte, S.schattenKarte);
			const c = l.shadow.camera; c.left = c.bottom = -8.5; c.right = c.top = 8.5; c.near = 1; c.far = 40;
			l.shadow.bias = -0.0004; l.shadow.normalBias = 0.02;
		}
		scene.add(l, l.target);
		return { l, ...d };
	});
	const w = new THREE.Vector3();
	// je Bild aufrufen: Licht steht 20 Einheiten „hinter" der Station entgegen seiner Richtung (Schattenkamera umschließt sie)
	const qIconWelt = kamQuat(KAMERAS.icon.q);
	// folgen = true: Haupt-/Füll-Licht drehen mit der Kamera (wie licht_folgt im Film); false: fest wie an CAM_Icon
	return function lichtFolgt(folgen = true) {
		for (const s of sonnen) {
			w.copy(s.dir);
			if (s.kamera) w.applyQuaternion(folgen ? kamera.quaternion : qIconWelt);
			s.l.position.copy(w).multiplyScalar(-20);
			s.l.intensity = s.staerke * ABGLEICH.sonne;
			s.l.target.position.set(0, 0, 0);
		}
	};
}

// ---------------------------------------------------------------- Farbmanagement exakt wie Blender
// Blender rendert mit „AgX – Punchy". Die OCIO-Transformation ist aus Blender als 3D-LUT gebacken
// (agx_punchy_lut.png, 48³, Eingang log2-kodiert wie AgX: -12.47 … +4.03 EV um 0.18).
export const LUT = { n: 48, min: -12.47393, max: 4.026069, datei: 'agx_punchy_lut.png' };
export async function ladeLut(basis = './') {
	const bild = await createImageBitmap(await (await fetch(basis + LUT.datei)).blob());
	const c = new OffscreenCanvas(bild.width, bild.height), g = c.getContext('2d');
	g.drawImage(bild, 0, 0);
	const px = g.getImageData(0, 0, bild.width, bild.height).data, N = LUT.n;
	const d = new Uint8Array(N * N * N * 4);
	for (let b = 0; b < N; b++) for (let gg = 0; gg < N; gg++) for (let r = 0; r < N; r++) {
		const q = ((N - 1 - gg) * N * N + b * N + r) * 4, z = ((b * N + gg) * N + r) * 4; // PNG-Zeile 0 = oben (g = N-1)
		d[z] = px[q]; d[z + 1] = px[q + 1]; d[z + 2] = px[q + 2]; d[z + 3] = 255;
	}
	const t = new THREE.Data3DTexture(d, N, N, N);
	t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
	t.minFilter = t.magFilter = THREE.LinearFilter;
	t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
	t.generateMipmaps = false; t.unpackAlignment = 1; t.needsUpdate = true;
	return t;
}
