# Roadmap BG-Zen

> Document de pilotage — statut au 05/09. La SPEC reste la référence architecture ;
> ce fichier est la file de travail priorisée.

## ✅ Livré & poussé

| Version | Contenu | Commit |
|---|---|---|
| v0.7.0 | Voile Nebula (`--nebula-browser-veil`) + §2 override + ui-tint restauré ; §3 recalibrée ; suivi loading sidebar (blur 0 + transitions synchronisées) | `4e1ef6b`, `face46f`, `e246cfb` |
| v0.7.1 | Fix flash v2 (tirage repos au STOP + warm-up décodage + TabSelect skip + double tirage éliminé) ; flash v3 (`startSession` partagé, splash au TabSelect d'une tab fraîche) ; logs v2 durables | `b8af574` |
| v0.7.2 | **Playlists shuffle** (`drawFrom` + queues Fisher-Yates) + **grâce supprimée** (cause du « 5× la même image d'affilée » — preuve log `w57y`). Validé : ~40 loadings, zéro répétition consécutive, passes complètes 6/7, jointures propres. | `aea555e` |
| v0.7.3 | **Roulement séquentiel** (`nextFrom` : tri collation, curseur par dossier, wrap + relecture du dossier à chaque tour, anti-répétition jointure) remplace le shuffle. Validé `wps2` : loadings cycle 7 (~1 tour ¾), backgrounds cycle 6 (~2 tours ½), zéro répétition. | `7a6725f` |
| v0.7.4 | **Reset du log à chaque session** : la fenêtre de démarrage tronque le fichier à son init (sérialisé sur `writeChain` avant le header) ; les fenêtres Ctrl+N s'appendent avec leur WTAG au lieu de wiper. Cap 200 Ko = sécurité résiduelle. Validé `wlgm` : 1134 lignes → 74, un seul header en 1re ligne + `🔁 tour complet` confirmé. | `f9b478e` |
| v0.7.5 | **Point 1 file livré — flash au chargement éliminé** : (a) v4 *texture GPU chaude* — couche loading `opacity: 0.01` au lieu de `visibility:hidden` + `warmTexture()` pose la var image à l'idle (après `transitionend` du fade de sortie) → activation = pur flip d'opacité sur texture déjà en VRAM ; (b) v5 *masque ancêtre stable* — attribut `bgzen-loading` posé sur `#tabbrowser-tabpanels` (jamais `.deck-selected`) : sur nav nouvel onglet la session part avant le deck switch. + **Épluchage** : `setupLoadURIHook` supprimé (mort — preuve source `URILoadingHelper.sys.mjs` : les navs passent par l'own prop du browser, jamais `gBrowser.*`), `setupTabSelect` fusionné dans `TabSelMO`, **logging batché par task** (`logCache` + `logQueue` + `queueMicrotask` : 1 I/O par task au lieu de 10-15 par nav), pass-through en dbgV. Validé user : « ça fonctionne !!! ». | `27ee510` |

## 🎯 File priorisée

### 1. Grâce adaptative du reveal ⭐
**Symptôme** : le STOP network ≠ contenu peint ; sur sites lourds (YouTube, soundcloud), le reveal à STOP+1000ms découvre le bg avant le 1er paint du site.
**Données log** : YouTube 3.9s de nav, soundcloud 16s ; localhost 0.26s.
**Fix** : `cd = clamp(durée_nav × 35%, 1000ms, 3500ms)` — `sessionStartAt` posé dans `startSession`, lu au STOP. Le min 1000ms couvre aussi le point « splash 1s sur chargements courts » (fusionné ici).

### 2. Glass sidebar → urlbar puis ctrl-tab
Étendre la recette §3 (copie wallpaper + voile/tint) à l'urlbar, puis au panneau ctrl-tab.

### 3. Double chargement CustomTab
La newtab CustomTab déclenche 2 sessions de splash (redirect about:blank → moz-extension). Déjà adouci par la garde de session ; reste à déterminer si on peut fusionner proprement.

### 4. Rework MyLoadingBar
Barre au-dessus du splash, full-window (au lieu de la barre Zen native).

### 5. z-index distincts des couches ⚡ hardening pas cher
Idée user : `rest: -2`, `loading: -1` — le loading s'impose toujours, ceinture+bretelles contre toute régression de sélecteur CSS.

### 6. SPEC v0.5.0 → v0.7.x
Dépendances (Nebula pour le voile), entries d'historique, + leçons ci-dessous.

### 7. Supprimer l'ancien MyCss/BG.css
(+ le `::before` #main-window fantôme) — remplacé par l'architecture couches.

### 8. Sync MyLoadingBar (null-safety) profil → source
Fix déjà appliqué dans l'install, à sync/pusher.

### 9. Bug Nebula-Fork (optionnel)
Attribut `nebula-zen-gradient-contrast-zero` jamais posé (dead code ligne ~48 du fork).

### 10. Long terme : per-site, animés, prefs MCM
Wallpapers par site, wallpapers animés (webm), préférences MCM.

## 🧠 Leçons de plateforme (à ne plus retester)

1. **`IOUtils.writeUTF8(…, { append: true })` TRONQUE** dans ce build Zen (prouvé console : 2 appends → fichier = dernière ligne). → read-append-write sérialisé. Le comportement « écrase » est exploité par le reset par session (v0.7.4). Depuis v0.7.5 : batch par task en mémoire + `queueMicrotask` (1 écriture par task JS).
2. **`#zen-browser-background` ::before/::after** = voile natif Zen — le contrôler via `--nebula-browser-veil`, ne jamais le contourner.
3. **Le docshell masque la page avant `STATE_START`** sur les navs urlbar → couvrir via l'attribut ancêtre + BrowserNav (own props), pas en attendre le progress listener.
4. **Bitmap non décodée peint VIDE** — warm-up `img.decode()` obligatoire avant tout crossfade (repos au STOP, prefetch loading). ⚠️ Mais decode ne chauffe que le **cache CPU** — voir leçon 5.
5. **`visibility:hidden` évince la texture WebRender** : l'élément sort du display list entre les sessions ; au retour, un swap de `background-image` (nouvel image-key WR) déclenche un upload GPU asynchrone = 1-3 frames transparentes où seule la couche chaude peint = le « flash bg repos puis loading screen ». Fix : garder la couche peinte (`opacity: 0.01` en base) + `warmTexture()` pose la var à l'idle → activation = flip d'opacité sur texture déjà en VRAM. Prouvé par log wf5a (splash posé AVANT la nav, flash quand même — donc le timing JS n'était pas le coupable).
6. **Masquer le contenu pendant le splash : ancêtre stable uniquement** (`#tabbrowser-tabpanels[bgzen-loading]`) — sur une nav en nouvel onglet, la session part AVANT le deck switch : un masque sur `.deck-selected` masque l'ancien container pendant que le neuf peint par-dessus le splash (covering précoce, variable selon le chemin de lancement). `#uc-loadingbar` est ré-affichée par règle descendant (la barre vit dans le sous-arbre masqué, reparentée dans le container actif).
7. **Wrappers `gBrowser.loadURI`/`fixupAndLoadURIString` = code MORT** : preuve par source Zen (`URILoadingHelper.sys.mjs`) — les navs passent toujours par l'own prop du `<browser>` (`targetBrowser.fixupAndLoadURIString`), jamais par `gBrowser.*`. Le hook correct = own props sur chaque browser + wrap `gBrowser._insertBrowser` (couvre les browsers créés après l'init).
