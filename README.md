# Todesstern-Simulator – WebGPU-Tech-Demo

Ein Todesstern über einem Gasriesen oder Gesteinsplaneten, berechnet statt gemalt: Bahnebene, Maßstab und fester Strahl folgen der Physik. Der Planet, sein Mond und die Station laufen in einer gemeinsamen 3D-Szene im Browser.

## ▶ Jetzt starten (ohne Installation)

**[Todesstern-Simulator starten](https://loveascent.github.io/todesstern-demo/index.html?body=todesstern)**

Dort unten in der Leiste auf **Start** klicken.

| Schalter | Wirkung |
|---|---|
| Start / Neu | Szene beginnt bzw. beginnt von vorn |
| Planet, Würfeln | Gasriese (Jupiter, weitere Typen) oder Gesteinsplanet; Würfeln erzeugt einen neuen Planeten |
| Planet-Qualität, Station-Qualität | Auto oder feste Stufe, getrennt einstellbar (Handy bis High-End-PC) |
| Mondbahn | Umlaufbahn des Mondes ein/aus |
| Strahl, Jäger | Editoren für den Strahl und die Jägerstaffel |

Weitere Ansichten aus demselben Projekt: [Sonnensystem](https://loveascent.github.io/procedural-planets/index.html?body=welt) · [Gasriese](https://loveascent.github.io/procedural-planets/index.html) · [Gesteinsplanet](https://loveascent.github.io/procedural-planets/index.html?body=rocky) · [Mond](https://loveascent.github.io/procedural-planets/index.html?body=moon)

## Voraussetzung

Ein Browser mit WebGPU: Chrome/Edge 113+, Safari 26+, Firefox 141+, Android Chrome 121+. Auf Rechnern mit zwei Grafikchips Chrome der starken Grafikkarte zuweisen (Windows: Einstellungen › Grafik), sonst läuft es auf der schwachen und ruckelt.

## Inhalt dieses Repos

- `index.html` – gebaute Einzelseite (Quelle: [procedural-planets](https://github.com/loveascent/procedural-planets))
- `todesstern/` – Modell des Todessterns (GLB in drei Stufen), Strahl, Jäger, three.js

## Herkunft und Lizenzen

Gebaut mit three.js (MIT, Lizenz in `todesstern/three/LICENSE`). Das Todesstern-Modell wird zur Laufzeit geladen (GLB, meshopt + KTX2). Die Planeten stammen aus dem Projekt [procedural-planets](https://github.com/loveascent/procedural-planets) (Apache-2.0).

---

# Death Star simulator – WebGPU tech demo

A Death Star above a gas giant or rocky planet, computed rather than painted: orbital plane, scale and a fixed beam follow physics. Planet, moon and station run in one shared 3D scene in the browser.

**▶ [Start the simulator](https://loveascent.github.io/todesstern-demo/index.html?body=todesstern)** – then press **Start** in the bar at the bottom. Needs a WebGPU browser (Chrome/Edge 113+, Safari 26+, Firefox 141+). On dual-GPU machines, run Chrome on the fast GPU. Planets come from [procedural-planets](https://github.com/loveascent/procedural-planets) (Apache-2.0), rendered with three.js (MIT).
