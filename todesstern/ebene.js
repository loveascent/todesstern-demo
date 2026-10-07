// Station, Strahl, Austritt aus dem Hyperraum und Jäger als eigene 3D-Ebene über der Welt: ein eigener WebGPU-Zeichner (three.js) auf durchsichtiger Leinwand,
// der mit EXAKT der Kamera der Welt (Standort, Blickrichtung, Bildwinkel) rechnet. Dadurch liegen Station und Welt im selben Raum; die Perspektive stimmt
// und der Schwenk der Kamera bewegt alles gleich mit.
//
// Aufbau (ein Block „Todesstern“, unabhängig von der Welt): todesstern.js (Modell, Klappen, Aufladung, Blitze) · strahl.js (dockt am Sockel der Station an) ·
// austritt.js (Hyperraum) · jaeger.js (Maßstab). Die Welt gibt nur Lage, Achse und Kamera vor.
//
// Raumaufbau: Die Station steht (wie im Blender-Abgleich ihrer Beleuchtung und Schatten) fest im Ursprung. Alles andere (Jäger, Effekte, Kamera) liegt in einer
// Gruppe W mit der Matrix (Pose der Station)⁻¹ und wird in Koordinaten der Welt angegeben (Kamera im Ursprung, Einheit = Modelleinheit der Station).
//
// Laden ohne Ruckeln: erst das kleine Modell (niedrig, ~3 MB) – die Ebene ist sofort einsatzbereit –, die gewünschte Stufe lädt danach im Hintergrund
// (`hochstufen`) und wird getauscht, sobald die Station nicht schießt.
import * as THREE from 'three/webgpu';
import { pass, texture3D, log2, max, clamp, vec4, float } from 'three/tsl';
import { lut3D } from 'three/addons/tsl/display/Lut3DNode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ladeTodesstern, szeneEinrichten, ladeLut, LUT, STUFEN, ABGLEICH } from './todesstern.js';
import { erzeugeStrahl, STRAHL_STANDARD } from './strahl.js';
import { erzeugeAustritt } from './austritt.js';
import { erzeugeJaeger } from './jaeger.js';

let HUELLE = 6.65;                       // Radius der Hülle der Station in Modelleinheiten (aus dem Modell gemessen)
export { STRAHL_STANDARD };

const Y = new THREE.Vector3(0, 1, 0), Zax = new THREE.Vector3(0, 0, 1);

/**
 * Leuchtende (additive) Materialien dürfen nur die Farbe, nie die Deckung verändern: Die Ebene liegt durchsichtig über der Welt, Licht auf Schwarz muss
 * durchscheinen. Statt „Quelle · Alpha + Ziel“ wird „Quelle + Ziel“ mit unverändertem Alpha gerechnet (Alpha leitet das Bild später aus der Helligkeit ab).
 */
function additivOhneAlpha(wurzel) {
	wurzel.traverse((o) => {
		for (const m of [].concat(o.material || [])) {
			if (m.blending !== THREE.AdditiveBlending) continue;
			m.blending = THREE.CustomBlending; m.blendEquation = THREE.AddEquation;
			m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor; m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
			m.needsUpdate = true;
		}
	});
}

/** Drehung, die +z auf `d` legt; das Modell-„oben“ zeigt so weit wie möglich nach Welt-oben (kein Rollen). */
function ausrichtung(d, q) {
	const q1 = new THREE.Quaternion().setFromUnitVectors(Zax, d);
	const u1 = Y.clone().applyQuaternion(q1);
	const U = Y.clone().addScaledVector(d, -d.y);
	if (U.lengthSq() < 1e-8) return q.copy(q1);
	U.normalize();
	const ang = Math.atan2(new THREE.Vector3().crossVectors(u1, U).dot(d), u1.dot(U));
	return q.setFromAxisAngle(d, ang).multiply(q1);
}

export async function erstelleEbene({ basis, container, stufe = 'niedrig', dpr = 1, msaa = 1, strahlParameter = {} }) {
	let S = STUFEN[stufe] ?? STUFEN.niedrig;
	const renderer = new THREE.WebGPURenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' });
	await renderer.init();
	renderer.setClearColor(0x000000, 0);
	renderer.toneMapping = THREE.NoToneMapping;          // Tonwert über die Blender-LUT
	const cv = renderer.domElement;
	cv.id = 'ebene';
	cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;visibility:hidden';
	container.appendChild(cv);

	const scene = new THREE.Scene();
	const kamera = new THREE.PerspectiveCamera(30, 1.6, 0.2, 8e5);
	const W = new THREE.Group(); W.matrixAutoUpdate = false; scene.add(W);
	const lichtFolgt = szeneEinrichten(scene, kamera, { basis, stufe, renderer, ohneHimmel: true });
	const keys = scene.children.filter((o) => o.isDirectionalLight);
	const lutTex = await ladeLut(basis);

	let ts = null, strahl = null, austritt = null, pipeline = null, szenePass = null, aktStufe = stufe;
	const jaeger = erzeugeJaeger(W, { anzahl: 7 });
	const strahlParams = { ...STRAHL_STANDARD, ...strahlParameter };

	let breite = 0, hoehe = 0;
	const groesse = () => {
		const r = container.getBoundingClientRect();
		const w = Math.max(2, Math.round(r.width)), h = Math.max(2, Math.round(r.height));
		if (w !== breite || h !== hoehe) { breite = w; hoehe = h; renderer.setSize(w, h, false); }
	};

	/** Modell laden, noch nicht eingesetzt */
	async function ladeModell(neueStufe) {
		const neu = await ladeTodesstern(renderer, { stufe: neueStufe, basis, strahlExtern: true });
		neu.gruppe.visible = false;
		return neu;
	}
	/** Modell einsetzen: Szene, Strahl, Nachbearbeitung (Glanz und Farbtabelle der Stufe) */
	async function setzeEin(neu, neueStufe) {
		S = STUFEN[neueStufe] ?? STUFEN.niedrig; aktStufe = neueStufe;
		const alt = ts, altStrahl = strahl;
		scene.add(neu.gruppe);
		neu.gruppe.updateMatrixWorld(true);
		HUELLE = new THREE.Box3().setFromObject(neu.gruppe).getBoundingSphere(new THREE.Sphere()).radius;
		const neuerStrahl = erzeugeStrahl(neu.sockel, strahlParams);
		if (!austritt) austritt = erzeugeAustritt(W, HUELLE);
		additivOhneAlpha(scene);
		// Nachbearbeitung wie in Blender: Glanz + AgX-Farbtabelle; Alpha aus Deckung bzw. Helligkeit (Licht auf Schwarz ist durchscheinend)
		const neuPass = pass(scene, kamera, msaa > 1 ? { samples: msaa } : {});
		neuPass.setResolutionScale(S.szene);
		const farbe = neuPass.getTextureNode('output');
		const glanz = S.bloom ? bloom(farbe.min(6), ABGLEICH.bloomStaerke, ABGLEICH.bloomRadius, 1.6) : null;
		const hdr = glanz ? farbe.add(glanz) : farbe;
		const logv = clamp(log2(max(hdr.rgb, 1e-10).div(0.18)).sub(LUT.min).div(LUT.max - LUT.min), 0, 1);
		const c = lut3D(vec4(logv, 1), texture3D(lutTex), LUT.n, float(1));
		const al = clamp(max(farbe.a, max(c.r, max(c.g, c.b))), 0, 1);
		groesse();
		kamera.aspect = breite / hoehe; kamera.updateProjectionMatrix();
		neu.gruppe.visible = true;
		await renderer.compileAsync(scene, kamera);       // Shader übersetzen, solange das neue Modell noch unsichtbar im Ursprung steht (kein Ruckeln im Lauf)
		neu.gruppe.visible = false;
		if (!pipeline) pipeline = new THREE.RenderPipeline(renderer);
		pipeline.outputColorTransform = false;
		pipeline.outputNode = vec4(c.rgb, al);
		pipeline.needsUpdate = true;
		szenePass = neuPass;
		ts = neu; strahl = neuerStrahl;
		if (alt) { scene.remove(alt.gruppe); altStrahl?.dispose(); alt.dispose?.(); }
	}
	renderer.setPixelRatio(dpr);
	groesse();
	await setzeEin(await ladeModell(stufe), stufe);

	const pose = new THREE.Matrix4(), poseInv = new THREE.Matrix4(), camM = new THREE.Matrix4(), camS = new THREE.Matrix4();
	const q = new THREE.Quaternion(), qInv = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
	const pos = new THREE.Vector3(), aim = new THREE.Vector3(), sonne = new THREE.Vector3(), rechts = new THREE.Vector3(), oben = new THREE.Vector3(), vor = new THREE.Vector3(), skal = new THREE.Vector3();
	let schnell = 1.25;
	let wartend = null, ladeLaeuft = false;    // Hochstufen im Hintergrund: fertig geladenes Modell wartet auf einen ruhigen Moment

	return {
		get bereit() { return !!ts && !!pipeline; },
		get stufe() { return aktStufe; },
		parameter: strahlParams,
		get schussBild() { return ts && ts.schiesst ? (ts.zustand.fs ?? 1) : -1; },
		get canvas() { return cv; },
		/** Radius der Hülle der Station in Modelleinheiten (aus dem Modell gemessen) */
		get huelleR() { return HUELLE; },
		/** Abstand der Mündung (Iris) vom Mittelpunkt entlang der Achse in Modelleinheiten, am Modell gemessen */
		get sockelZ() { return ts ? ts.sockel.position.z : 4.45; },
		setzeSchnell(f) { schnell = f; },
		/** Qualitätsstufe: Pixeldichte sofort, Modell im Hintergrund laden und beim nächsten ruhigen Moment tauschen */
		async hochstufen(neueStufe, neueDpr, neuMsaa) {
			if (neueDpr) { dpr = neueDpr; renderer.setPixelRatio(dpr); breite = 0; }
			if (neuMsaa) msaa = neuMsaa;
			if (neueStufe === aktStufe || ladeLaeuft) return;
			ladeLaeuft = true;
			try { const m = await ladeModell(neueStufe); wartend = { m, stufe: neueStufe }; } finally { ladeLaeuft = false; }
		},
		jaegerStart(opt) { jaeger.starte(opt); },
		jaegerAktiv() { return jaeger.aktiv; },
		/** Schuss der Station auslösen (Klappen, Aufladung, Strahl) – zeit in Sekunden der Bildschleife */
		feuer(zeit) { if (ts) ts.feuer(zeit * schnell); },
		/**
		 * z: { zeit, dt, vor, rechts, oben (Einheitsvektoren, Welt), fov (rad), sonne (Einheitsvektor zur Sonne),
		 *      station: { sichtbar, p (Mitte relativ zur Kamera, Welt), R (Radius in Welt), ziel (Einheitsvektor der Achse), austritt (Sekunden seit Erscheinen, < 0 = noch nicht), strahlLaenge (Welt) },
		 *      halte }
		 */
		zeichne(z) {
			if (!ts || !pipeline) return;
			// ein fertig geladenes Modell einsetzen, wenn die Station nicht schießt
			if (wartend && !ts.schiesst) { const w = wartend; wartend = null; setzeEin(w.m, w.stufe).catch((e) => console.error('Station tauschen:', e)); }
			groesse();
			const st = z.station;
			const t = st?.austritt ?? -1;
			const zeigeStation = !!st?.sichtbar && t >= 0;
			const zeigeJaeger = jaeger.aktiv;
			cv.style.visibility = zeigeStation || zeigeJaeger ? 'visible' : 'hidden';
			if (!zeigeStation && !zeigeJaeger) { ts.gruppe.visible = false; austritt?.update(-1, pos); return; }

			const s = (st?.R ?? 0.004) / HUELLE;                          // Welt-Einheiten je Modelleinheit
			pos.set(st.p[0], st.p[1], st.p[2]).divideScalar(s);
			aim.set(st.ziel[0], st.ziel[1], st.ziel[2]).normalize();
			ausrichtung(aim, q);
			pose.compose(pos, q, one);
			poseInv.copy(pose).invert();
			W.matrix.copy(poseInv); W.matrixWorldNeedsUpdate = true;
			// Kamera der Welt, in das Koordinatensystem der Station umgerechnet
			rechts.set(z.rechts[0], z.rechts[1], z.rechts[2]); oben.set(z.oben[0], z.oben[1], z.oben[2]); vor.set(z.vor[0], z.vor[1], z.vor[2]);
			camM.makeBasis(rechts, oben, vor.clone().negate());
			camS.multiplyMatrices(poseInv, camM);
			camS.decompose(kamera.position, kamera.quaternion, kamera.scale);
			kamera.fov = THREE.MathUtils.radToDeg(z.fov); kamera.aspect = breite / hoehe; kamera.updateProjectionMatrix();
			kamera.updateMatrixWorld(true);
			// Licht: Schlüssellicht = Sonne der Welt (in Stationsachsen), Füllicht folgt wie in der Blender-Szene der Kamera
			lichtFolgt(true);
			qInv.copy(q).invert();
			sonne.set(z.sonne[0], z.sonne[1], z.sonne[2]).applyQuaternion(qInv);
			if (keys[0]) keys[0].position.copy(sonne).multiplyScalar(20);

			const hohePx = hoehe * renderer.getPixelRatio();
			const pxWelt = 2 * Math.tan(z.fov / 2) / hohePx;
			const ersch = austritt ? austritt.erscheinen(t) : { sichtbar: true, skala: 1 };
			ts.gruppe.visible = zeigeStation && ersch.sichtbar;
			ts.gruppe.scale.copy(skal.setScalar(ersch.skala));
			ts.zustand.halte = !!z.halte;
			if (zeigeStation) {
				ts.update(z.zeit * schnell, kamera, hohePx);
				const sStr = ts.zustand.strahl, lad = ts.zustand.ladung;
				const laenge = Math.max(0.0005, Math.min(1, sStr * 1.4)) * (st.strahlLaenge / s);
				strahl.update({ s: sStr, l: lad, laenge, pxWelt, zeit: z.zeit, kamera });
				austritt.update(t, pos);
			}
			jaeger.update(z.dt, pxWelt);
			pipeline.render();
		},
		dispose() { jaeger.dispose(); austritt?.dispose(); strahl?.dispose(); ts?.dispose?.(); renderer.dispose(); cv.remove(); },
	};
}
