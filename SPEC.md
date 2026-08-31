# SPEC-BG-Zen — Wallpaper Engine pour Zen Browser

> 🊶态 **DRAFT — Brainstorm vivant**
> Ce document capture les idées au fil du brainstorm. Structure finale = à la fin.
> État : idées en vrac, périmètre non figé.

## Vision

Donner à Zen un système de fonds d'écran complet : wallpaper derrière toute l'UI,
splashscreens de chargement, wallpapers aléatoires et par site, glass sur les
éléments flottants (sidebar, urlbar).

## ✅ Déjà validé (prototype MyCss/BG.css)

Testé et fonctionnel dans le profil (`chrome/MyCss/BG.css`, importé en tête de
`userChrome.css`) :

1. **Fond de fenêtre** — `BG_Zen.png` en `cover` sur `#main-window`,
   `background-attachment: fixed`, tint réglable (`--bgzen-tint`)
2. **UI translucide** — `#zen-main-app-wrapper`, toolbars, `#browser`,
   sidebar : backgrounds neutralisés → l'image passe partout
3. **Sidebar alignée** — technique `background-attachment: fixed` :
   l'image est ancrée au **viewport**, donc l'élément affiche la **portion
   correspondante** de l'image → continuation pixel-perfect
   (équivalent CSS du `NebulaForkTitlebarBackgroundModule`, sans JS)
4. **Glass hover sidebar** — pattern fork §3b : tint glass + `backdrop-filter`
   + shadow + radius sur le titlebar hover (compact)
5. **Image transparente** — pattern fork §3 : pseudo-élément `::before`
   `z-index: -1` avec `opacity` (CSS ne permet pas d'alpha sur un
   background-image direct). *Rejeté finalement : retour à la version opaque.*

Le Mica (`widget.windows.mica`) reste actif — l'image couvre le fond de l'UI.

## 💡 Pile d'idées (en vrac)

### 1. Wallpapers aléatoires
- Dossier `backgrounds/` — images droppées/supprimées librement
- **Formats** : jpg/jpeg, png, webp, avif, gif (animé ok), **jxl** (activé par
  défaut dans Zen), svg — le picker filtrera par extension, tout se mélange
  librement dans un même pool
- CSS pur : **impossible** (aucun aléatoire en CSS) → JS obligatoire
- JS : `IOUtils.getChildren()` + `Math.random()` → set `--bgzen-image` sur `:root`
- Fréquence : à définir (par navigation / par session / re-roll manuel)

### 1bis. Wallpapers animés ⭐⭐
- **Niveau 1 — images animées** : GIF animé, WebP animé, APNG fonctionnent
  tels quels dans `background-image` (décodage compositor, quasi gratuit)
  - Pref `image.animation_mode` (normal/once/none) pour figer si besoin
- **Niveau 2 — vidéos** : `-moz-element(#bgzen-video)` référence un
  `<video autoplay loop muted>` caché (injecté par le .uc.js) comme background
  → wallpaper MP4/WebM derrière toute l'UI. Feature signature impossible en
  CSS pur / Chromium
- Perf : vidéo full-window + backdrop-filter glass = coût GPU réel →
  envisager pref "video on/off" et/ou vidéo réservée au pool `_default`
- Compatible avec `background-attachment: fixed` (alignment sidebar)

### 2. Wallpapers par site cible
- Sous-dossiers par domaine : `backgrounds/youtube.com/`, etc.
- Résolution : match domaine (suffixe le plus long) → pool dédié, sinon `_default/`
- Trois vars séparées possibles : fenêtre / sidebar / urlbar

### 3. Urlbar wallpaper
- Même traitement que la sidebar : image alignée (`fixed`) + glass
- Surtout visible en état `[open]` (élargissement)

### 4. Splashscreen de chargement ⭐
- Masquer le wrapper de la page (`.browserSidebarContainer.deck-selected`)
  pendant le chargement → le wallpaper occupe toute la zone
- Bénéfices : vraie loading screen + évite les flashs de contenu partiel
- Révélation : `blur(24px) → net` + micro `scale` (~400ms), cleanup sur
  `animationend` (event-driven)
- **Base existante** : `MyLoadingBar/loadingbar.uc.js` fournit déjà
  `onStateChange` START/STOP top-level + debounce 150ms anti-redirect +
  état par browser (WeakMap) + `TabSelect`/`TabAttrModified`
- Design notes :
  - Exclure `about:`, same-page anchors, downloads
  - Garde-fou sites lents : cap max ~8s (timer de sécurité répondant à un
    event, pas du polling)
  - SPA (YouTube soft nav) : pas de START/STOP → pas de splash, acceptable
  - `prefers-reduced-motion` : révélation sèche sans anim
  - START = moment idéal pour le tirage aléatoire (nouvelle image garantie)
- **Prototype actif** : règle §5 dans `MyCss/BG.css` (masquage `visibility:
  hidden` sur `.browserSidebarContainer[bgzen-loading]`, variante reveal
  blur en commentaire)
- **Cohabitation MyLoadingBar** (découverte au test) : la barre
  `#uc-loadingbar` est un enfant direct du conteneur masqué → le splash
  l'avalait. Fix : règle de ré-affichage ciblée
  (`> #uc-loadingbar { visibility: visible }`). **Renforce la question de
  la fusion des deux mods** — à terme, SplashController et la barre
  partageront le même listener au lieu d'en empiler deux

### Test console (Ctrl+Shift+J)

Toggle manuel (validation visuelle du rendu) :
```js
(() => { const c = document.querySelector('.browserSidebarContainer.deck-selected');
  c.hasAttribute('bgzen-loading') ? c.removeAttribute('bgzen-loading')
                                  : c.setAttribute('bgzen-loading', ''); })()
```

Simulation réaliste (progress listener one-shot, event-driven — F5 sur un
site lent pour voir le splash vivre) :
```js
(() => {
  const l = {
    onStateChange(b, wp, req, flags) {
      const c = document.querySelector('.browserSidebarContainer.deck-selected');
      if (flags & Ci.nsIWebProgressListener.STATE_START) c?.setAttribute('bgzen-loading', '');
      if (flags & Ci.nsIWebProgressListener.STATE_STOP)  c?.removeAttribute('bgzen-loading');
    },
    onProgressChange() {}, onLocationChange() {}, onStatusChange() {},
    onSecurityChange() {}, onContentBlockingEvent() {}
  };
  gBrowser.addTabsProgressListener(l);
  console.log('[BG-Zen] splash prototype actif — F5 pour tester');
})();
```

### 5. Blur dynamique du wallpaper (logique inversée) ⭐
- **État repos (site chargé)** : wallpaper FLOU en permanence — ambiance
  discrète derrière l'UI translucide, le contenu web prime
- **Pendant le chargement** : wallpaper NET — showcase plein cadre
- Le blur ne touche JAMAIS le site ni la barre (uniquement le fond)
- **Architecture v2** : l'image vit sur `#main-window::before` (pseudo
  dédié, `z-index: -1`) car `filter` est inapplicable à un
  `background-image` direct. `filter: blur(var(--bgzen-blur))` à l'état
  repos, `blur(0)` sous `:has([bgzen-loading])`, `transition: filter 500ms`
  pour le fondu
- **Bonus archi** : tout le monde (sidebar, urlbar, glass) laisse passer
  le même `::before` → alignement AUTOMATIQUE, les
  `background-attachment: fixed` par élément deviennent inutiles
- Compensation bleed : `inset: calc(-1 * var(--bgzen-blur) * 2)`

## Architecture cible (vision consolidée 30/08)

**Principe : JS décisionnel minimal, CSS piloté par var + attributs.**
Le JS choisit l'image et signale l'état de chargement — tout le rendu reste
en CSS (itérable au restart, sans toucher au JS).

```
BG-Zen/                      (mod Sine)
├── theme.json
├── bg-zen.uc.js             ← 3 modules, ~300 lignes
│     ├─ WallpaperResolver   (pools + domaine + random anti-repeat)
│     ├─ SplashController    (progress listener → attribut bgzen-loading)
│     └─ liant TabSelect     (re-résolution = là où vit le per-site)
├── chrome.css               ← BG.css §1-§3 + styles splash
├── preferences.json         ← MCM
└── backgrounds/
    ├── _default/            ← pool global
    └── youtube.com/         ← pool dédié
```

### Modules

1. **WallpaperResolver** — scan pool à chaque tirage (IOUtils.getChildren,
   filtrage extensions), match domaine suffixe le plus long, fallback
   `_default/`, `Math.random()` anti-répétition, sortie
   `Services.io.newURI(file)` → `--bgzen-image` sur `:root`
2. **SplashController** — pattern MyLoadingBar (STATE_START/STOP top-level,
   debounce 150ms), pose/retire `bgzen-loading` sur le conteneur du tab
   sélectionné, **zéro style direct**. Cap 8s (`LAST RESORT`), exclusions
   `about:`/ancres/downloads
3. **Liant** — `TabSelect` + navigation → re-résolution

### Contrat CSS

| État | Mécanisme |
|---|---|
| Image de fond | `var(--bgzen-image)` sur `#main-window::before` (v2) |
| Blur d'ambiance | `::before { filter: blur(var(--bgzen-blur)) }` à l'état repos |
| Wallpaper net | `:has([bgzen-loading])::before { filter: blur(0) }`, transition 500ms |
| Sidebar alignée | AUTOMATIQUE : tout le monde laisse passer le même `::before` (v2) |
| Glass hover | tint + `backdrop-filter` par-dessus le `::before` (v2) |
| Splash | `[bgzen-loading]` → wrapper masqué + wallpaper net plein cadre |
| Barre MyLoadingBar | ré-affichée via `> #uc-loadingbar { visibility: visible }` |

### Justification

- JS muet sur le rendu (1 var + 1 attribut) → itération 100% CSS
- Event Driven Only natif (progress listener, TabSelect, animationend)
- Per-site gratuit : c'est juste le moment de re-résolution
- Évolutif : vidéo `-moz-element()` greffable en 4e module

### Décisions actées (30/08) ✅

1. **Wallpaper suit le tab sélectionné** — nouveau tirage **uniquement si
   domaine différent** (même domaine = on garde l'image → zéro flash en
   navigation intra-site). Le resolver garde en mémoire le domaine courant.
2. **Splash = masquage total du wrapper** jusqu'à chargement complet
   (`STATE_STOP`). **À prototyper** dans BG.css / console pour valider
   le rendu (loading screen pur, wallpaper plein cadre).
3. **Pool unique, alignement global** — fenêtre + sidebar + urlbar
   consomment la même image alignée (technique `fixed`), pools indépendants
   rejetés : la cohérence visuelle prime.

### Prefs MCM envisagées

Toggle global, per-site on/off, splash on/off, intensité blur, tint,
anti-repeat on/off.

## Règles de contraintes

- **Event Driven Only** : progress listener, `animationend`, `TabSelect` ;
  timers uniquement en garde-fou débounce/cap (commentés `LAST RESORT`)
- Itération : édition directe dans l'install profil (`sine-mods/BG-Zen/`),
  sync profil → source à la validation
- Workflow : source `Sine-Mods/BG-Zen/` → GitHub public → install UI Sine

## Questions ouvertes

- [ ] Fréquence du random (nav / session / manuel) ?
- [ ] L'urlbar a son propre pool ou suit le site courant ?
- [ ] Le splash s'applique-t-il aux onglets background ou selected seulement ?
- [ ] Faut-il fusionner avec MyLoadingBar (mod unique) ou mods séparés ?
- [ ] Light/dark : pools séparés ou tint adaptatif ?

## Historique

- 2026-08-30 : kickoff brainstorm, prototype BG.css validé, idée splashscreen
