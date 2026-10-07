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
import { erzeugeJaeger, JAEGER_STANDARD } from './jaeger.js';

let HUELLE = 6.65;                       // Radius der Hülle der Station in Modelleinheiten (aus dem Modell gemessen)
export { STRAHL_STANDARD, JAEGER_STANDARD };

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

export async function erstelleEbene({ basis, container, stufe = 'niedrig', dpr = 1, msaa = 1, strahlParameter = {}, jaegerParameter = {} }) {
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
	const kamera = new THREE.PerspectiveCamera(30, 1.6, 0.03, 8e5);   // nah genug, dass Jäger im Abstand von Metern nicht abgeschnitten werden (1 Einheit = 0,6 km)
	const W = new THREE.Group(); W.matrixAutoUpdate = false; scene.add(W);
	const lichtFolgt = szeneEinrichten(scene, kamera, { basis, stufe, renderer, ohneHimmel: true });
	const keys = scene.children.filter((o) => o.isDirectionalLight);
	const lutTex = await ladeLut(basis);

	let ts = null, strahl = null, austritt = null, pipeline = null, szenePass = null, aktStufe = stufe;
	const jaeger = erzeugeJaeger(W, { anzahl: 7, parameter: jaegerParameter });
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
	let waermt = false;
	/** Alles sichtbar machen, den Pass asynchron übersetzen, einmal echt zeichnen (Texturen, Bindungen, Nachbearbeitung), dann alles zurücksetzen */
	async function waermen(neuPass) {
		waermt = true;
		const alt = new Map();
		const sichtbarkeit = cv.style.visibility;
		cv.style.visibility = 'hidden';
		try {
			scene.traverse((o) => { if (o.isLight || o === scene) return; alt.set(o, [o.visible, o.frustumCulled]); o.visible = true; o.frustumCulled = false; });
			scene.updateMatrixWorld(true);
			pipeline.render();                                   // erst einmal echt zeichnen: legt Zielgrößen und Nachbearbeitung an, bevor übersetzt wird
			try { await neuPass.compileAsync(renderer); } catch (e) { console.warn('Vorübersetzen:', e); }
			pipeline.render();
			await renderer.backend?.device?.queue?.onSubmittedWorkDone?.();
		} catch (e) { console.warn('Vorwärmen:', e); }
		finally {
			for (const [o, [vis, fc]] of alt) { o.visible = vis; o.frustumCulled = fc; }
			cv.style.visibility = sichtbarkeit;
			waermt = false;
		}
	}
	/** Modell einsetzen: Szene, Strahl, Nachbearbeitung (Glanz und Farbtabelle der Stufe) */
	async function setzeEin(neu, neueStufe) {
		S = STUFEN[neueStufe] ?? STUFEN.niedrig;
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
		if (!pipeline) pipeline = new THREE.RenderPipeline(renderer);
		pipeline.outputColorTransform = false;
		pipeline.outputNode = vec4(c.rgb, al);
		pipeline.needsUpdate = true;
		// Vorwärmen: JEDES Teil (Station, Strahl, Austritt, Jäger, Schweife) einmal im echten Zeichenweg zeichnen, solange es noch niemand sieht.
		// Three.js übersetzt Shader und lädt Texturen erst beim ersten Zeichnen eines sichtbaren Objekts – ohne das hakte die Seite beim Start,
		// bei der Ankunft der Station und beim ersten Schuss (gemessen: 100–600 ms, auch auf der RTX 5080).
		await waermen(neuPass);
		neu.gruppe.visible = true; neu.gruppe.scale.setScalar(1e-6);   // bleibt „sichtbar“ (siehe `zeichne`)
		aktStufe = neueStufe;
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

	let probe = false;
	/**
	 * Probelauf: die Szene einmal unsichtbar durchspielen (nur Jäger → Ankunft → Schuss) – über denselben Weg wie später, mit denselben Lichtern und Zuständen.
	 * Three.js übersetzt Shader beim ersten Zeichnen jeder Kombination aus Objekt, Material und Lichtern; so sind alle Kombinationen übersetzt, bevor jemand „Start“ drückt
	 * (sonst hängt die Seite bei der Ankunft der Station und beim Schuss kurz, auf Handys deutlich).
	 */
	async function probelauf() {
		probe = true;
		try {
			const frame = () => new Promise((r) => setTimeout(r, 0));
			const b = { vor: [0, 0, -1], rechts: [1, 0, 0], oben: [0, 1, 0], fov: 0.75, sonne: [0.5, 0.3, 0.8], halte: false, tauschOk: false };
			const st = (t, strahl = 0, sichtbar = true) => ({ sichtbar, p: [0, 0, -0.012], R: 0.004, ziel: [1, 0, 0], austritt: t, strahlLaenge: strahl });
			jaeger.starte({ einheitKm: 0.6, seite: 1 });
			for (let i = 0; i < 8; i++) { api.zeichne({ ...b, zeit: 0, dt: 0.05, station: st(-1, 0, false) }); await frame(); }          // nur Jäger und Schweife
			for (let i = 0; i < 4; i++) { api.zeichne({ ...b, zeit: 0, dt: 0.016, station: st(0.03 * i) }); await frame(); }              // Ankunft aus dem Hyperraum
			ts.feuer(0);
			for (const fs of [60, 120, 220, 260]) { api.zeichne({ ...b, zeit: fs / 30 / schnell, dt: 0.016, station: st(2, 50) }); await frame(); }   // Aufladung und Strahl
			api.zeichne({ ...b, zeit: 600 / 30 / schnell, dt: 0.016, station: st(2, 50) });                                              // Schuss zu Ende: zurücksetzen
		} catch (e) { console.warn('Probelauf:', e); }
		finally { jaeger.stoppe(); austritt?.update(-1, pos); probe = false; }
	}

	const api = {
		get bereit() { return !!ts && !!pipeline && !probe; },
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
		jaegerStopp() { jaeger.stoppe(); },
		/** Einstellungen der Staffel (live änderbar) und ihr Zustand für die Prüfung */
		jaegerParameter: jaeger.parameter,
		get jaegerStand() { return jaeger.stand; },
		get jaegerEndeNatuerlich() { return jaeger.endeNatuerlich; },
		jaegerAktiv() { return jaeger.aktiv; },
		/** Schuss der Station auslösen (Klappen, Aufladung, Strahl) – zeit in Sekunden der Bildschleife */
		feuer(zeit) { if (ts) ts.feuer(zeit * schnell); },
		/**
		 * z: { zeit, dt, vor, rechts, oben (Einheitsvektoren, Welt), fov (rad), sonne (Einheitsvektor zur Sonne),
		 *      station: { sichtbar, p (Mitte relativ zur Kamera, Welt), R (Radius in Welt), ziel (Einheitsvektor der Achse), austritt (Sekunden seit Erscheinen, < 0 = noch nicht), strahlLaenge (Welt) },
		 *      halte }
		 */
		zeichne(z) {
			if (!ts || !pipeline || waermt) return;
			// ein fertig geladenes Modell einsetzen, wenn die Station nicht schießt und der Aufrufer es erlaubt (nie mitten in der Szene)
			if (wartend && !ts.schiesst && !probe && z.tauschOk !== false) {
				// Tausch: in diesem Bild wird nichts mehr gezeichnet (sonst läuft ein Bild mit der halb getauschten Nachbearbeitung), danach Probelauf
				const w = wartend; wartend = null; waermt = true;
				setzeEin(w.m, w.stufe).then(() => probelauf()).catch((e) => console.error('Station tauschen:', e)).finally(() => { waermt = false; });
				return;
			}
			groesse();
			const st = z.station;
			const t = st?.austritt ?? -1;
			const zeigeStation = !!st?.sichtbar && t >= 0;
			const zeigeJaeger = jaeger.aktiv;
			cv.style.visibility = (zeigeStation || zeigeJaeger) && !probe ? 'visible' : 'hidden';
			if (!zeigeStation && !zeigeJaeger) { austritt?.update(-1, pos); return; }

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
			// Die Gruppe bleibt immer „sichtbar“ (nur winzig, wenn die Station nicht da ist): Ihre Lichter gehören zur Lichtermenge der Szene, und jede Änderung dieser
			// Menge lässt Three.js alle Materialien neu übersetzen (gemessen: 60 ms Hänger bei der Ankunft der Station).
			ts.gruppe.visible = true;
			ts.gruppe.scale.copy(skal.setScalar(zeigeStation && ersch.sichtbar ? ersch.skala : 1e-6));
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
	// Eigene Jäger-Modelle (GLB aus Blender), falls neben der Station abgelegt: jaeger_<stufe>.glb oder jaeger.glb; sonst bleibt das einfache Low-Poly-Schiff
	try {
		for (const name of [`jaeger_${stufe}.glb`, 'jaeger.glb']) {
			const url = basis + name;
			if (!(await fetch(url, { method: 'HEAD' })).ok) continue;
			const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
			const gltf = await new GLTFLoader().loadAsync(url);
			jaeger.setzeModell(gltf.scene); additivOhneAlpha(scene);
			break;
		}
	} catch (e) { console.warn('Jäger-Modell:', e); }
	await probelauf();
	return api;
}
