// ==UserScript==
// @name           BG-Zen
// @version        0.1.0
// @description    Wallpaper derrière l'UI de Zen — couche dédiée, blur dynamique, splash de chargement
// @author         Impre
// @include        main
// ==/UserScript==

/* Architecture validée 30/08 (voir SPEC.md) :
   - Le wallpaper vit sur une COUCHE DÉDIÉE #bgzen-layer (z-index:-1) dans
     #main-window rendu stacking context par isolation (règle dans chrome.css).
   - ⚠️ JAMAIS de background-image sur #main-window : ça casse l'opacité de
     compositing de la fenêtre (transparence visible à travers certaines pages).
   - Blur inversé (idée #5) : NET pendant le chargement, FLOU au repos.
   - Splash : attribut bgzen-loading sur .browserSidebarContainer.deck-selected,
     masqué par chrome.css, reveal synchronisé sur la fin de la barre MyLoadingBar
     (150 debounce + 400 hold + 300 fade = 850ms). */

(function () {
    'use strict';

    const CONFIG = {
        image: 'BG_Zen.png',   // fichier wallpaper, à la racine du mod
        blurPx: 24,            // intensité du flou au repos
        transitionMs: 500,     // durée transition net <-> flou
        barTotalMs: 850,       // synchro MyLoadingBar (150+400+300)
    };

    const MOD_DIR = PathUtils.join(PathUtils.profileDir, 'chrome', 'sine-mods', 'BG-Zen');
    const LAYER_ID = 'bgzen-layer';

    function log(...args) { console.log('[BG-Zen]', ...args); }

    function createLayer() {
        const mw = document.getElementById('main-window');
        if (!mw) return null;
        document.getElementById(LAYER_ID)?.remove();

        // URL absolue du wallpaper — posée en var CSS pour que chrome.css
        // l'utilise partout (couche + glass hover §3). Ne dépend pas de
        // la résolution d'URL relative de la feuille.
        const imgURL = Services.io.newURI(PathUtils.join(MOD_DIR, CONFIG.image)).spec;
        document.documentElement.style.setProperty('--bgzen-image', `url("${imgURL}")`);
        document.documentElement.style.setProperty('--bgzen-blur', `${CONFIG.blurPx}px`);

        // La couche est stylée par chrome.css (position, z-index, image, blur
        // par défaut). Inline : rien — le listener pilote uniquement filter.
        const layer = mw.appendChild(document.createElement('div'));
        layer.id = LAYER_ID;
        return layer;
    }

    function setupProgress(layer) {
        let unmaskTimer = null;

        const listener = {
            onStateChange(browser, webProgress, request, stateFlags) {
                if (!webProgress?.isTopLevel) return;
                if (browser !== gBrowser.selectedBrowser) return;

                const container = document.querySelector(
                    '.browserSidebarContainer.deck-selected');

                if (stateFlags & Ci.nsIWebProgressListener.STATE_START) {
                    clearTimeout(unmaskTimer);
                    layer.style.filter = 'blur(0px)';                  // NET pendant le chargement
                    container?.toggleAttribute('bgzen-loading', true); // splash masqué (chrome.css §5)
                }

                if (stateFlags & Ci.nsIWebProgressListener.STATE_STOP) {
                    clearTimeout(unmaskTimer);
                    unmaskTimer = setTimeout(() => {
                        layer.style.filter = `blur(${CONFIG.blurPx}px)`;   // FLOU au repos
                        container?.toggleAttribute('bgzen-loading', false); // reveal sync barre
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

    function init() {
        if (window.__bgZenLoaded) return;
        if (!window.gBrowser || !gBrowser.tabContainer) { setTimeout(init, 500); return; }
        window.__bgZenLoaded = true;

        const layer = createLayer();
        if (!layer) { log('ERREUR — #main-window introuvable'); return; }
        setupProgress(layer);
        log(`init OK — ${CONFIG.image}, blur ${CONFIG.blurPx}px, synchro barre ${CONFIG.barTotalMs}ms`);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') init();
    else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
