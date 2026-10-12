# Roadmap BG-Zen

> Document de pilotage — refonte du 10/10. Ce registre couvre uniquement les
> **3 grandes features du mod** (vision produit). Les anciens objectifs de la
> file pré-Utopia (grâce adaptative du reveal, double CustomTab, épluchage,
> z-index...) vivent dans l'archive `continuity/roadmap_BGZen_legacy.md`,
> avec l'historique des versions v0.1 → v0.7.6 et leurs commits.
> Référence transverse : `O:/Programmation/Navigateur/.md/Zen-Modes-Affichage.md`
> (layouts, compact, sidebar — prefs et attributs figés le 10/10).

## 🎯 Les 3 features

### 1. Wallpaper repos — le fond sous l'UI
**État : fonctionnel, aucun chantier ouvert — à préserver.**
Pool `backgrounds/`, roulement séquentiel (`nextFrom` : ordre alphabétique,
curseur, wrap au tour complet + relecture du dossier, anti-répétition en
jointure). Re-tirage uniquement au changement de domaine (zéro flash
intra-site). Warm-up décodage + `Sidebar.geometry()` pour le glass §3.

### 2. Loading screens — le splash de nav ⭐ LE CHANTIER
**Adaptation au mode d'affichage.** Prédicat retenu (plus fin que
compact/pas-compact) : *la sidebar est-elle visible pendant le splash ?*
- **Sidebar masquée** (compact + `hide-tabbar`) → splash plein-fenêtre, comportement actuel intact.
- **Sidebar visible** (mode normal, quel que soit le layout, ou compact « masquer toolbar ») → splash **uniquement à la place du contenu** : fond du `.browserSidebarContainer`, la sidebar et l'UI respirent normalement.

**Teinte** : le splash a SA teinte propre (`--bgzen-loading-tint`, **noir**
en zone-contenu) — indépendante de la teinte globale Utopia, qui reste
l'affaire de l'UI au repos (toggle d'humeur côté Utopia, cf. discovery
U-D1). Vigies : cache WebRender partagé couche/container (warm-up), sortie
animée à répliquer sur le container, split view, voile Utopia éventuellement
superposé au container. **Doctrine** : le JS ne bouge pas (cycle session,
warm-up, gardes), seul le CSS diverge selon le mode — var + attributs.

### 3. Boot splash
**État : fonctionne bien — ne pas casser.** Citation locale (corpus
Wikiquote, filtrage thématique, anti-repeat auteurs), press-start, anim
spring native, image de loading posée derrière le pan.

## 🔧 Travaux techniques (infra, hors vision produit)

- **Bascule `nebula-*` → `utopia-*`** — régression active constatée 10/10 :
  Nebula-Fork désactivé → `nebula-compact-mode` plus posé → §3 glass sidebar
  mort (4 sélecteurs jamais matchés). Périmètre : 4 sélecteurs + 2 vars dans
  `chrome.css` (le JS n'a aucune ref nebula). Non prioritaire selon Impre,
  à faire en premier quand on y passe (5 min + restart de test).
- Vestige `chrome copy.css` dans l'install profil (à nettoyer au passage).

## 🧠 Leçons de plateforme (actives — reprises de l'legacy, invariants du code actuel)

1. **`IOUtils.writeUTF8(…, { append: true })` TRONQUE** dans ce build Zen (prouvé console : 2 appends → fichier = dernière ligne). → read-append-write sérialisé. Le comportement « écrase » est exploité par le reset par session (v0.7.4).
2. **`#zen-browser-background` ::before/::after** = voile natif Zen — le contrôler via la var du socle actif (`--utopia-browser-veil` depuis la bascule Utopia), ne jamais le contourner.
3. **Le docshell masque la page avant `STATE_START`** sur les navs urlbar → couvrir via l'attribut ancêtre + BrowserNav (own props), pas en attendre le progress listener.
4. **Bitmap non décodée peint VIDE** — warm-up `img.decode()` obligatoire avant tout crossfade. ⚠️ decode ne chauffe que le **cache CPU** — voir leçon 5.
5. **`visibility:hidden` évince la texture WebRender** : élément sorti du display list → au retour, swap de background-image = upload GPU asynchrone = 1-3 frames transparentes (le flash). Fix : `opacity: 0.01` en base + `warmTexture()` pose la var à l'idle (après `transitionend` du fade de sortie) → activation = pur flip d'opacité sur texture en VRAM. Prouvé par log wf5a.
6. **Masquer le contenu pendant le splash : ancêtre stable uniquement** (`#tabbrowser-tabpanels[bgzen-loading]`) — un masque sur `.deck-selected` masque l'ancien container pendant que le neuf peint par-dessus le splash (covering précoce). *(Note 05/09 : symptôme fantôme en base saine — gardé pour mémoire.)*
7. **Wrappers `gBrowser.loadURI`/`fixupAndLoadURIString` = code MORT** : preuve source Zen (`URILoadingHelper.sys.mjs`) — les navs passent par l'own prop du `<browser>`. Le hook correct = own props sur chaque browser + wrap `gBrowser._insertBrowser`.
8. **⚠️ DOCTRINE — restaurer le stable, puis appliquer le fix final** : quand on empile des tentatives et qu'on trouve la solution, ne jamais livrer l'empilement — restaurer la dernière version stable puis ré-appliquer uniquement le fix fraîchement découvert. Les tentatives intermédiaires « fixent » des symptômes fantômes introduits par les tentatives précédentes (preuve : v0.7.5).
9. **Session orpheline = splash jamais révélé** : une session ouverte par un déclencheur (TabSelect/MO) sans nav réelle derrière n'aura JAMAIS de `STATE_STOP` → splash actif à vie. Un déclencheur ne doit ouvrir une session que si une nav est certaine (garde `setupTabSelect` : tab en cours de chargement uniquement). **Complément v0.8.1 (fix splash figé)** : la session doit aussi **survivre au changement de sélection** — le STOP d'une tab quittée en cours de chargement était filtré comme bruit background → reveal jamais joué, attribut orphelin + garde bloquée. Fix : la session retient browser/container au START, le reveal suit ce STOP même hors sélection (le tirage repos reste sélection-only) ; TabClose clôt une session sans STOP ; filet TabSelect rattrape tout résidu.
10. **PowerShell 5.1 `Get-Content`/`Set-Content` corrompt l'UTF-8 sans BOM** : pour tout texte UTF-8, utiliser les outils d'edit ou `[IO.File]::ReadAllText/WriteAllText` avec encodage explicite.

## ✅ Livré & poussé

> Historique antérieur (v0.1 → v0.7.6, avec commits) : `continuity/roadmap_BGZen_legacy.md`.
> Le tableau ci-dessous repart de la refonte du 10/10.

| Version | Contenu | Commit |
|---|---|---|
| — | (refonte du registre 10/10 : continuity/, roadmap legacy archivée, doc modes d'affichage) | — |
| v0.8.1 | **Fix vieux bug splash figé** (switch de tab pendant le chargement → STOP raté → attribut orphelin + garde bloquée) : session retient browser/container, reveal au STOP même hors sélection (tirage repos reste sélection-only), filet orphelin au TabSelect, TabClose clôt la session. Versions alignées 0.8.1. Validé live (repro + 5 scénarios). | `592b4cd` |
