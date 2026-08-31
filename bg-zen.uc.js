// ==UserScript==
// @name           BG-Zen
// @version        0.2.0
// @description    Wallpaper derrière l'UI de Zen — pools repos/loading, glass constant, splash
// @author         Impre
// @include        main
// ==/UserScript==

/* Roadmap v2 — point 1 (SPEC.md) :
   - Deux pools : backgrounds/ (repos) + loadings/ (loading screens)
   - Deux couches superposées dans #main-window (isolation en CSS §0) :
     #bgzen-layer          → repos, glass CONSTANT (10px, CONFIG)
     #bgzen-loading-layer  → loading screen nette, fade/blur en sortie (CSS)
   - Le listener ne touche plus au blur : il toggle bgzen-active sur la
     couche loading + bgzen-loading sur le wrapper (masquage §5).
   - Re-tirage repos UNIQUEMENT si domaine change (décision 30/08).
   ⚠️ JAMAIS de background-image sur #main-window (bug transparence).
   ⚠️ Toujours PathUtils.toFileURI (newURI = backslashes → escapes CSS). */

(function () {
    'use strict';

    const CONFIG = {
        restBlurPx: 10,   // glass constant au repos
        exitMs: 400,      // anim de sortie de la couche loading (pt 5)
        barTotalMs: 850,  // synchro MyLoadingBar (150 + 400 + 300)
        imageExts: ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.jxl', '.svg'],
    };

    const MOD_DIR = PathUtils.join(PathUtils.profileDir, 'chrome', 'sine-mods', 'BG-Zen');
    const BG_DIR = PathUtils.join(MOD_DIR, 'backgrounds');
    const LD_DIR = PathUtils.join(MOD_DIR, 'loadings');
    const REST_LAYER_ID = 'bgzen-layer';
    const LD_LAYER_ID = 'bgzen-loading-layer';

    function log(...args) { console.log('[BG-Zen]', ...args); }

    /* ---------- WallpaperResolver ---------- */

    const Resolver = {
        currentDomain: null,
        lastRest: null,
        lastLoading: null,

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
            if (domain === this.currentDomain) return; // zéro flash intra-site
            const file = this.pick(await this.listImages(BG_DIR), this.lastRest);
            if (!file) {
                log('pool backgrounds/ vide — image inchangée');
                return; // on ne mémorise pas le domaine → retry possible
            }
            this.currentDomain = domain;
            this.lastRest = file;
            this.setVar('--bgzen-image', file);
        },

        async resolveLoading() {
            let file = this.pick(await this.listImages(LD_DIR), this.lastLoading);
            if (file) {
                this.lastLoading = file;
            } else {
                file = this.lastRest; // fallback : pool vide → image repos
                if (!file) return;
            }
            this.setVar('--bgzen-loading-image', file);
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
        return { rest, loading };
    }

    /* ---------- SplashController ---------- */

    function getDomain(browser) {
        try { return browser.currentURI?.host ?? ''; } catch { return ''; }
    }

    function setupProgress(loadingLayer) {
        let unmaskTimer = null; // LAST RESORT: reveal différé = synchro barre (barTotalMs)

        const listener = {
            onStateChange(browser, webProgress, request, stateFlags) {
                if (!webProgress?.isTopLevel) return;
                if (browser !== gBrowser.selectedBrowser) return;

                const container = document.querySelector(
                    '.browserSidebarContainer.deck-selected');

                if (stateFlags & Ci.nsIWebProgressListener.STATE_START) {
                    clearTimeout(unmaskTimer);
                    Resolver.resolveLoading().then(() => {
                        loadingLayer.setAttribute('bgzen-active', ''); // visible (entrée rapide)
                    });
                    Resolver.resolveRest(getDomain(browser)); // re-tirage si domaine change
                    container?.toggleAttribute('bgzen-loading', true); // wrapper masqué (§5)
                }

                if (stateFlags & Ci.nsIWebProgressListener.STATE_STOP) {
                    clearTimeout(unmaskTimer);
                    unmaskTimer = setTimeout(() => {
                        loadingLayer.removeAttribute('bgzen-active'); // fade + blur sortant
                        container?.toggleAttribute('bgzen-loading', false); // reveal
                    }, CONFIG.barTotalMs);
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

        Resolver.resolveRest(getDomain(gBrowser.selectedBrowser));
        setupProgress(layers.loading);
        setupTabSelect();
        log(`init v0.2.0 — pools backgrounds/ + loadings/, glass ${CONFIG.restBlurPx}px`);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') init();
    else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
