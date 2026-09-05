// ==UserScript==
// @name           BG-Zen
// @version        0.7.5
// @description    Wallpaper derrière l'UI de Zen — pools repos/loading, glass constant, splash
// @author         Impre
// @include        main
// ==/UserScript==

/* Roadmap v2 — points 1/2/5 + debug (SPEC.md) :
   - Deux pools : backgrounds/ (repos) + loadings/ (loading screens)
   - Deux couches superposées dans #main-window (isolation en CSS §0)
   - Garde de session : un START pendant un splash actif (redirect,
     reload) ne re-tirage rien → zéro flash, zéro 2e image.
   - Roulement séquentiel : chaque image 1× par tour (backgrounds + loadings).
   - Entrée animée (fade + de-blur, miroir de la sortie).
   - Logs debug dans bgzen-debug.log (CONFIG.debug).
   ⚠️ JAMAIS de background-image sur #main-window (bug transparence).
   ⚠️ Toujours PathUtils.toFileURI (newURI = backslashes → escapes CSS).
   ⚠️ request.name (nsIRequest) peut lever NOT_IMPLEMENTED → toujours
   le lire dans un try/catch dédié (leçon 31/08 : ça tuait le splash). */

(function () {
  'use strict';

  const CONFIG = {
    restBlurPx: 10, // glass constant au repos
    enterMs: 300, // anim d'ENTRÉE de la couche loading (fade + de-blur)
    exitMs: 400, // anim de sortie de la couche loading (pt 5)
    barTotalMs: 1000, // barre (850) + 150ms de grâce paint : le contenu
    // a le temps d'être affiché avant le reveal
    bootFadeMs: 600, // fade de sortie du boot splash (pseudo ::after CSS §6)
    bootRevealCdMs: 1000, // VALIDÉ 03/09 : cd du reveal AU BOOT en press start.
    // Testé 0 (cash) puis 500 → 1000ms = bon feeling, cohérent avec
    // barTotalMs qui régit les navs normales.
    bootTimeoutMs: 15000, // LAST RESORT : filet si aucun STOP ne survient jamais
    bootTitle: ['Welcome to', 'a calmer internet'], // fallback si corpus absent/illisible
    bootQuote: true, // citation aléatoire en phrase d'accueil (corpus local Wikiquote)
    quoteExcludeThemes: [
      'religion',
      'croyance',
      'spiritualite',
      'theolog',
      'christianis',
      'judaisme',
      'islam', // famille Religion
      'econom',
      'financ',
      'entreprise', // famille Économie
      'politi',
      'travail',
      'droit', // politique / travail / droit (02/09)
    ], // racines normalisées matchées sur les thèmes (c/C) du corpus — live au restart
    bootMinMs: 2500, // durée MINIMALE du boot splash — l'anim a le temps de vivre
    bootWaitSkipShort: false, // false → "press start" sur TOUTES les citations
    // (défaut, 31/08). true → seules les longues
    // (> bootWaitThreshold) attendent l'input.
    bootWaitThreshold: 180, // seuil "longue" (chars) si bootWaitSkipShort
    // (game pur : attente input, aucun failsafe)
    debug: true, // logs fichier (bgzen-debug.log) — false en prod
    debugVerbose: false, // bruit (non-top-level, geometry, skips) — true pour auditer à fond
    imageExts: ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.jxl', '.svg'],
  };

  const MOD_DIR = PathUtils.join(PathUtils.profileDir, 'chrome', 'sine-mods', 'BG-Zen');
  const BG_DIR = PathUtils.join(MOD_DIR, 'backgrounds');
  const LD_DIR = PathUtils.join(MOD_DIR, 'loadings');
  const CORPUS_FILE = PathUtils.join(MOD_DIR, 'corpus.json'); // corpus Wikiquote commité (2972 citations, méta thèmes c/C)
  const QUOTE_HIST_FILE = PathUtils.join(MOD_DIR, 'boot', 'quote-history.json'); // 10 derniers auteurs → gitignore
  const REST_LAYER_ID = 'bgzen-layer';
  const LD_LAYER_ID = 'bgzen-loading-layer';

  function log(...args) {
    console.log('[BG-Zen]', ...args);
  }

  /* ---------- Log debug fichier ---------- */
  // Tout l'enchaînement chargement atterrit dans bgzen-debug.log.
  // Reset à chaque session : la fenêtre de démarrage tronque le
  // fichier à son init (voir init) — chaque session = nouveau départ.
  // Cap ~200 Ko glissante = sécurité résiduelle (multi-fenêtres).
  // ⚠️ data runtime → gitignoré. Écritures sérialisées (chaîne de
  // promesses) + dbg blindé : le logging ne peut JAMAIS casser l'appelant.
  const LOG_FILE = PathUtils.join(MOD_DIR, 'bgzen-debug.log');
  const WTAG = 'w' + Math.random().toString(36).slice(2, 5); // tag fenêtre — démêle le multi-fenêtres

  // ⚠️ Ce build Zen TRONQUE avec IOUtils.writeUTF8(…, { append: true })
  // (prouvé en console : 2 appends successifs → fichier = dernière ligne seule).
  // → v0.7.5 (perf) : cache mémoire + batch par task JS. Le fichier n'est
  //   lu QU'UNE fois (lazy, au 1er flush) ; chaque dbg() ne fait qu'un
  //   push dans logQueue ; queueMicrotask vide la queue → 1 écriture par
  //   task au lieu d'un read-append-write complet PAR LIGNE (10-15 I/O
  //   par nav → 1). Cap glissante ~200 Ko en mémoire. Trade-off assumé :
  //   deux fenêtres concurrentes ont chacune leur cache (dernière
  //   écriture gagne) — le debug multi-fenêtres reste lisible via les
  //   WTAG, la perte croisée éventuelle est acceptable pour du log de dev.
  let logCache = null; // contenu disque en mémoire (null = pas encore lu)
  let logQueue = []; // lignes de la task courante — flush en microtask

  async function flushQueue() {
    if (!logQueue.length) return;
    const lines = logQueue;
    logQueue = [];
    try {
      if (logCache === null) {
        try { logCache = await IOUtils.readUTF8(LOG_FILE); } catch { /* 1er boot : fichier absent */ }
      }
      logCache += lines.join('\n') + '\n';
      if (logCache.length > 200 * 1024) {
        const cut = logCache.indexOf('\n', logCache.length - 200 * 1024);
        logCache = cut >= 0 ? logCache.slice(cut + 1) : logCache.slice(-200 * 1024);
      }
      await IOUtils.writeUTF8(LOG_FILE, logCache);
    } catch (ex) {
      console.error('[BG-Zen] écriture log impossible:', ex.message);
    }
  }

  function writeLog(line) {
    logQueue.push(line);
    queueMicrotask(flushQueue); // event-driven : fin de la task courante, zéro timer
  }

  // Format unique : [fenêtre] HH:MM:SS.mmm — une seule horloge, zéro doublon.
  function dbg(...args) {
    if (!CONFIG.debug) return;
    try {
      writeLog(`[${WTAG}] ${new Date().toISOString().slice(11, 23)} ${args.join(' ')}`);
    } catch {
      /* le logging ne doit JAMAIS casser l'appelant */
    }
  }

  // Bruit (non-top-level, geometry, etc.) — visible seulement en verbose.
  function dbgV(...args) {
    if (!CONFIG.debugVerbose) return;
    dbg('·', ...args);
  }

  // Normalisation thèmes : NFD sans diacritiques + lowercase.
  // 'Vocabulaire religieux' → 'vocabulaire religieux' (matchable par 'relig').
  function normTheme(s) {
    return s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  // ⚠️ request.name (nsIRequest) lève NOT_IMPLEMENTED quasi systématiquement
  // dans ce contexte — l'optional chaining ne protège PAS d'une exception de
  // getter. Fallback : l'URI courante du browser.
  function safeUrl(request, browser) {
    try {
      const n = request?.name;
      if (n) return String(n).slice(0, 60);
    } catch {
      /* NOT_IMPLEMENTED → fallback */
    }
    try {
      return browser?.currentURI?.spec?.slice(0, 60) ?? '(?)';
    } catch {
      return '(?)';
    }
  }

  /* ---------- WallpaperResolver ---------- */

  const Resolver = {
    currentDomain: null,
    lastRest: null,
    lastLoading: null, // dernière image loading affichée (anti-répétition)
    nextLoading: null, // image pré-tirée pour la prochaine session

    async listImages(dir) {
      try {
        if (!(await IOUtils.exists(dir))) return [];
        const entries = await IOUtils.getChildren(dir);
        return entries.filter((p) => CONFIG.imageExts.some((e) => p.toLowerCase().endsWith(e)));
      } catch (ex) {
        log('listImages erreur:', ex.message);
        return [];
      }
    },

    // Roulement séquentiel : images lues dans l'ordre alphabétique du
    // dossier, les unes après les autres, boucle au début du tour.
    // Déterministe — « ça change à chaque fois » dès que le pool > 1,
    // fini l'aléa et ses retours en boucle. Dossier relu à chaque tour
    // complet (ajouts/retraits pris en compte).
    cursors: new Map(), // dir → { idx: 0, last: null }

    async nextFrom(dir, label) {
      const files = (await this.listImages(dir)).sort((a, b) => a.localeCompare(b));
      if (!files.length) return null;
      let st = this.cursors.get(dir);
      if (!st) this.cursors.set(dir, (st = { idx: 0, last: null }));
      if (st.idx >= files.length) {
        st.idx = 0;
        dbg(`🔁 roulement ${label} — tour complet (${files.length} images), dossier relu`);
      }
      // Fichier retiré du dossier en cours de tour → sauté (setVar sur
      // un fichier absent peindrait vide). Anti-répétition : si le
      // candidat === dernière jouée (jointure de tour), cran suivant.
      while (
        st.idx < files.length &&
        ((files.length > 1 && files[st.idx] === st.last) || !(await IOUtils.exists(files[st.idx])))
      ) st.idx++;
      if (st.idx >= files.length) return null; // tout sauté (course avec suppression)
      const file = files[st.idx];
      st.idx = st.idx + 1; // peut dépasser → wrap + relecture du dossier au prochain appel
      st.last = file;
      return file;
    },

    setVar(name, file) {
      document.documentElement.style.setProperty(name, `url("${PathUtils.toFileURI(file)}")`);
    },

    async resolveRest(domain) {
      if (domain === this.currentDomain) {
        dbgV('resolveRest SKIP — même domaine:', domain || '(vide)');
        return; // zéro flash intra-site
      }
      const file = await this.nextFrom(BG_DIR, 'backgrounds');
      if (!file) {
        dbg('resolveRest — pool backgrounds/ VIDE, image inchangée');
        return; // on ne mémorise pas le domaine → retry possible
      }
      dbg(`resolveRest TIRAGE [${domain || '(vide)'}] →`, file.split('\\').pop());
      this.currentDomain = domain;
      this.lastRest = file;
      this.setVar('--bgzen-image', file);
      // Warm-up décodage : l'image repos doit être prête AVANT le fade
      // de sortie du splash (tirage au STOP, révélé 1000ms plus tard).
      // Sans ça, un bitmap non décodé peint VIDE pendant le crossfade.
      try {
        const img = new Image();
        img.src = PathUtils.toFileURI(file);
        img.decode().catch(() => {});
      } catch { /* warm-up best effort */ }
      Sidebar.geometry(); // crop de la copie sidebar (§3) suit le tirage
    },

    // Fallback async (cash manqué) : tirage au START, activation en .then.
    async resolveLoading() {
      let file = await this.nextFrom(LD_DIR, 'loadings');
      if (!file) {
        file = this.lastRest; // fallback : pool vide → image repos
        if (!file) {
          dbg('resolveLoading — aucun fichier dispo');
          return;
        }
      }
      this.setVar('--bgzen-loading-image', file);
      this.lastLoading = file;
      dbg('resolveLoading →', file.split('\\').pop());
    },

    // Pré-tirage (au reveal + à l'init) : choisit l'image de la
    // PROCHAINE session. La var n'est PAS posée ici directement mais
    // via warmTexture — qui attend la fin du fade de sortie (l'image
    // du crossfade en cours ne doit jamais être écrasée). Au START
    // suivant : applyLoading repose la valeur (idempotent) sur une
    // texture DÉJÀ en VRAM. + warm-up décodage : une image non
    // décodée peint VIDE — sans ça, la couche opaque frame 0 laisse
    // transparaître le repos quelques frames.
    async prefetchLoading() {
      const file = await this.nextFrom(LD_DIR, 'loadings');
      if (!file) {
        dbg('prefetch — pool vide, pas de pré-tirage');
        return;
      }
      this.nextLoading = file;
      dbg('prefetchLoading PROCHAINE →', file.split('\\').pop());
      try {
        const img = new Image();
        img.src = PathUtils.toFileURI(file);
        await img.decode(); // bitmap prête en cache pour le START
        dbg('prefetch bitmap DÉCODÉE →', file.split('\\').pop());
      } catch (ex) {
        dbg('prefetch decode échec:', ex.message);
      }
      this.warmTexture(file);
    },

    // Fix flash (05/09 — texture GPU chaude) : img.decode() ne réchauffe
    // que le cache CPU. La TEXTURE WebRender de la couche n'existe que si
    // la couche PEINT l'image — elle y est désormais (opacity 0.01, plus
    // jamais visibility:hidden). On pose donc la var de la prochaine
    // image pendant le repos : l'upload GPU se fait à l'idle, des
    // secondes avant le START. L'activation devient un pur flip
    // d'opacité sur texture en VRAM → zéro frame transparente.
    // ⚠️ Si le fade de sortie court encore (prefetch appelé au reveal),
    // on attend son transitionend — poser la var maintenant écraserait
    // l'image du crossfade en cours.
    warmTexture(file) {
      const layer = loadingLayerEl;
      if (!layer || layer.hasAttribute('bgzen-active')) return;
      const apply = () => {
        if (this.nextLoading !== file) return; // tirage plus récent → lui prendra la place
        if (loadingLayerEl?.hasAttribute('bgzen-active')) return; // session relancée entre-temps
        this.setVar('--bgzen-loading-image', file);
        dbg('prefetch var POSÉE — texture GPU chauffée à l\'idle →', file.split('\\').pop());
      };
      const fading = parseFloat(getComputedStyle(layer).opacity) > 0.02; // fade de sortie en cours
      if (!fading) {
        apply();
        return;
      }
      const done = () => {
        layer.removeEventListener('transitionend', onEnd);
        clearTimeout(guard);
        apply();
      };
      const onEnd = (e) => {
        if (e.target !== layer) return;
        if (e.propertyName !== 'opacity' && e.propertyName !== 'filter') return;
        done();
      };
      layer.addEventListener('transitionend', onEnd);
      // LAST RESORT: transitionend peut être avalé (fade interrompu par
      // une nouvelle session, reduced-motion). apply() est gardé
      // (nextLoading / bgzen-active) → simple filet de debounce,
      // applyLoading reste l'autorité au START.
      const guard = setTimeout(done, CONFIG.exitMs + 100);
    },

    // Switch CASH au START : var posée en synchrone, retour du fichier.
    // ⚠️ JAMAIS de fallback lastRest ici (leçon 31/08 : l'ancienne
    // version affichait l'image repos dans la couche loading → le
    // symptôme "on voit le bg permanent" venait de LÀ). Si rien n'est
    // prêt on rend null → l'appelant retombe sur le tirage async.
    // (05/09 : grâce supprimée — chaque session consomme un slot shuffle.)
    // Le log CHAUDE/FROIDE valide le warm-up : CHAUDE = la var était
    // déjà posée à l'idle par warmTexture (texture en VRAM, flip pur) ;
    // FROIDE = upload GPU à l'activation (cash manqué du prefetch, 1er
    // boot, fade interrompu) — le flash ne peut plus survenir que là.
    applyLoading() {
      const file = this.nextLoading;
      if (!file) return null;
      const warm =
        document.documentElement.style.getPropertyValue('--bgzen-loading-image') ===
        `url("${PathUtils.toFileURI(file)}")`;
      this.setVar('--bgzen-loading-image', file);
      this.lastLoading = file;
      this.nextLoading = null;
      dbg(`applyLoading CASH → ${file.split('\\').pop()} (pré-tirée, texture ${warm ? 'CHAUDE' : 'FROIDE'})`);
      return file;
    },
  };

  /* ---------- Couches ---------- */

  /* ---------- Sidebar glass (§3) ----------
     La sidebar compact (barre flottante au hover) peint une copie du
     wallpaper (chrome.css §3) pour répliquer le sandwich visible dans
     les marges : image blur(restBlurPx) × tint 0.2 (wrapper Nebula)
     × op 0.8 (TabsToolbar) × op 0.98 (body) — mesuré 04/09 par diff
     de snapshots DOM (repos vs hover). Le crop de la copie DOIT être
     identique à celui de la couche §1 : un cover CSS sur le viewport
     ≠ cover de la box viewport+128px bleed → geometry exacte calculée
     ici, en coords viewport (consommée en background-attachment:fixed). */

  const Sidebar = {
    lastFile: null,
    lastW: 0,
    lastH: 0,
    sizes: new Map(), // cache natural size par fichier

    async geometry() {
      const file = Resolver.lastRest;
      if (!file) return;
      if (file === this.lastFile && window.innerWidth === this.lastW && window.innerHeight === this.lastH) return;
      let nat = this.sizes.get(file);
      if (!nat) {
        try {
          const img = new Image();
          img.src = PathUtils.toFileURI(file);
          await img.decode();
          nat = { w: img.naturalWidth, h: img.naturalHeight };
          this.sizes.set(file, nat);
        } catch (ex) {
          dbg('sidebar geometry — décodage échoué:', ex.message);
          return;
        }
      }
      if (file !== Resolver.lastRest) return; // tirage changé pendant le decode
      const B = 64; // bleed miroir de la couche §1 (inset: -64px)
      const W = window.innerWidth, H = window.innerHeight;
      const s = Math.max((W + 2 * B) / nat.w, (H + 2 * B) / nat.h);
      const w = Math.round(nat.w * s), h = Math.round(nat.h * s);
      const root = document.documentElement.style;
      root.setProperty('--bgzen-cover-size', `${w}px ${h}px`);
      root.setProperty('--bgzen-cover-pos', `${Math.round((W - w) / 2)}px ${Math.round((H - h) / 2)}px`);
      this.lastFile = file;
      this.lastW = W;
      this.lastH = H;
      dbgV(`sidebar geometry ${w}x${h} (cover box bleed ${W + 2 * B}x${H + 2 * B})`);
    },
  };

  function createLayers() {
    const mw = document.getElementById('main-window');
    if (!mw) return null;
    document.getElementById(REST_LAYER_ID)?.remove();
    document.getElementById(LD_LAYER_ID)?.remove();

    const rest = mw.appendChild(document.createElement('div'));
    rest.id = REST_LAYER_ID;

    const loading = mw.appendChild(document.createElement('div'));
    loading.id = LD_LAYER_ID;

    const root = document.documentElement.style;
    root.setProperty('--bgzen-blur', `${CONFIG.restBlurPx}px`);
    root.setProperty('--bgzen-exit', `${CONFIG.exitMs}ms`);
    root.setProperty('--bgzen-enter', `${CONFIG.enterMs}ms`);
    return { rest, loading };
  }

  /* ---------- BootSplash ---------- */
  // Splash FULL-UI au lancement (enquête zen-boot-splash 31/08) :
  // le pseudo #main-window::after (CSS §6, userChrome = frame 0,
  // AVANT tout JS) couvre tout — l'écran gris natif
  // (#zen-browser-background) et le shuffle de sélection de Zen au
  // démarrage ne se voient jamais. Titre + anims repris du welcome
  // natif (ZenWelcome.mjs) : gZenUIManager.motion = moteur spring
  // de Zen, fallback keyframes CSS s'il n'est pas prêt au boot.
  // Retrait : 1er REVEAL (fin de session homepage) ou failsafe.

  const BootSplash = {
    titleEl: null,
    guard: null,
    installAt: 0,
    done: false,

    // Splash uniquement sur la fenêtre du démarrage : à l'ouverture
    // d'une fenêtre en cours de session (Ctrl+N), d'autres fenêtres
    // existent déjà → pas de boot splash (sinon UI recouverte).
    isStartupWindow() {
      try {
        let n = 0;
        for (const w of Services.wm.getEnumerator('navigator:browser')) n++;
        return n <= 1;
      } catch (ex) {
        dbg('isStartupWindow erreur:', ex.message);
        return false;
      }
    },

    async install() {
      const mw = document.getElementById('main-window');
      this.installAt = Date.now();
      // Phrase d'accueil : citation PIOCHÉE LOCALEMENT dans le corpus
      // Wikiquote (02/09 — zéro réseau au boot, filtrage thématique
      // + anti-repeat auteurs, cf. loadQuote). Corpus absent →
      // texte CONFIG.bootTitle.
      const quote = CONFIG.bootQuote ? await this.loadQuote() : null;
      // Défensif : le cache peut contenir du HTML brut (leçon 31/08 —
      // l'API renvoie des <br /> dans les textes versifiés).
      const text = quote ? this.sanitizeText(quote.text) : null;
      const lines = text ? [text, `— ${quote.author}`] : CONFIG.bootTitle;
      // Mode "press start" (cf. enterWait) : le splash persiste
      // jusqu'à un input utilisateur. bootWaitSkipShort = false →
      // TOUTES les citations attendent (défaut) ; true → seulement
      // les longues (> bootWaitThreshold).
      const long = !!text && text.length > CONFIG.bootWaitThreshold;
      this.waitMode = !!text && (long || !CONFIG.bootWaitSkipShort);
      const title = document.createElement('div');
      title.id = 'bgzen-boot-title';
      for (const line of lines) {
        const span = document.createElement('span');
        span.textContent = line;
        // Poème long → police réduite pour ne pas déborder
        if (line === text && long) span.classList.add('long');
        title.appendChild(span);
      }
      mw.appendChild(title);
      this.titleEl = title;
      this.animateIn();
      // LAST RESORT: aucun événement ne garantit qu'une session de
      // chargement démarre au boot — sans ce filet, un STOP perdu
      // laisserait le splash à l'écran (navigateur inutilisable).
      this.guard = setTimeout(() => this.finish('FAILSAFE timeout'), CONFIG.bootTimeoutMs);
      dbg(
        quote
          ? `▶️ BOOT splash installé (citation de ${quote.author || 'anonyme'})`
          : '▶️ BOOT splash installé (texte défaut — pas de citation en cache)',
      );
    },

    // Pick LOCAL instantané dans le corpus Wikiquote — AUCUN réseau au
    // boot (02/09 : fin du pipeline lecog/prefetch). Filtrage thématique
    // runtime : racines de CONFIG.quoteExcludeThemes matchées sur les
    // feuilles `c` + macro-ancêtres `C` de chaque citation. Puis
    // anti-repeat : on évite les 10 derniers auteurs affichés
    // (boot/quote-history.json) — la boucle Pascal/Blake devient
    // structurellement impossible.
    async loadQuote() {
      try {
        const data = await IOUtils.readJSON(CORPUS_FILE);
        const quotes = data?.quotes;
        if (!Array.isArray(quotes) || !quotes.length) return null;
        const banned = CONFIG.quoteExcludeThemes.map(normTheme);
        const ok = (q) => {
          const hay = normTheme([...(q.c || []), ...(q.C || [])].join(' '));
          return !banned.some((b) => hay.includes(b));
        };
        let pool = quotes.filter(ok);
        if (!pool.length) pool = quotes; // blocklist trop large → corpus entier
        let hist = [];
        try {
          hist = (await IOUtils.readJSON(QUOTE_HIST_FILE)) ?? [];
        } catch {
          /* 1er boot */
        }
        let pick,
          tries = 0;
        do {
          pick = pool[Math.floor(Math.random() * pool.length)];
        } while (hist.includes(normTheme(pick.a)) && ++tries < 20);
        hist.push(normTheme(pick.a));
        // ⚠️ tmpPath ABSOLU requis (leçon 31/08). Échec silencieux :
        // l'anti-repeat est du bonus, pas une dépendance.
        IOUtils.writeJSON(QUOTE_HIST_FILE, hist.slice(-10), { tmpPath: QUOTE_HIST_FILE + '.tmp' }).catch(() => {});
        dbg(`cita locale — ${pick.a} (pool ${pool.length}/${quotes.length})`);
        return { text: pick.t, author: pick.a };
      } catch (ex) {
        dbg('corpus illisible:', ex.message ?? String(ex));
        return null;
      }
    },

    // L'API renvoie du HTML dans le texte (<br />, entités, indentation).
    // Les <br /> deviennent de vrais sauts de ligne (rendu versifié via
    // white-space: pre-line), le reste est nettoyé.
    sanitizeText(raw) {
      return raw
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&/gi, '&')
        .replace(/</gi, '<')
        .replace(/>/gi, '>')
        .replace(/"/gi, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/[ \t]+/g, ' ')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join('\n')
        .trim();
    },

    // Anim d'entrée façon ZenWelcome.animateInitialStage : spring
    // stagger natif (stiffness 300 / damping 20 / mass 1.8).
    // Moteur absent/prêt trop tard → fallback keyframes CSS.
    animateIn() {
      try {
        const motion = window.gZenUIManager?.motion;
        if (!motion) throw new Error('motion indisponible');
        motion
          .animate(
            '#bgzen-boot-title span',
            { opacity: [0, 1], y: [20, 0], filter: ['blur(2px)', 'blur(0px)'] },
            {
              delay: motion.stagger(0.6, { startDelay: 0.2 }),
              type: 'spring',
              stiffness: 300,
              damping: 20,
              mass: 1.8,
            },
          )
          .then(
            () => dbg('BOOT titre animé (motion spring natif de Zen)'),
            () => {
              this.titleEl?.classList.add('bgzen-css-anim');
              dbg('BOOT motion rejet → fallback CSS');
            },
          );
      } catch {
        this.titleEl?.classList.add('bgzen-css-anim');
        dbg('BOOT titre animé (fallback CSS — motion absent)');
      }
    },

    // Dès que l'image de loading est pré-tirée ET décodée : posée
    // sur le pseudo ::after (userChrome §boot) → fade-in par-dessus
    // le pan boot.jpg, qui est gelé (visibility hidden + pause →
    // plus rien ne coûte). Le START du homepage re-posera le MÊME
    // fichier (applyLoading) → aucun pop.
    revealImage() {
      if (this.done || !Resolver.nextLoading) return;
      Resolver.setVar('--bgzen-loading-image', Resolver.nextLoading);
      document.getElementById('main-window')?.setAttribute('bgzen-boot-image', '');
      dbg('BOOT image posée → fade-in par-dessus le pan (pan gelé)');
    },

    // Appelé au 1er REVEAL : sortie façon welcome (titre fade +
    // y -10px + blur) puis pseudo ::after → opacity 0 (fade §6).
    // Idempotent — les REVEAL suivants ne repassent pas ici.
    finish(reason) {
      if (this.done) return;
      this.done = true;
      clearTimeout(this.guard);
      // Durée minimale : si la homepage charge plus vite que
      // bootMinMs, on laisse l'anim vivre avant de sortir. Si elle
      // est plus lente, hold = 0 → sortie immédiate au REVEAL.
      // Le hold bootMinMs ne protège que les sorties AUTO (le temps
      // de lire le titre) — inutile en press start, où c'est l'input
      // qui décide.
      const hold = Math.max(0, CONFIG.bootMinMs - (Date.now() - this.installAt));
      // Mode "press start" (game pur, validé 31/08) : le splash
      // persiste jusqu'à un input utilisateur. Aucun failsafe ici :
      // l'input EST l'événement de sortie — même un STOP perdu ne
      // peut plus bloquer (n'importe quelle touche ferme).
      if (this.waitMode) {
        this.enterWait(); // idempotent — déjà armé si 1er STOP précoce
        dbg(`🕹️ BOOT waitMode — attente input (${reason})`);
        return;
      }
      this.exitNow(reason, hold);
    },

    // Écran titre de jeu : hint pulsant en bas + one-shot keydown ET
    // mousedown — le premier input gagne, l'autre listener est retiré
    // (pas de double-fire). Le pseudo est pointer-events:none → les
    // clics traversent vers l'UI et bubblent quand même à window.
    enterWait() {
      if (this.waitArmed) return;
      this.waitArmed = true;
      const hint = document.createElement('div');
      hint.id = 'bgzen-boot-hint';
      hint.textContent = 'Pressez une touche pour continuer…';
      this.titleEl?.appendChild(hint);
      this.waitExit = () => {
        window.removeEventListener('keydown', this.waitExit);
        window.removeEventListener('mousedown', this.waitExit);
        this.exitNow('input utilisateur', 0);
      };
      window.addEventListener('keydown', this.waitExit);
      window.addEventListener('mousedown', this.waitExit);
    },

    exitNow(reason, hold = 0) {
      setTimeout(() => {
        this.titleEl?.classList.add('bgzen-boot-out');
        document.getElementById('main-window')?.setAttribute('bgzen-booted', '');
        setTimeout(() => this.titleEl?.remove(), CONFIG.bootFadeMs + 100);
      }, hold);
      dbg(`🏁 BOOT splash — sortie dans ${hold}ms (${reason})`);
    },
  };

  /* ---------- SplashController ---------- */

  function getDomain(browser) {
    try {
      return browser.currentURI?.host ?? '';
    } catch {
      return '';
    }
  }

  // Activation de session partagée (START de nav + TabSelect d'une tab
  // fraîche). Posée par setupProgress — closure sur loadingLayer/état.
  let startSession = null;

  // Réf module de la couche loading — Resolver.warmTexture s'en sert pour
  // chauffer la texture GPU à l'idle (posée par init après createLayers).
  let loadingLayerEl = null;

  function setupProgress(loadingLayer) {
    let unmaskTimer = null; // LAST RESORT: reveal différé = synchro barre (barTotalMs)
    let lastRevealAt = 0; // anti double-image : pas de re-tirage juste après un reveal

    // ⚠️ Fix flash v3 (05/09) : appelée AUSSI depuis TabSelect. Sélection
    // d'une tab fraîche → la page quittée (ex: CustomTab OPAQUE) laisse
    // place à un onglet vide TRANSPARENT → le repos flashait ~30ms avant
    // le START. On couvre à l'event même, l'image CASH est déjà décodée.
    // Garde incluse (splash actif → rien) : le START qui suit l'ouverture
    // d'onglet est absorbé sans re-tirage. Le tirage repos reste au STOP (v2).
    startSession = (origin) => {
      if (loadingLayer.hasAttribute('bgzen-active')) return false;
      clearTimeout(unmaskTimer); // reveal différé annulé : nouvelle session
      // (05/09 : grâce supprimée — le splash CASH opaque frame 0 rend le
      // re-tirage propre à chaque session ; l'anti double-image vit
      // désormais dans le roulement séquentiel, chaque image 1× par tour.)
      const detail = lastRevealAt ? ` (reveal il y a ${Math.round(Date.now() - lastRevealAt)}ms)` : ' (première session)';
      dbg(`🎬 SESSION ${origin} — tirage${detail}`);
      const activate = (msg) => {
        loadingLayer.setAttribute('bgzen-active', '');
        dbg(`   ${msg}`);
        // Masque sur l'ANCÊTRE STABLE #tabbrowser-tabpanels (§5) — jamais
        // sur .browserSidebarContainer.deck-selected : sur une nav en nouvel
        // onglet, la session part AVANT le switch du deck → l'ancien
        // querySelector masquait le container quitté, le nouveau (non
        // masqué) peignait par-dessus le splash dès son premier paint
        // (covering précoce, 05/09). L'ancêtre couvre tous les containers,
        // quel que soit le timing du switch.
        document.getElementById('tabbrowser-tabpanels')?.setAttribute('bgzen-loading', '');
      };
      if (Resolver.applyLoading()) {
        activate(`▶️ SPLASH ACTIF CASH (opaque 0s + de-blur ${CONFIG.enterMs}ms)`);
      } else {
        Resolver.resolveLoading().then(() => activate('▶️ SPLASH ACTIF (cash manqué → fade + de-blur)'));
      }
      return true;
    };

    const listener = {
      onStateChange(browser, webProgress, request, stateFlags, status) {
        try {
          // NOTE : pas de filtre STATE_IS_NETWORK — dans ce build les
          // events top-level n'ont pas ce flag (testé : ça tuait le splash).
          if (!webProgress?.isTopLevel) {
            dbgV(`non top-level — ignoré ${safeUrl(request, browser)}`);
            return;
          }
          if (browser !== gBrowser.selectedBrowser) {
            dbgV(`tab non sélectionné — ignoré ${safeUrl(request, browser)}`);
            return;
          }

          const WPL = Ci.nsIWebProgressListener;
          const kind = stateFlags & WPL.STATE_START ? 'START' : 'STOP';
          const url = safeUrl(request, browser);

          // Ligne d'ancrage : une seule par event top-level. Le cycle
          // complet se lit verticalement : 🌐 START → 🎬 SESSION → 🌐 STOP
          // → TIRAGE repos → ✅ REVEAL → prefetch.
          dbg(`🌐 ${kind} ${url}`);
          const panels = document.getElementById('tabbrowser-tabpanels'); // masque §5 (ancêtre stable)

          if (stateFlags & WPL.STATE_START) {
            clearTimeout(unmaskTimer);
            dbgV('reveal timer ANNULÉ (START)');

            // Garde de session + activation via startSession (partagé avec
            // TabSelect). Splash déjà actif (redirect, reload, tab fraîche
            // déjà couverte) → on ne touche à RIEN : zéro flash, zéro 2e image.
            // Pas de tirage repos ici (v2) : le STOP de session tire, couvert.
            if (!startSession?.('START')) dbg('↳ START ignoré — session en cours (splash actif)');
          }

          if (stateFlags & WPL.STATE_STOP) {
            clearTimeout(unmaskTimer);
            // ⚠️ Fix flash 04/09 v2 : tirage repos ICI — le splash est
            // encore actif (reveal à 1000ms), la couche couvre tout.
            // Le nouveau fonds se pose dessous + warm-up décodage, et le
            // fade de sortie du reveal le révèle en crossfade natif.
            // Zéro fenêtre de paint parasite possible.
            Resolver.resolveRest(getDomain(browser));
            // Au boot en press start : le reveal se joue DERRIÈRE le
            // splash full-UI (invisible) → cd boot dédié (test 0),
            // barTotalMs intact pour les navigations normales.
            const cd = BootSplash.waitMode && !BootSplash.done ? CONFIG.bootRevealCdMs : CONFIG.barTotalMs;
            unmaskTimer = setTimeout(() => {
              loadingLayer.removeAttribute('bgzen-active'); // fade + blur sortant
              panels?.removeAttribute('bgzen-loading'); // reveal
              lastRevealAt = Date.now();
              dbg(`✅ REVEAL (fin anim ${CONFIG.exitMs}ms)`);
              BootSplash.finish('1er REVEAL'); // boot splash : on rend la main à l'UI
              // Pré-tirage de la prochaine image : warmTexture attend le
              // transitionend du fade (event-driven) avant de poser la
              // var → crossfade intact, texture GPU chauffée juste après.
              Resolver.prefetchLoading();
            }, cd);
            dbg(`   reveal dans ${cd}ms`);
          }
        } catch (ex) {
          dbg(`‼️ EXCEPTION onStateChange: ${ex.message}`);
          console.error('[BG-Zen] onStateChange:', ex);
        }
      },
      onProgressChange() {},
      onLocationChange() {},
      onStatusChange() {},
      onSecurityChange() {},
      onContentBlockingEvent() {},
    };

    gBrowser.addTabsProgressListener(listener);
  }

  /* (v0.7.5 — épluchage) setupTabSelect et setupLoadURIHook SUPPRIMÉS :
   * - setupTabSelect était le DOUBLON event de setupTabSelObserver (même
   *   logique fraîche/loading, mais APRÈS le MO en réactivité) → fusion.
   * - setupLoadURIHook (wrappers gBrowser.loadURI/fixupAndLoadURIString)
   *   était MORT : preuve par le source Zen (URILoadingHelper.sys.mjs
   *   appelle TOUJOURS targetBrowser.fixupAndLoadURIString — own prop du
   *   <browser> — jamais gBrowser.* ; et gBrowser.loadURI ne fait que
   *   forward vers selectedBrowser → déjà couvert par le hook browser).
   *   Logs wcek/wewb : zéro ⏱️ en des sessions entières. */

  /* ---------- Fix flash : wrappers sur CHAQUE <browser> (LE choke point) ----------
   * Preuve par le source Zen (browser/omni.ja, 05/09) :
   * - URILoadingHelper.sys.mjs openInCurrentTab() appelle
   *   targetBrowser.fixupAndLoadURIString() — la méthode OWN du <browser>,
   *   JAMAIS gBrowser.* (d'où zéro ⏱️ dans les logs wcek/wewb).
   * - Les browsers LAZY portent des substitute properties (tabbrowser.js
   *   l.841-844) déjà fonctionnelles (binds URILoadingWrapper) : on les
   *   wrappe aussi — une nav sur une tab non liée passe par elles.
   * - ⚠️ _insertBrowser (l.3102-3107) DELETE toutes les substitutes puis
   *   repose des binds propres (l.3148-3156) → tout wrapper posé avant
   *   est DÉTRUIT au link. C'est ce qui tuait le hook sur les tabs
   *   fraîchement liées (log w69a : nav YouTube sans BrowserNav).
   * Solution : marqueur SUR LE WRAPPER (pas sur le browser — les props
   * sont remplacées, le browser survit) + wrap de gBrowser._insertBrowser
   * pour re-patcher à l'exact moment où les binds sont reposés, AVANT
   * le chargement initial de la tab (fixup l.4587). */
  function setupBrowserNavHook() {
    const patch = (b) => {
      if (!b) return;
      for (const name of ['fixupAndLoadURIString', 'loadURI']) {
        const orig = b[name];
        if (typeof orig !== 'function') continue;
        if (orig.__bgzenNavHook) continue; // déjà à nous
        const wrapped = function (...args) {
          try {
            if (!(BootSplash.waitMode && !BootSplash.done)) {
              // DIAG (05/09) : log inconditionnel — le pass-through silencieux
              // nous aveuglait quand la session était déjà couverte par TabSelect.
              const target = String(args[0] instanceof Ci.nsIURI ? args[0].spec : args[0]).slice(0, 60);
              if (startSession?.('BrowserNav')) dbg(`   ⏱️ ${name}(${target}) → splash POSÉ`);
              else dbgV(`${name}(${target}) — pass-through (session déjà active)`);
            }
          } catch {
            /* le hook ne doit JAMAIS casser la nav */
          }
          return orig.apply(b, args);
        };
        wrapped.__bgzenNavHook = true; // marqueur fonction : résiste au delete/repose des props
        try {
          Object.defineProperty(b, name, { value: wrapped, writable: true, configurable: true });
        } catch { /* browser figé → skip */ }
      }
    };
    for (const t of gBrowser.tabs) patch(t.linkedBrowser); // tabs déjà liées + substitutes lazy
    gBrowser.tabContainer.addEventListener('TabOpen', (e) => patch(e.target.linkedBrowser));
    gBrowser.tabContainer.addEventListener('TabSelect', (e) => patch(e.target.linkedBrowser)); // filet swap/re-link
    // Re-patch au moment EXACT du link : _insertBrowser repose les binds
    // (notre wrapper d'avant est détruit) et le chargement initial suit
    // immédiatement — aucun event intermédiaire n'existe entre les deux.
    const origInsert = gBrowser._insertBrowser.bind(gBrowser);
    gBrowser._insertBrowser = function (aTab, ...rest) {
      const r = origInsert(aTab, ...rest);
      try { patch(aTab?.linkedBrowser); } catch { /* jamais casser le link */ }
      return r;
    };
  }

  /* ---------- Fix flash : MutationObserver sur l'attribut selected ----------
   * Cas CustomTab→YouTube (05/09) : clic lien content-side (raccourci de
   * la page d'accueil) → nouvel onglet VIDE/transparent → deck switch →
   * le paint du deck transparent peut être commité AVANT le dispatch de
   * TabSelect → 1-2 frames de bg visibles. L'attribut "selected" est
   * posé sur le tab AVANT le switch visuel (updateSelectedTab) : un
   * MutationObserver réagit en MICROTASK — avant le prochain frame,
   * donc avant le paint du deck → splash CASH posé à temps.
   * Pattern NavBtn/Nebula observePresence : event-driven, zéro polling.
   * Garde : même logique fraîche/loading que l'ancien setupTabSelect
   * (v0.7.5 : event fusionné ICI — le MO tire en microtask, AVANT le
   * paint du deck switch ET avant le dispatch de TabSelect). */
  function setupTabSelObserver() {
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type !== 'attributes' || m.attributeName !== 'selected') continue;
        if (!m.target.hasAttribute('selected')) continue;
        const b = m.target.linkedBrowser;
        if (!b || b.webProgress?.isLoadingDocument || getDomain(b) === '') {
          if (BootSplash.waitMode && !BootSplash.done) return; // boot splash couvre déjà
          if (!startSession?.('TabSelMO')) dbgV('TabSelMO — session déjà en cours');
        } else {
          Resolver.resolveRest(getDomain(b)); // tab chargée : tirage live voulu
        }
        return; // un seul selected par switch
      }
    });
    mo.observe(gBrowser.tabContainer, { attributes: true, attributeFilter: ['selected'], subtree: true });
  }

  /* ---------- Fix flash : TabAttrModified + attribut busy ----------
   * Pattern NavBtn exact : on écoute l'ÉVÉNEMENT tabbrowser, pas nos
   * propres progress listeners. Preuve log wcek (04/09) : la nav
   * YouTube a produit un STOP SANS START chez nous (garde
   * selectedBrowser filtrée en silence via dbgV) alors que tabbrowser,
   * lui, avait tout reçu et posé `busy` sur le tab. L'attribut busy
   * est posé par le progress listener INTERNE de tabbrowser quel que
   * soit l'appelant de la nav (favori, mod, extension, urlbar, session
   * restore) → un seul listener couvre tous les chemins. L'event tire
   * en rafale pendant les chargements : la garde de startSession
   * (splash actif → return false) court-circuite en 1 check.
   * Perf NavBtn : le check selectedTab (le plus souvent gagnant) en
   * premier court-circuite la rafale des tabs en background. */
  function setupBusyListener() {
    gBrowser.tabContainer.addEventListener('TabAttrModified', (e) => {
      try {
        if (BootSplash.waitMode && !BootSplash.done) return; // boot splash couvre déjà tout
        if (e.target !== gBrowser.selectedTab) return; // rafale background → exit
        if (!e.target.hasAttribute('busy')) return; // attr retiré/autre → exit
        if (startSession?.('Busy')) dbg('   ⏱️ busy posé par tabbrowser → splash immédiat');
      } catch {
        /* jamais casser l'event natif */
      }
    });
  }

  /* ---------- Init ---------- */

  function init() {
    if (window.__bgZenLoaded) return;
    if (!window.gBrowser || !gBrowser.tabContainer) {
      setTimeout(init, 500);
      return;
    }
    window.__bgZenLoaded = true;

    // Reset du log à chaque session de navigation : seule la fenêtre
    // de démarrage (aucune autre fenêtre ouverte) tronque le fichier —
    // les fenêtres Ctrl+N s'appendent avec leur WTAG, elles ne
    // wipe pas la session en cours. Reset mémoire + disque AVANT le
    // header : zéro course possible (aucun dbg n'a encore flushé).
    if (BootSplash.isStartupWindow()) {
      logCache = '';
      logQueue = [];
      IOUtils.writeUTF8(LOG_FILE, '').catch((ex) => console.error('[BG-Zen] reset log impossible:', ex.message));
    }

    const layers = createLayers();
    if (!layers) {
      log('ERREUR — #main-window introuvable');
      return;
    }

    dbg(`══════ BG-Zen v0.7.5 — fenêtre ${WTAG} — debug ${CONFIG.debug ? 'ACTIF' : 'off'} ══════`);
    dbg(`CONFIG enter=${CONFIG.enterMs}ms exit=${CONFIG.exitMs}ms bar=${CONFIG.barTotalMs}ms verbose=${CONFIG.debugVerbose}`);

    // Pré-tirage de la 1ère image de loading : invisible pendant le
    // boot (le pan boot.jpg couvre tout), mais CASH pour la 1ère
    // navigation d'après le reveal.
    Resolver.resolveRest(getDomain(gBrowser.selectedBrowser)).then(() => Resolver.prefetchLoading());
    loadingLayerEl = layers.loading; // warmTexture (fix flash texture GPU)
    setupProgress(layers.loading);
    setupBrowserNavHook(); // flash : choke point — own props fixupAndLoadURIString/loadURI sur chaque <browser>
    setupTabSelObserver(); // flash : attribut selected via MutationObserver — AVANT le paint du deck switch
    setupBusyListener(); // flash : attribut busy (event tabbrowser, pattern NavBtn) — filet pour les navs hors hook
    Sidebar.geometry(); // 1er calcul (image de la session en cours)
    window.addEventListener('resize', () => Sidebar.geometry()); // event-driven, jamais de re-tirage
    // Boot splash : uniquement sur la fenêtre de démarrage. Les
    // fenêtres ouvertes en cours de session (Ctrl+N) passent direct
    // en mode nav — attribut posé avant le 1er paint, aucun flash.
    if (BootSplash.isStartupWindow()) BootSplash.install();
    else document.getElementById('main-window')?.setAttribute('bgzen-booted', '');
    log('init v0.7.5 — épluchage : hook gBrowser supprimé (mort, preuve source), TabSelect fusionné dans TabSelMO, logging batché par task');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
