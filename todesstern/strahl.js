// Strahl der Station: drei leuchtende Zylinder (Kern, Mantel, Schein) plus Mündungsfleck, Kind des Strahlsockels der Station (`ts.sockel`).
// Dadurch zeigt der Strahl immer genau aus der Mündung, in Richtung der Modellachse – wie die Station auch gedreht ist. Nichts ist in Koordinaten eingetragen.
// Perspektive: Ein Zylinder von wenigen hundert Metern Dicke wäre in zehntausenden Kilometern Entfernung unter einem Pixel. Damit der Strahl bis zum Ziel sichtbar
// bleibt, wächst sein Radius mit dem Abstand zur Kamera auf eine Mindestbreite in Pixeln (die Helligkeit sinkt dabei im gleichen Maß: Energie bleibt erhalten).
import * as THREE from 'three/webgpu';
import { Fn, uniform, vec4, float, pow, abs, dot, normalize, length, max, cameraPosition, positionWorld, normalWorld, positionLocal, modelWorldMatrix } from 'three/tsl';

/** Einstellungen des Strahl-Editors (Werte 1 = Vorgabe) */
export const STRAHL_STANDARD = {
	farbton: 0.60,       // 0…1 (0,60 = Blau)
	helligkeit: 1,       // Faktor auf alle drei Hüllen
	dicke: 1,            // Faktor auf die Radien (0,14 / 0,3 / 0,6 Modelleinheiten)
	schein: 1,           // Faktor auf den äußeren Schein
	mindestPx: 1.6,      // Mindestbreite des Kerns in Pixeln
	flackern: 0.06,      // Schwankung der Helligkeit
	blendenfleck: 1,     // Größe des Mündungsflecks
	treffer: 1,          // Größe/Helligkeit des Glutflecks, wo der Strahl auftrifft
	profil: 2.0,         // Exponent des Blickwinkelprofils (höher = weicherer Rand)
};

const SCHICHTEN = [
	{ r: 0.14, s: 0.35, l: 0.92, stark: 14, lad: 6, px: 1.0 },
	{ r: 0.30, s: 1.00, l: 0.625, stark: 3.5, lad: 0.8, px: 2.2 },
	{ r: 0.60, s: 0.95, l: 0.54, stark: 0.18, lad: 0, px: 5.0 },
];

function fleckTextur() {
	const c = document.createElement('canvas'); c.width = c.height = 256;
	const g = c.getContext('2d');
	const rad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
	rad.addColorStop(0, 'rgba(255,255,255,1)'); rad.addColorStop(0.08, 'rgba(210,235,255,0.95)'); rad.addColorStop(0.3, 'rgba(90,160,255,0.35)'); rad.addColorStop(1, 'rgba(0,0,0,0)');
	g.fillStyle = rad; g.fillRect(0, 0, 256, 256);
	// waagerechter Streifen (anamorphotisches Objektiv)
	const str = g.createLinearGradient(0, 0, 256, 0);
	str.addColorStop(0, 'rgba(120,180,255,0)'); str.addColorStop(0.5, 'rgba(200,225,255,0.9)'); str.addColorStop(1, 'rgba(120,180,255,0)');
	g.fillStyle = str; g.fillRect(0, 124, 256, 8);
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.premultiplyAlpha = true;
	return t;
}

export function erzeugeStrahl(sockel, params = {}) {
	const P = { ...STRAHL_STANDARD, ...params };
	const uPx = uniform(0.001), uMin = uniform(1.6);
	const schichten = SCHICHTEN.map((S) => {
		const uR = uniform(S.r), uF = uniform(new THREE.Color()), uSt = uniform(0), uProf = uniform(2.0);
		const geo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2);   // Einheitsradius, z von 0 bis 1
		const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
		// Mindestbreite: Radius (Welt) = max(r, Abstand · Pixelgröße · Mindestpixel/2 · Faktor dieser Schicht)
		const rMin = Fn(() => {
			const achse = modelWorldMatrix.mul(vec4(0, 0, positionLocal.z, 1)).xyz;
			const d = length(achse.sub(cameraPosition));
			return d.mul(uPx).mul(uMin).mul(0.5 * S.px);
		});
		m.positionNode = Fn(() => {
			const k = max(float(1), rMin().div(uR));
			return positionLocal.mul(vec4(k, k, 1, 1).xyz);
		})();
		m.colorNode = Fn(() => {
			const v = normalize(cameraPosition.sub(positionWorld));
			const zu = abs(dot(normalWorld, v));
			const k = max(float(1), rMin().div(uR));
			return vec4(uF.mul(pow(zu, uProf)).mul(uSt).div(k), 1);
		})();
		const mesh = new THREE.Mesh(geo, m);
		mesh.renderOrder = 11; mesh.frustumCulled = false; mesh.visible = false;
		sockel.add(mesh);
		return { S, uR, uF, uSt, uProf, mesh };
	});

	// Mündungsfleck (kamera-zugewandt, additiv)
	const fleck = new THREE.Sprite(new THREE.SpriteNodeMaterial({ map: fleckTextur(), transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
	fleck.renderOrder = 12; fleck.visible = false;
	sockel.add(fleck);

	// Auftreffpunkt: weißglühender Fleck am Ende des Strahls (Größe in Pixeln, unabhängig vom Abstand)
	const ende = new THREE.Sprite(new THREE.SpriteNodeMaterial({ map: fleck.material.map, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, color: 0xffb070 }));
	ende.renderOrder = 12; ende.visible = false;
	sockel.add(ende);
	const farbe = new THREE.Color();
	const v3 = new THREE.Vector3();
	return {
		params: P,
		/** s: Strahlstärke 0…1, l: Ladung 0…1 (Kurven der Schussanimation), laenge: Länge in Modelleinheiten, pxWelt: Weltgröße eines Pixels in 1 Einheit Abstand, zeit: Sekunden */
		update({ s, l, laenge, pxWelt, zeit, kamera }) {
			uPx.value = pxWelt; uMin.value = P.mindestPx;
			const flimmer = 1 + P.flackern * (Math.sin(zeit * 47.1) * Math.sin(zeit * 13.7 + 1.3));
			const an = s > 0.001;
			schichten.forEach((h, k) => {
				const S = h.S;
				h.mesh.visible = an;
				const dicke = P.dicke * (k === 2 ? P.schein : 1);
				h.uR.value = S.r * dicke;
				h.mesh.scale.set(S.r * dicke, S.r * dicke, laenge);
				h.uProf.value = P.profil;
				farbe.setHSL(P.farbton, S.s, S.l);
				h.uF.value.copy(farbe);
				h.uSt.value = (S.stark * s + S.lad * l * l) * P.helligkeit * flimmer;
			});
			// Fleck: wächst mit Ladung und Schuss; Größe auf dem Bild unabhängig vom Abstand (Pixel)
			const b = (0.55 * l + 1.0 * s) * P.blendenfleck;
			fleck.visible = b > 0.01;
			if (fleck.visible) {
				fleck.position.set(0, 0, 0.4);
				const d = fleck.getWorldPosition(v3).distanceTo(kamera.position);
				const px = 60 + 200 * b;   // Durchmesser in Pixeln
				fleck.scale.setScalar(px * pxWelt * d);
				fleck.material.color.setScalar(Math.min(1, 0.25 + b));
			}
			// Glutfleck am Ziel
			const bt = s * P.treffer * (1 + 0.25 * Math.sin(zeit * 31) * Math.sin(zeit * 9.3));
			ende.visible = bt > 0.02 && laenge > 1;
			if (ende.visible) {
				ende.position.set(0, 0, laenge);
				const d = ende.getWorldPosition(v3).distanceTo(kamera.position);
				ende.scale.setScalar((26 + 60 * Math.min(1, bt)) * pxWelt * d);
				ende.material.color.setRGB(1.0 * Math.min(1.5, bt), 0.62 * Math.min(1.5, bt), 0.32 * Math.min(1.5, bt));
			}
		},
		dispose() { schichten.forEach((h) => { h.mesh.geometry.dispose(); h.mesh.material.dispose(); sockel.remove(h.mesh); }); sockel.remove(fleck, ende); ende.material.dispose(); fleck.material.map.dispose(); fleck.material.dispose(); },
	};
}
