# FeralMotion — stabilisation vidéo dans le navigateur

Prototype web (mobile-first) de stabilisation vidéo par suivi de **1 ou 2 points**.
Import → placement des points (zoom/pinch) → analyse (tracking visible) → aperçu
stabilisé + trim → export MP4 haute qualité. Fonctionne au clavier/souris (desktop)
et au touch (iPhone / Android).

## Lancer

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # build de prod
```

## Comment ça marche

| Étape | Fichier | Détail |
|-------|---------|--------|
| Chargement vidéo + fps | `src/engine/videoFrames.ts` | sonde dimensions/durée, estime le fps via `requestVideoFrameCallback` |
| Suivi des points | `src/engine/tracker.ts` | **OpenCV.js** optical flow Lucas-Kanade pyramidal + contrôle forward-backward |
| Passe d'analyse | `src/engine/analysis.ts` | seek frame par frame, suit les points, lissage temporel léger |
| Maths de stabilisation | `src/engine/stabilizer.ts` | 1 point → translation · 2 points → similarité (translation + rotation + échelle) |
| Rendu | `src/engine/renderer.ts` | applique la transform au canvas + dessine l'effet de tracking |
| Export | `src/engine/exporter.ts` | **WebCodecs** H.264 + audio AAC (mp4-muxer), fallback **MediaRecorder** |
| UI | `src/App.tsx`, `src/ui/*` | machine à états, viewer zoom/pan (Pointer Events), timeline de trim tactile |

### Le suivi
- **1 point** : seule la translation est annulée — le point reste fixe, l'orientation
  de la caméra est conservée.
- **2 points** : transformation de similarité — les **deux** points restent fixes
  (la rotation et le léger zoom de la caméra sont compensés).

Le curseur « Recadrage » en mode édition agrandit légèrement l'image pour masquer
les bords qui apparaissent quand la frame est repositionnée.

### Export « sans perte »
Le vrai lossless est impossible en réencodage navigateur. On vise donc une qualité
quasi-source : WebCodecs encode en H.264 à très haut débit (≈0,2 bit/pixel, plafonné
à 50 Mb/s), résolution source préservée, audio réinjecté depuis le fichier d'origine.
Si WebCodecs est indisponible, repli automatique sur MediaRecorder.

## OpenCV.js
Servi **localement** depuis `public/opencv.js` (build UMD auto-contenu, wasm en
base64, ~10 Mo — source : npm `@techstark/opencv-js`). Aucune dépendance CDN au
runtime. Il est chargé paresseusement à la première analyse (loader avec barre de
progression dans `src/engine/opencv.ts`).

## Limites connues du prototype
- OpenCV.js (~10 Mo) est chargé à la première analyse — un court délai la 1re fois.
- L'analyse et l'export avancent par `seek` : précis et indépendant du format, mais
  ~10–30 s pour un clip de quelques secondes.
- Le décodage HEVC dépend du support matériel/navigateur ; H.264 est le plus sûr.
- Pas (encore) de re-tracking automatique après occlusion longue d'un point.

## Licence

© 2026 Tom Pascard — https://github.com/pascard/FeralMotion

FeralMotion est distribué sous la **PolyForm Noncommercial License 1.0.0**
(voir [LICENSE](./LICENSE)).

- ✅ **Usage non-commercial autorisé** (perso, étude, recherche, éducation, assos…),
  y compris modification et redistribution.
- ✅ **Crédit obligatoire** : tu dois conserver l'avis de copyright et la mention
  `Required Notice` qui pointe vers ce dépôt GitHub.
- ❌ **Usage commercial interdit** sans licence séparée — contacte l'auteur.

Les composants tiers (React, mp4-muxer, mp4box.js, OpenCV) restent sous leurs
propres licences permissives ; voir [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
