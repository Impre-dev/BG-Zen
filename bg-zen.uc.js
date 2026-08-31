// ==UserScript==
// @name           BG-Zen
// @version        0.6.0
// @description    Wallpaper derrière l'UI de Zen — pools repos/loading, glass constant, splash
// @author         Impre
// @include        main
// ==/UserScript==

/* Roadmap v2 — points 1/2/5 + debug (SPEC.md) :
   - Deux pools : backgrounds/ (repos) + loadings/ (loading screens)
   - Deux couches superposées dans #main-window (isolation en CSS §0)
   - Garde de session : un START pendant un splash actif (redirect,
     reload) ne re-tirage rien → zéro flash, zéro 2e image.
   - Grâce stabilizeMs : pas de re-tirage loading juste après un reveal.
   - Entrée animée (fade + de-blur, miroir de la sortie).
   - Logs debug dans bgzen-debug.log (CONFIG.debug).
   ⚠️ JAMAIS de background-image sur #main-window (bug transparence).
   ⚠️ Toujours PathUtils.toFileURI (newURI = backslashes → escapes CSS).
   ⚠️ request.name (nsIRequest) peut lever NOT_IMPLEMENTED → toujours
   le lire dans un try/catch dédié (leçon 31/08 : ça tuait le splash). */

(function () {
    'use strict';

    const CONFIG = {
        restBlurPx: 10,    // glass constant au repos
        enterMs: 300,      // anim d'ENTRÉE de la couche loading (fade + de-blur)
        exitMs: 400,       // anim de sortie de la couche loading (pt 5)
        barTotalMs: 1000,  // barre (850) + 150ms de grâce paint : le contenu
                           // a le temps d'être affiché avant le reveal
        stabilizeMs: 2000, // pas de re-tirage loading si reveal < 2s (anti double-image)
        bootFadeMs: 600,   // fade de sortie du boot splash (pseudo ::after CSS §6)
        bootTimeoutMs: 15000, // LAST RESORT : filet si aucun STOP ne survient jamais
        bootTitle: ['Welcome to', 'a calmer internet'], // fallback si pas de citation en cache
        bootQuote: true,   // citation aléatoire en phrase d'accueil (citation.lecog.fr, cache local)
        quoteUrl: 'https://citation.lecog.fr/public/api/random-quote.php',
        bootMinMs: 2500,   // durée MINIMALE du boot splash — l'anim a le temps de vivre
        bootWaitSkipShort: false, // false → "press start" sur TOUTES les citations
                           // (défaut, 31/08). true → seules les longues
                           // (> bootWaitThreshold) attendent l'input.
        bootWaitThreshold: 180, // seuil "longue" (chars) si bootWaitSkipShort
                           // (game pur : attente input, aucun failsafe)
        debug: true,       // logs fichier (bgzen-debug.log) — false en prod
        imageExts: ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.jxl', '.svg'],
    };

    const MOD_DIR = PathUtils.join(PathUtils.profileDir, 'chrome', 'sine-mods', 'BG-Zen');
    const BG_DIR = PathUtils.join(MOD_DIR, 'backgrounds');
    const LD_DIR = PathUtils.join(MOD_DIR, 'loadings');
    const QUOTE_FILE = PathUtils.join(MOD_DIR, 'boot', 'quote.json'); // cache runtime → gitignore
    const REST_LAYER_ID = 'bgzen-layer';
    const LD_LAYER_ID = 'bgzen-loading-layer';

    function log(...args) { console.log('[BG-Zen]', ...args); }

    /* ---------- Log debug fichier ---------- */
    // Tout l'enchaînement chargement atterrit dans bgzen-debug.log
    // (réinitialisé à chaque session). ⚠️ data runtime → gitignoré.
    // Écritures sérialisées (chaîne de promesses) + dbg blindé :
    // le logging ne peut JAMAIS casser l'appelant.
    const LOG_FILE = PathUtils.join(MOD_DIR, 'bgzen-debug.log');
    const logLines = [];
    let writeChain = Promise.resolve();

    function writeLog(line) {
        logLines.push(line);
        writeChain = writeChain
            .then(() => IOUtils.writeUTF8(LOG_FILE, logLines.join('\n') + '\n'))
            .catch(ex => console.error('[BG-Zen] écriture log impossible:', ex.message));
    }

    function dbg(...args) {
        if (!CONFIG.debug) return;
        try {
            writeLog(`${new Date().toISOString()} ${args.join(' ')}`);
        } catch { /* le logging ne doit JAMAIS casser l'appelant */ }
    }

    // ⚠️ request.name (nsIRequest) lève NOT_IMPLEMENTED quasi systématiquement
    // dans ce contexte — l'optional chaining ne protège PAS d'une exception de
    // getter. Fallback : l'URI courante du browser.
    function safeUrl(request, browser) {
        try {
            const n = request?.name;
            if (n) return String(n).slice(0, 60);
        } catch { /* NOT_IMPLEMENTED → fallback */ }
        try {
            return browser?.currentURI?.spec?.slice(0, 60) ?? '(?)';
        } catch { return '(?)'; }
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
                return entries.filter(p =>
                    CONFIG.imageExts.some(e => p.toLowerCase().endsWith(e)));
            } catch (ex) {
                log('listImages erreur:', ex.message);
                return [];
            }
        },

        pick(files, exclude) {
            if (!files.length) return null;
            let pool = files;
            if (files.length > 1 && exclude) {
                pool = files.filter(f => f !== exclude); // anti-répétition
            }
            return pool[Math.floor(Math.random() * pool.length)];
        },

        setVar(name, file) {
            document.documentElement.style.setProperty(name, `url("${PathUtils.toFileURI(file)}")`);
        },

        async resolveRest(domain) {
            if (domain === this.currentDomain) {
                dbg('resolveRest SKIP — même domaine:', domain || '(vide)');
                return; // zéro flash intra-site
            }
            const file = this.pick(await this.listImages(BG_DIR), this.lastRest);
            if (!file) {
                dbg('resolveRest — pool backgrounds/ VIDE, image inchangée');
                return; // on ne mémorise pas le domaine → retry possible
            }
            dbg(`resolveRest TIRAGE [${domain || '(vide)'}] →`, file.split('\\').pop());
            this.currentDomain = domain;
            this.lastRest = file;
            this.setVar('--bgzen-image', file);
        },

        // Fallback async (cash manqué) : tirage au START, activation en .then.
        async resolveLoading() {
            let file = this.pick(await this.listImages(LD_DIR), this.lastLoading);
            if (!file) {
                file = this.lastRest; // fallback : pool vide → image repos
                if (!file) { dbg('resolveLoading — aucun fichier dispo'); return; }
            }
            this.setVar('--bgzen-loading-image', file);
            this.lastLoading = file;
            dbg('resolveLoading →', file.split('\\').pop());
        },

        // Pré-tirage (au reveal + à l'init) : choisit l'image de la
        // PROCHAINE session sans toucher à la var — le fade de sortie
        // n'est jamais écrasé. Au START suivant : switch cash synchrone.
        // + warm-up décodage : une image non décodée peint VIDE — sans
        // ça, la couche opaque frame 0 laisse transparaître le repos
        // quelques frames ("parfois ça marche" = bitmap déjà en cache).
        async prefetchLoading() {
            const file = this.pick(await this.listImages(LD_DIR), this.lastLoading);
            if (!file) { dbg('prefetch — pool vide, pas de pré-tirage'); return; }
            this.nextLoading = file;
            dbg('prefetchLoading PROCHAINE →', file.split('\\').pop());
            try {
                const img = new Image();
                img.src = PathUtils.toFileURI(file);
                await img.decode(); // bitmap prête en cache pour le START
                dbg('prefetch bitmap DÉCODÉE →', file.split('\\').pop());
            } catch (ex) { dbg('prefetch decode échec:', ex.message); }
        },

        // Switch CASH au START : var posée en synchrone, retour du fichier.
        // ⚠️ JAMAIS de fallback lastRest ici (leçon 31/08 : l'ancienne
        // version affichait l'image repos dans la couche loading → le
        // symptôme "on voit le bg permanent" venait de LÀ). Si rien n'est
        // prêt on rend null → l'appelant retombe sur le tirage async.
        applyLoading(fresh) {
            const file = fresh ? this.nextLoading : this.lastLoading;
            if (!file) return null;
            this.setVar('--bgzen-loading-image', file);
            if (fresh) {
                this.lastLoading = file;
                this.nextLoading = null;
                dbg('applyLoading CASH →', file.split('\\').pop(), '(pré-tirée)');
            } else {
                dbg('applyLoading CASH →', file.split('\\').pop(), '(grâce — même image)');
            }
            return file;
        },
    };

    /* ---------- Couches ---------- */

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
            // Phrase d'accueil : citation CACHÉE LOCALEMENT (jamais de
            // réseau au boot — celle affichée a été prefetchée au boot
            // précédent). Pas de cache → texte CONFIG.bootTitle.
            const quote = CONFIG.bootQuote ? await this.loadQuote() : null;
            // Défensif : le cache peut contenir du HTML brut (leçon 31/08 —
            // l'API renvoie des <br /> dans les textes versifiés).
            const text = quote ? this.sanitizeText(quote.text) : null;
            const lines = text
                ? [text, `— ${quote.author}`]
                : CONFIG.bootTitle;
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
            this.guard = setTimeout(
                () => this.finish('FAILSAFE timeout'), CONFIG.bootTimeoutMs);
            dbg(quote
                ? `▶️ BOOT splash installé (citation de ${quote.author || 'anonyme'})`
                : '▶️ BOOT splash installé (texte défaut — pas de citation en cache)');
        },

        async loadQuote() {
            try {
                const q = await IOUtils.readJSON(QUOTE_FILE);
                if (q?.text) return q;
            } catch { /* pas de cache au 1er boot */ }
            return null;
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
                .split('\n').map(l => l.trim()).filter(Boolean)
                .join('\n')
                .trim();
        },

        // Pour le PROCHAIN boot : fetch lancé APRÈS le retrait du splash
        // (le réseau est plus lent que le boot — on ne l'attend jamais).
        // Event-chained, zéro polling, échec silencieux (cache conservé).
        prefetchQuote() {
            fetch(CONFIG.quoteUrl)
                .then(r => r.json())
                .then(j => {
                    if (!j?.success || !j.data?.text) throw new Error('réponse invalide');
                    const a = j.data.author ?? {};
                    const author = [a.forename, a.name].filter(Boolean).join(' ');
                    // ⚠️ tmpPath doit être ABSOLU (un simple nom de fichier
                    // → NS_ERROR_FILE_UNRECOGNIZED_PATH, leçon 31/08).
                    // On écrit déjà SANITIZÉ (le cache doit rester propre).
                    return IOUtils.writeJSON(QUOTE_FILE,
                        { text: this.sanitizeText(j.data.text), author },
                        { tmpPath: QUOTE_FILE + '.tmp' });
                })
                .then(() => dbg('cita préfetchée pour le prochain boot'))
                .catch(ex => dbg('cita prefetch échec:', ex.message ?? String(ex)));
        },

        // Anim d'entrée façon ZenWelcome.animateInitialStage : spring
        // stagger natif (stiffness 300 / damping 20 / mass 1.8).
        // Moteur absent/prêt trop tard → fallback keyframes CSS.
        animateIn() {
            try {
                const motion = window.gZenUIManager?.motion;
                if (!motion) throw new Error('motion indisponible');
                motion.animate(
                    '#bgzen-boot-title span',
                    { opacity: [0, 1], y: [20, 0], filter: ['blur(2px)', 'blur(0px)'] },
                    {
                        delay: motion.stagger(0.6, { startDelay: 0.2 }),
                        type: 'spring', stiffness: 300, damping: 20, mass: 1.8,
                    },
                ).then(
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
            const hold = Math.max(0, CONFIG.bootMinMs - (Date.now() - this.installAt));
            // Mode "press start" (game pur, validé 31/08) : citation longue
            // → le splash persiste jusqu'à un input utilisateur. Aucun
            // failsafe ici : l'input EST l'événement de sortie — même un
            // STOP perdu ne peut plus bloquer (n'importe quelle touche ferme).
            if (this.waitMode) {
                setTimeout(() => this.enterWait(), hold);
                dbg(`🕹️ BOOT waitMode — citation longue, attente input (${reason})`);
                return;
            }
            this.exitNow(reason, hold);
        },

        // Écran titre de jeu : hint pulsant en bas + one-shot keydown ET
        // mousedown — le premier input gagne, l'autre listener est retiré
        // (pas de double-fire). Le pseudo est pointer-events:none → les
        // clics traversent vers l'UI et bubblent quand même à window.
        enterWait() {
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
            this.prefetchQuote(); // citation du PROCHAIN boot — réseau post-splash
        },
    };

    /* ---------- SplashController ---------- */

    function getDomain(browser) {
        try { return browser.currentURI?.host ?? ''; } catch { return ''; }
    }

    function setupProgress(loadingLayer) {
        let unmaskTimer = null; // LAST RESORT: reveal différé = synchro barre (barTotalMs)
        let lastRevealAt = 0;   // anti double-image : pas de re-tirage juste après un reveal

        const listener = {
            onStateChange(browser, webProgress, request, stateFlags, status) {
              try {
                // NOTE : pas de filtre STATE_IS_NETWORK — dans ce build les
                // events top-level n'ont pas ce flag (testé : ça tuait le splash).
                if (!webProgress?.isTopLevel) {
                    dbg(`⤵️  non top-level — ignoré ${safeUrl(request, browser)}`);
                    return;
                }
                if (browser !== gBrowser.selectedBrowser) {
                    dbg(`⤵️  tab non sélectionné — ignoré ${safeUrl(request, browser)}`);
                    return;
                }

                const WPL = Ci.nsIWebProgressListener;
                const flags = [];
                if (stateFlags & WPL.STATE_START) flags.push('START');
                if (stateFlags & WPL.STATE_STOP) flags.push('STOP');
                if (stateFlags & WPL.STATE_IS_NETWORK) flags.push('NETWORK');
                if (stateFlags & WPL.STATE_IS_DOCUMENT) flags.push('DOC');
                if (stateFlags & WPL.STATE_IS_REQUEST) flags.push('REQ');
                const ts = new Date().toISOString().slice(11, 23);
                const url = safeUrl(request, browser);

                dbg(`${ts} 🌐 [${flags.join('|')}] ${url}`);
                const container = document.querySelector(
                    '.browserSidebarContainer.deck-selected');

                if (stateFlags & WPL.STATE_START) {
                    clearTimeout(unmaskTimer);
                    dbg(`${ts}    └ reveal timer ANNULÉ (START)`);

                    // Garde de session : si le splash est déjà actif (redirect
                    // example.com → customtab, reload), on ne touche à RIEN —
                    // pas de re-tirage, pas de re-entrée → zéro flash, zéro 2e image.
                    if (loadingLayer.hasAttribute('bgzen-active')) {
                        dbg(`${ts}    └ SESSION EN COURS — START ignoré (splash déjà actif)`);
                    } else {
                        const sinceReveal = Date.now() - lastRevealAt;
                        const fresh = sinceReveal > CONFIG.stabilizeMs;
                        const detail = lastRevealAt === 0
                            ? 'première session'
                            : `reveal il y a ${Math.round(sinceReveal)}ms`;
                        dbg(`${ts}    └ NOUVELLE SESSION — ${fresh
                            ? `tirage (${detail})`
                            : `grâce < ${CONFIG.stabilizeMs}ms — même image`}`);
                        // Switch CASH : image pré-tirée → var posée + couche
                        // OPAQUE en frame 0 (le repos n'est jamais visible),
                        // seul le de-blur anime. Cash manqué (1er nav, race)
                        // → fallback async avec fade, jamais d'image parasite.
                        if (Resolver.applyLoading(fresh)) {
                            loadingLayer.setAttribute('bgzen-active', '');
                            dbg(`${ts}    └ ▶️ SPLASH ACTIF CASH (opaque 0s + de-blur ${CONFIG.enterMs}ms)`);
                            container?.toggleAttribute('bgzen-loading', true); // wrapper masqué (§5)
                        } else {
                            Resolver.resolveLoading()
                                .then(() => {
                                    loadingLayer.setAttribute('bgzen-active', '');
                                    dbg(`${ts}    └ ▶️ SPLASH ACTIF (cash manqué → fade + de-blur)`);
                                    container?.toggleAttribute('bgzen-loading', true);
                                });
                        }
                    }
                    Resolver.resolveRest(getDomain(browser)); // re-tirage repos si domaine change
                }

                if (stateFlags & WPL.STATE_STOP) {
                    clearTimeout(unmaskTimer);
                    unmaskTimer = setTimeout(() => {
                        loadingLayer.removeAttribute('bgzen-active'); // fade + blur sortant
                        container?.toggleAttribute('bgzen-loading', false); // reveal
                        lastRevealAt = Date.now();
                        dbg(`✅ REVEAL (fin anim ${CONFIG.exitMs}ms)`);
                        BootSplash.finish('1er REVEAL'); // boot splash : on rend la main à l'UI
                        // Pré-tirage de la prochaine image — ne touche pas la
                        // var (fade de sortie intact), event-chained, zéro timer.
                        Resolver.prefetchLoading();
                    }, CONFIG.barTotalMs);
                    dbg(`${ts}    └ reveal programmé dans ${CONFIG.barTotalMs}ms`);
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

    function setupTabSelect() {
        gBrowser.tabContainer.addEventListener('TabSelect', () => {
            Resolver.resolveRest(getDomain(gBrowser.selectedBrowser));
        });
    }

    /* ---------- Init ---------- */

    function init() {
        if (window.__bgZenLoaded) return;
        if (!window.gBrowser || !gBrowser.tabContainer) { setTimeout(init, 500); return; }
        window.__bgZenLoaded = true;

        const layers = createLayers();
        if (!layers) { log('ERREUR — #main-window introuvable'); return; }

        dbg(`=== SESSION BG-Zen v0.6.0 — debug ${CONFIG.debug ? 'ACTIF' : 'off'} (fichier réinitialisé) ===`);
        dbg(`CONFIG enter=${CONFIG.enterMs}ms exit=${CONFIG.exitMs}ms bar=${CONFIG.barTotalMs}ms grâce=${CONFIG.stabilizeMs}ms`);

        // Pré-tirage de la 1ère image de loading : invisible pendant le
        // boot (le pan boot.jpg couvre tout), mais CASH pour la 1ère
        // navigation d'après le reveal.
        Resolver.resolveRest(getDomain(gBrowser.selectedBrowser))
            .then(() => Resolver.prefetchLoading());
        setupProgress(layers.loading);
        setupTabSelect();
        // Boot splash : uniquement sur la fenêtre de démarrage. Les
        // fenêtres ouvertes en cours de session (Ctrl+N) passent direct
        // en mode nav — attribut posé avant le 1er paint, aucun flash.
        if (BootSplash.isStartupWindow()) BootSplash.install();
        else document.getElementById('main-window')?.setAttribute('bgzen-booted', '');
        log('init v0.6.0 — boot splash full-UI + citation (sanitize HTML) + press start (attente input)');
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') init();
    else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
