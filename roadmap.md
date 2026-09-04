# Roadmap BG-Zen

> Document de pilotage — statut au 05/09. La SPEC reste la référence architecture ;
> ce fichier est la file de travail priorisée.

## ✅ Livré & poussé

| Version | Contenu | Commit |
|---|---|---|
| v0.7.0 | Voile Nebula (`--nebula-browser-veil`) + §2 override + ui-tint restauré ; §3 recalibrée ; suivi loading sidebar (blur 0 + transitions synchronisées) | `4e1ef6b`, `face46f`, `e246cfb` |
| v0.7.1 | Fix flash v2 (tirage repos au STOP + warm-up décodage + TabSelect skip + double tirage éliminé) ; flash v3 (`startSession` partagé, splash au TabSelect d'une tab fraîche) ; logs v2 durables | `b8af574` |
| v0.7.2 | **Playlists shuffle** (`drawFrom` + queues Fisher-Yates) + **grâce supprimée** (cause du « 5× la même image d'affilée » — preuve log `w57y`). Validé : ~40 loadings, zéro répétition consécutive, passes complètes 6/7, jointures propres. | `aea555e` |
| v0.7.3 | **Roulement séquentiel** (`nextFrom` : tri collation, curseur par dossier, wrap + relecture du dossier à chaque tour, anti-répétition jointure) remplace le shuffle. Validé `wps2` : loadings cycle 7 (~1 tour ¾), backgrounds cycle 6 (~2 tours ½), zéro répétition. | ci-dessous |

## 🎯 File priorisée

### 1. Reset du log à chaque session
**Demande** : chaque fenêtre = nouveau départ ; les traces des sessions précédentes polluent les lectures et font grossir le fichier pour rien.
**Implémentation** : à l'init, **tronquer** le fichier avant le header (`IOUtils.writeUTF8` sans append = écrase — le bug de plateforme devient une feature). La cap 200 Ko glissante devient une sécurité résiduelle. Limite acceptée : multi-fenêtres simultanées → la dernière écrase.

### 3. Flash urlbar — splash sur la soumission ⭐ délicat
**Symptôme** (capture user) : à la validation d'une URL, le contenu courant est masqué quasi instantanément, mais le loading screen a un délai → le bg visible à nu → flash.
**Mécanisme** : le docshell abandonne la page **dès la soumission** (masquage immédiat pour les navs urlbar), alors que `STATE_START` — premier signal dispo côté chrome — n'arrive qu'à la création du channel réseau. Le gap = soumission → STATE_START.
**Fix event-driven** : écouter `keydown` Entrée sur `gURLBar.inputField` (+ bouton go) → `startSession('Urlbar')` immédiat. Le STATE_START suivant est absorbé par la garde de session existante. (Les navs par clic lien ne sont pas concernées : paint holding retient l'ancien contenu.)

### 4. Grâce adaptative du reveal
**Symptôme** : le STOP network ≠ contenu peint ; sur sites lourds (YouTube, soundcloud), le reveal à STOP+1000ms découvre le bg avant le 1er paint du site.
**Données log** : YouTube 3.9s de nav, soundcloud 16s ; localhost 0.26s.
**Fix** : `cd = clamp(durée_nav × 35%, 1000ms, 3500ms)` — `sessionStartAt` posé dans `startSession`, lu au STOP. Le min 1000ms couvre aussi le point « splash 1s sur chargements courts » (point 6 fusionné ici).

### 5. Glass sidebar → urlbar puis ctrl-tab
Étendre la recette §3 (copie wallpaper + voile/tint) à l'urlbar, puis au panneau ctrl-tab.

### 6. ~~Splash 1s sur chargements très courts~~ → fusionné au point 4 (min du clamp)

### 7. Double chargement CustomTab
La newtab CustomTab déclenche 2 sessions de splash (redirect about:blank → moz-extension). Déjà adouci par la garde de session ; reste à déterminer si on peut fusionner proprement.

### 8. Rework MyLoadingBar
Barre au-dessus du splash, full-window (au lieu de la barre Zen native).

### 9. z-index distincts des couches ⚡ hardening pas cher
Idée user : `rest: -2`, `loading: -1` — le loading s'impose toujours, ceinture+bretelles contre toute régression de sélecteur CSS.

### 10. SPEC v0.5.0 → v0.7.x
Dépendances (Nebula pour le voile), entries d'historique, + leçons ci-dessous.

### 11. Supprimer l'ancien MyCss/BG.css
(+ le `::before` #main-window fantôme) — remplacé par l'architecture couches.

### 12. Sync MyLoadingBar (null-safety) profil → source
Fix déjà appliqué dans l'install, à sync/pusher.

### 13. Bug Nebula-Fork (optionnel)
Attribut `nebula-zen-gradient-contrast-zero` jamais posé (dead code ligne ~48 du fork).

### 14. Long terme : per-site, animés, prefs MCM
Wallpapers par site, wallpapers animés (webm), préférences MCM.

## 🧠 Leçons de plateforme (à ne plus retester)

1. **`IOUtils.writeUTF8(…, { append: true })` TRONQUE** dans ce build Zen (prouvé console : 2 appends → fichier = dernière ligne). → read-append-write sérialisé. Le comportement « écrase » est exploité au point 2 pour le reset.
2. **`#zen-browser-background` ::before/::after** = voile natif Zen — le contrôler via `--nebula-browser-veil`, ne jamais le contourner.
3. **Le docshell masque la page avant `STATE_START`** sur les navs urlbar (cf. point 3).
4. **Bitmap non décodée peint VIDE** — warm-up `img.decode()` obligatoire avant tout crossfade (repos au STOP, prefetch loading).
