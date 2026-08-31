# SPEC-BG-Zen — Wallpaper Engine pour Zen Browser

> 🦂 **v0.1.0 livrée (mod Sine `Impre-dev/BG-Zen`)** — Roadmap v2 active.
> Mode de travail : **un point à la fois, validé avant de passer au suivant**.

## Vision

Donner à Zen un système de fonds d'écran complet : wallpaper derrière toute l'UI,
splashscreens de chargement, wallpapers aléatoires et par site, glass sur les
éléments flottants (sidebar, urlbar).

À terme : **un pool de fonds permanents**, **un pool de loading screens**, et des
**options spécifiques par site**.

## 🧭 Roadmap v2 (31/08) — ordre de traitement 1 → 5 → 3 → 2 → 4

### 1. Séparation des fonds + fin du blur d'après-chargement ✅ livré v0.2.0
- **Deux pools distincts** : `backgrounds/` (fonds permanents, repos) et
  `loadings/` (loading screens, affichés derrière le wrapper masqué)
- **Blur d'après-chargement supprimé** — au repos : wallpaper avec **léger
  glass ~10px** par défaut (valeur `CONFIG`, modifiable ; l'esprit de la
  toute première version)
- L'idée #5 « blur permanent inversé » évolue → le blur devient un outil
  d'animation (voir point 5)

### 5. Anim de sortie du loading screen = blur ✅ livré v0.2.0
- Au reveal, le splash s'estompe via une **transition blur** (le blur est
  « pas mal en tant qu'anim en vrai ») au lieu d'apparaître d'un coup
- Mécanisme déjà en place (`filter` + `transition` sur la couche) — à recâbler
  comme transition de sortie uniquement

### 3. Double chargement CustomTab ⏳
- Symptôme : la home (extension CustomTab, chargée via redirection newtab)
  déclenche **deux cycles** de splash/barre
- Hypothèse : chaîne `about:newtab` → redirect (NewTab) → page CustomTab =
  2× START/STOP
- Fix envisagé : ignorer les redirects intermédiaires (comparer `currentURI`
  au START, ou filtrer `STATUS_REDIRECTING`)

### 2. Fidélité du chargement ⏳
- « Parfois le chargement est pas fidèle » : splash manqué (pages en cache,
  SPA), déclenché à tort, ou durée incorrecte
- Diagnostic à faire quand on y sera — le point 3 en est probablement un cas
  particulier

### 4. Filtre noir foncé sur le loading screen ⏳
- Un voile sombre recouvre la zone du loading screen — **pas la sidebar**
- Suspect n°1 : `#zen-main-app-wrapper` `rgba(0,0,0,0.2)` **natif de Zen**
  (pas prouvé que ce soit Nebula-Fork — la sidebar a un conteneur différent)
- À neutraliser dans chrome.css une fois le coupable confirmé

### Décisions actées (31/08) ✅
1. Blur repos = **léger glass 10px par défaut** (CONFIG modifiable)
2. Pools d'images perso **Git-ignorés** (`.gitignore`), une image par défaut
   commitée (`backgrounds/default.png`) pour un mod fonctionnel out-of-the-box
3. Validation point par point — pas de tunnel d'implémentation

## ✅ Livré & validé (v0.1.0 — architecture couche)

Le mod vit sur GitHub : `Impre-dev/BG-Zen`. Architecture validée de bout en
bout le 30-31/08 :

- **Couche dédiée** `#bgzen-layer` : `<div>` premier enfant de `#main-window`,
  `position: fixed`, `inset: -64px` (bleed blur), `z-index: -1`,
  `pointer-events: none`, wallpaper en `cover`
- **Stacking** : `#main-window { isolation: isolate; }` — sans ça l'enfant
  `z-index:-1` passe sous le fond de la fenêtre (invisible)
- **URL** : `PathUtils.toFileURI()` → var `--bgzen-image` posée par le JS
  (jamais d'URL relative feuille ni de `newURI` sur chemin Windows)
- **Glass hover** (§3 chrome.css) : image alignée `background-attachment:
  fixed` + `backdrop-filter` sur `#titlebar` au hover du toolbox
- **Splash** (§5 chrome.css) : `.browserSidebarContainer[bgzen-loading]`
  masqué + barre MyLoadingBar ré-affichée (
  `[bgzen-loading] #uc-loadingbar { visibility: visible }`)
- **Synchro barre** : reveal à 850ms (150 debounce + 400 hold + 300 fade)
- **Prérequis runtime** : prefs Zen Mica + transparence UI **ON**, Nebula
  (UI translucide) **actif**

## ⚠️ Contraintes techniques dures (leçons 30-31/08)

1. **JAMAIS de `background-image` sur `#main-window`** : ça casse l'opacité de
   compositing de la fenêtre → transparence visible à travers certaines pages
   (pages à fond opaque comprises). Le wallpaper vit sur la couche, point.
2. **Layers chrome invisibles sous contenu remote** : même sans `filter`, un
   layer chrome ne se composite pas sous les `<browser>` (OOP) — seuls les
   fonds de niveau canvas de la fenêtre s'y montraient. Conséquence : le
   wallpaper derrière les sidebars web dépend du canal canvas/transparent
   (à re-vérifier avec Nebula réactivé).
3. **`Services.io.newURI(cheminWindows).spec` rend des backslashes** → mangés
   par les escapes CSS dans `url("...")` (`\C` → form feed, image morte).
   Toujours `PathUtils.toFileURI()`.
4. **Origine des feuilles Sine** : un override inline peut perdre contre un
   `!important` de la feuille (origine agent) — piloter par **vars CSS + 
   attributs**, pas par overrides inline de propriétés.
5. **`isolation: isolate` sur `#main-window` obligatoire** pour que la couche
   `z-index:-1` se peigne au-dessus du fond fenêtre et sous l'UI.
6. **`elementsFromPoint` ignore les `pointer-events: none`** — la couche n'y
   apparaît jamais, c'est normal (diagnostics).

## 💡 Pile d'idées (futur, post-roadmap)

### 1. Wallpapers aléatoires (→ intégré au point 1 roadmap)
- Pool `backgrounds/` — images droppées/supprimées librement, scan à chaque
  tirage (`IOUtils.getChildren` + filtre extensions)
- **Formats** : jpg/jpeg, png, webp, avif, gif (animé ok), **jxl**, svg
- Tirage : par changement de domaine (décision actée 30/08), anti-répétition

### 1bis. Wallpapers animés ⭐⭐
- **Niveau 1** : GIF/WebP animé/APNG en `background-image` (quasi gratuit)
- **Niveau 2** : `-moz-element(#bgzen-video)` + `<video autoplay loop muted>`
  caché → wallpaper MP4/WebM. Feature signature. Pref on/off (coût GPU avec
  backdrop-filter glass)

### 2. Wallpapers par site cible
- Sous-dossiers par domaine : `backgrounds/youtube.com/`, etc.
- Résolution : match suffixe le plus long → pool dédié, sinon pool global
- Options spécifiques par site (image fixe, pool dédié, splash on/off)

### 3. Urlbar wallpaper
- Même traitement que la sidebar : image alignée (`fixed`) + glass
- Surtout visible en état `[open]`

### 4. Splashscreen de chargement ⭐ (→ points 2/3/5 roadmap)
- Masquage total du wrapper pendant le chargement — **livré v0.1.0**
- Reste : fidélité (pt 2), double chargement (pt 3), anim de sortie (pt 5)
- Design notes à garder : exclure `about:`/ancres/downloads, cap ~8s
  (`LAST RESORT`), `prefers-reduced-motion` → reveal sec, START = moment du
  tirage loading screen
- **Cohabitation MyLoadingBar** : la barre vit dans le conteneur masqué →
  règle de ré-affichage dédiée. Renforce la **fusion future** des deux mods
  (listener partagé)

### 5. ~~Blur dynamique inversé~~ → évolué (voir roadmap pt 1 & 5)
- ~~Blur permanent au repos~~ → remplacé par **léger glass 10px** constant
- Le blur devient la **transition de sortie** du splash (pt 5)

## Architecture cible v3 (consolidée 31/08)

**Principe : JS décisionnel minimal, CSS piloté par var + attributs.**

```
BG-Zen/                      (mod Sine)
├── theme.json
├── bg-zen.uc.js             ← modules
│     ├─ WallpaperResolver   (pools backgrounds/ + loadings/, domaine, random)
│     ├─ SplashController    (progress listener → bgzen-loading + synchro barre)
│     └─ liant TabSelect     (re-résolution per-site)
├── chrome.css               ← §0 isolation, §1 couche, §3 glass, §5 splash
├── preferences.json         ← MCM (futur)
├── backgrounds/             ← pool repos (Git-ignored, default.png commité)
│   └── _default/ ? / domaine/ (per-site, futur)
├── loadings/                ← pool loading screens (Git-ignored)
└── .gitignore
```

### Règles de résolution
- **Repos** : tirage dans `backgrounds/` — nouveau tirage **uniquement si
  domaine différent** (zéro flash intra-site)
- **Chargement** : au START, tirage dans `loadings/` → fond du splash
- **Par site** (futur) : match domaine → pool/fichier dédié, fallback global

### Contrat CSS

| État | Mécanisme |
|---|---|
| Image | `var(--bgzen-image)` sur `#bgzen-layer` (URL absolue posée par JS) |
| Blur repos | léger glass `blur(10px)` (CONFIG) sur la couche |
| Splash | `[bgzen-loading]` → wrapper masqué + barre ré-affichée |
| Sortie splash | transition blur (pt 5 roadmap) |
| Glass hover | §3 : image alignée `fixed` + `backdrop-filter` sur `#titlebar` |
| Stacking | `#main-window { isolation: isolate }` — jamais de bg-image dessus |

### Prefs MCM envisagées
Toggle global, blur repos (px), per-site on/off, splash on/off, tint,
anti-repeat on/off, pools animés on/off.

## Règles de contraintes

- **Event Driven Only** : progress listener, `animationend`, `TabSelect` ;
  timers uniquement en garde-fou débounce/cap/synchro barre (commentés
  `LAST RESORT`)
- **Itération** : édition UNIQUEMENT dans l'install profil
  (`sine-mods/BG-Zen/`), un restart suffit ; **copie profil → source +
  commit/push à la validation uniquement**
- Workflow : source `Sine-Mods/BG-Zen/` → GitHub public → install UI Sine →
  `installMod()` console pour les updates

## Questions ouvertes

- [ ] Sidebar web : wallpaper visible derrière les browsers remote ?
  (re-test avec Nebula réactivé — voir contrainte n°2)
- [ ] Fréquence du random (par domaine acté — session/manuel en plus ?)
- [ ] L'urlbar a son propre pool ou suit le site courant ?
- [ ] Splash : onglets background aussi ou selected seulement ?
- [ ] Fusion avec MyLoadingBar (mod unique) — quand ?
- [ ] Light/dark : pools séparés ou tint adaptatif ?
- [ ] Ancien `MyCss/BG.css` : à neutraliser (doublon avec le mod)

## Historique

- 2026-08-30 : kickoff brainstorm, prototype BG.css, enquête bordure (DWM),
  debug transparence (architecture couche validée), création mod v0.1.0,
  fix `toFileURI` (ef18835)
- 2026-08-31 : roadmap v2 actée (5 points, ordre 1→5→3→2→4), design pools
  validé (blur glass 10px, Git-ignore des images perso), SPEC consolidée v3
- 2026-08-31 : **v0.2.0** — points 1 & 5 livrés et validés : pools
  `backgrounds/` + `loadings/`, 2 couches (repos glass constant 10px +
  loading dédiée), anim de sortie fade+blur, re-tirage par domaine, fallback
