// Jägerstaffel („Leichter Jäger“, 25 m lang): fliegt auf die Kamera zu und dicht an ihr vorbei, mit Triebwerksglut und Kondensstreifen.
// Zweck: Größenmaßstab. Weit weg sind es Lichtpunkte mit Schweif, nah ein echtes Schiff – daran liest man, wie weit die Station entfernt ist.
// Alle Maße in Szeneneinheiten (Modelleinheiten der Station); die Staffel liegt in der Gruppe der Welt (Kamera im Ursprung). Der Aufrufer sagt nur
// „km je Szeneneinheit“ (`einheitKm`) und die Seite; alles andere kommt aus den Einstellungen `JAEGER_STANDARD` (live änderbar, siehe Editor „Jäger“).
//
// Flug (gerechnet, nicht geraten): Die Bahn ist eine Gerade, die die Kamera im Abstand `abstandM` verfehlt. Entlang der Bahn gilt
//   σ = Strecke bis zum nächsten Punkt (vorn > 0),  Tempo v(σ) = min(v_Anflug, ω · (σ² + D²) / D)
// Das ist die Geschwindigkeit, bei der der Blickwinkel zum Schiff mit der festen Winkelrate ω wandert: weit weg schnell (Anflug, bis ~1 km/s), kurz vor
// der Kamera nur noch so langsam, dass man das Schiff in Ruhe ansehen kann (D ≈ 130–200 m, ω = 0,3 rad/s → 40–60 m/s am nächsten Punkt, 150–220 km/h).
// Größe im Bild am Rand des Bildes (Schiff verlässt den Bildausschnitt bei σ ≈ 1,3 D): 25 m / 230 m ≈ 11 % → bei 900 Pixeln Bildhöhe ≈ 125 Pixel lang.
import * as THREE from 'three/webgpu';
import { attribute, color, float, pow, abs, max } from 'three/tsl';

export const JAEGER_LAENGE_KM = 0.025;     // 25 m

/** Einstellungen der Staffel (der Editor ändert dieses Objekt, jeder neue Flug liest es) */
export const JAEGER_STANDARD = {
	an: true,             // Staffel überhaupt zeigen
	wiederholen: true,    // nach `pauseS` Sekunden erneut fliegen
	pauseS: 30,           // Pause zwischen zwei Flügen
	anzahl: 7,            // Schiffe (1…7)
	groesse: 1,           // Faktor auf die echte Länge von 25 m
	abstandM: 130,        // Abstand des nächsten Schiffs der Staffel von der Kamera am nächsten Punkt der Bahn (m)
	winkelRate: 0.3,      // scheinbare Geschwindigkeit des Vorbeiflugs (rad/s); bestimmt das Tempo am nächsten Punkt = ω · Abstand
	anflugKmS: 1.2,       // Reisegeschwindigkeit im Anflug (km/s)
	startKm: 4.5,         // Entfernung, aus der die Staffel kommt (km); so ist sie rund 7 s nach Beginn am nächsten Punkt (Station kommt nach 3 s, Schuss nach 9,5 s)
	formation: 1,         // Faktor auf die Abstände in der Formation
	schweif: 1,           // Länge und Helligkeit der Kondensstreifen
	glut: 1,              // Größe der Triebwerksglut
	seite: 0,             // 0 = zufällig, −1 links, 1 rechts
};

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

// (rechts, oben, zurück) in Schiffslängen: enge Staffel (Kette), die seitlich höchstens 2,7 Längen (≈ 70 m) ausholt
const FORMATION = [[0, 0, 0], [-0.9, -0.1, -2], [0.9, -0.1, -2], [-1.8, -0.2, -4], [1.8, -0.2, -4], [-2.7, -0.3, -6], [2.7, -0.3, -6]];
const TRAIL = 220, SPUR_ALTER = 1.6, SPUR_TAKT = 1 / 90;
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function erzeugeJaeger(gruppe, { anzahl = 7, modell = null, parameter = {} } = {}) {
	// das übergebene Objekt selbst wird benutzt (der Editor ändert es)
	const P = Object.assign(parameter, { ...JAEGER_STANDARD, ...parameter });
	const geo = schiffGeometrie();
	const mat = new THREE.MeshStandardNodeMaterial({ color: 0x9aa0aa, metalness: 0.55, roughness: 0.5, side: THREE.DoubleSide });
	const glut = glutTextur();
	const N = Math.min(anzahl, FORMATION.length);
	const schiffe = [];
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
		schiffe.push({ mesh, g1, band, bg, pos, al, hist: [], versatz: FORMATION[i], akk: 0 });
	}
	let flug = null, endeNat = false;
	const v = new THREE.Vector3(), r = new THREE.Vector3(), q = new THREE.Quaternion(), z = new THREE.Vector3(0, 0, 1), s = new THREE.Vector3(), up = new THREE.Vector3(), tmp = new THREE.Vector3();

	return {
		parameter: P,
		get aktiv() { return !!flug; },
		/** Zustand für die Prüfung („Augen“): Lage, Länge und Zahl der sichtbaren Schiffe */
		get stand() {
			if (!flug) return null;
			return { sigma: flug.sigma, abstand: flug.D, laenge: flug.L, t: flug.t, schiffe: schiffe.filter((x) => x.mesh.visible).map((x) => ({ p: x.mesh.position.toArray(), px: x.px ?? 0 })) };
		},
		/** Flug starten. einheitKm: Kilometer je Szeneneinheit; seite: −1 links, 1 rechts */
		starte({ einheitKm = 0.6, seite = 1 } = {}) {
			const ke = 1 / einheitKm;                     // Szeneneinheiten je km
			const L = P.groesse * JAEGER_LAENGE_KM * ke, S = L * P.formation;       // Schiffslänge, Formationsmaß (Szeneneinheiten)
			const D = (P.abstandM / 1000) * ke;                                    // Abstand des NÄCHSTEN Schiffs der Staffel zur Kamera
			const u = new THREE.Vector3(-seite * 0.1, 0.04, 1).normalize();    // Flugrichtung: auf die Kamera zu, leicht von der Seite
			const n0 = new THREE.Vector3(seite, 0.3, 0);          // der Staffel-Vorbeiflug liegt oberhalb der Mitte (unten sitzt die Bedienleiste)
			const n = n0.clone().addScaledVector(u, -n0.dot(u)).normalize();   // quer zur Bahn: Richtung zum nächsten Punkt
			const rr = new THREE.Vector3(0, 1, 0).cross(u).normalize();
			const ausholen = Math.max(...FORMATION.slice(0, Math.max(1, Math.round(P.anzahl))).map((o) => Math.abs(o[0]))) * S * Math.abs(n.dot(rr));   // so weit holt die Staffel zur Kamera hin aus
			const Dm = D + ausholen;                                                 // Abstand der Mittellinie, damit das nächste Schiff genau `abstandM` hält
			flug = {
				u, C: n.multiplyScalar(Dm), D: Dm, sigma: P.startKm * ke, vmax: P.anflugKmS * ke, omega: P.winkelRate,
				t: 0, L, S, vorbei: 0, N: Math.max(1, Math.min(N, Math.round(P.anzahl))),
			};
			for (let i = 0; i < schiffe.length; i++) { const sch = schiffe[i]; sch.mesh.scale.setScalar(flug.L); sch.hist.length = 0; sch.akk = 0; sch.mesh.visible = sch.g1.visible = sch.band.visible = false; }
		},
		/**
		 * Eigenes Schiffsmodell einsetzen (z. B. die GLB der leichten Jäger aus Blender): wird auf Länge 1 normalisiert, die längste Achse zeigt nach +z (Nase),
		 * Mitte im Ursprung. Ohne Aufruf bleibt das einfache Low-Poly-Modell.
		 */
		setzeModell(objekt) {
			const kasten = new THREE.Box3().setFromObject(objekt), gr = kasten.getSize(new THREE.Vector3()), mitte = kasten.getCenter(new THREE.Vector3());
			const lang = Math.max(gr.x, gr.y, gr.z) || 1;
			for (const sch of schiffe) {
				const huelle = new THREE.Group(), kopie = objekt.clone(true);
				kopie.position.sub(mitte);
				const dreher = new THREE.Group(); dreher.add(kopie);
				if (gr.x === lang) dreher.rotation.y = Math.PI / 2; else if (gr.y === lang) dreher.rotation.x = Math.PI / 2;
				huelle.add(dreher); huelle.scale.setScalar(1 / lang);
				const aussen = new THREE.Group(); aussen.add(huelle);
				aussen.visible = false;
				gruppe.remove(sch.mesh); gruppe.add(aussen); sch.mesh = aussen;
			}
		},
		/** true, wenn der letzte Flug von selbst zu Ende ging (nicht abgebrochen) */
		get endeNatuerlich() { return endeNat; },
		stoppe(natuerlich = false) { endeNat = natuerlich; flug = null; for (const sch of schiffe) { sch.mesh.visible = sch.g1.visible = sch.band.visible = false; sch.hist.length = 0; } },
		/** dt: Sekunden; pxWelt: Weltgröße eines Pixels in 1 Einheit Abstand */
		update(dt, pxWelt) {
			if (!flug) return;
			flug.t += dt;
			const F = flug;
			// Tempo entlang der Bahn: feste Winkelrate nahe der Kamera, Reisegeschwindigkeit weit weg
			const vS = Math.min(F.vmax, F.omega * (F.sigma * F.sigma + F.D * F.D) / F.D);
			F.sigma -= vS * dt;
			if (F.sigma < -2.5 * F.D) F.vorbei += dt;     // hinter der Kamera: nichts mehr zu sehen, die Schweife klingen aus
			const spitze = tmp.copy(F.C).addScaledVector(F.u, -F.sigma);
			r.set(0, 1, 0).cross(F.u).normalize();                 // rechts (waagerecht quer zur Bahn)
			up.copy(F.u).cross(r).normalize();
			const schweifLaenge = SPUR_ALTER * P.schweif;
			for (let i = 0; i < schiffe.length; i++) {
				const sch = schiffe[i];
				const an = i < F.N && F.vorbei < 0.001;
				const o = sch.versatz;
				const p = spitze.clone().addScaledVector(r, o[0] * F.S).addScaledVector(up, o[1] * F.S).addScaledVector(F.u, o[2] * F.S);
				sch.mesh.position.copy(p);
				q.setFromUnitVectors(z, F.u);
				sch.mesh.quaternion.copy(q);
				sch.mesh.visible = i < F.N && p.z < 0;             // hinter der Kamera nicht zeichnen
				const abstand = p.length();
				sch.px = F.L / (abstand * pxWelt);                  // Länge des Schiffs in Pixeln
				// Glut: mindestens ~2 Pixel groß, damit auch das weit entfernte Schiff als Lichtpunkt sichtbar bleibt
				const tail = p.clone().addScaledVector(F.u, -F.L * 0.5);
				sch.g1.position.copy(tail);
				sch.g1.visible = sch.mesh.visible;
				const px = Math.max(2.2, F.L * 0.45 * P.glut / (abstand * pxWelt));
				sch.g1.scale.setScalar(px * pxWelt * abstand);
				// Schweif: ein Punkt je Takt, nicht je Bild (gleiche Länge bei jeder Bildrate)
				const h = sch.hist;
				sch.akk += dt;
				if (an && sch.akk >= SPUR_TAKT) { sch.akk = 0; h.push({ p: tail, t: F.t }); }
				while (h.length > TRAIL || (h.length && F.t - h[0].t > schweifLaenge)) h.shift();
				const n = h.length;
				sch.band.visible = n > 1 && i < F.N;
				if (n > 1) {
					for (let k = 0; k < n; k++) {
						const a = h[k], bP = h[Math.min(n - 1, k + 1)].p, aP = h[Math.max(0, k - 1)].p;
						v.copy(bP).sub(aP);
						if (v.lengthSq() < 1e-12) v.copy(F.u);
						r2.copy(a.p).negate();                                   // zur Kamera (Ursprung)
						s.copy(v).cross(r2).normalize();
						const alter = (F.t - a.t) / schweifLaenge;
						// Breite: am Schiff dünn, nach hinten breiter (Aufweitung), mindestens ~1,6 Pixel
						const dist = a.p.length();
						const breite = Math.max(F.L * (0.12 + 1.1 * alter), dist * pxWelt * 1.6) * 0.5;
						sch.pos.set([a.p.x + s.x * breite, a.p.y + s.y * breite, a.p.z + s.z * breite], 6 * k);
						sch.pos.set([a.p.x - s.x * breite, a.p.y - s.y * breite, a.p.z - s.z * breite], 6 * k + 3);
						const al = Math.pow(Math.max(0, 1 - alter), 1.8) * 0.4 * Math.min(1, P.schweif) * Math.min(1, (F.t - a.t) * 12 + 0.15);
						sch.al[2 * k] = sch.al[2 * k + 1] = al;
					}
					// Rest des Puffers entwerten (degenerierte Dreiecke am letzten Punkt)
					for (let k = n; k < TRAIL; k++) { sch.pos.copyWithin(6 * k, 6 * (n - 1), 6 * (n - 1) + 6); sch.al[2 * k] = sch.al[2 * k + 1] = 0; }
					sch.bg.attributes.position.needsUpdate = true; sch.bg.attributes.alpha.needsUpdate = true;
				}
			}
			if (F.vorbei > schweifLaenge + 0.5) this.stoppe(true);
		},
		dispose() { for (const sch of schiffe) { gruppe.remove(sch.mesh, sch.g1, sch.band); sch.bg.dispose(); sch.band.material.dispose(); sch.g1.material.dispose(); } geo.dispose(); mat.dispose(); glut.dispose(); },
	};
}
const r2 = new THREE.Vector3();
void sm;
