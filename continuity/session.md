# Session du 10/10

## État courant
Refonte de la continuité BG-Zen faite (roadmap legacy archivée, nouvelle file
10 points — ⭐ splash adaptatif). Doc transverse `Zen-Modes-Affichage.md`
écrite et validée. Découverte majeure : Nebula-Fork déjà désactivé → §3 glass
sidebar de BG-Zen mort (régression silencieuse, bascule utopia-* listée pt 2,
non prioritaire selon Impre). **Question ouverte : quel « point 3 » Impre veut
fixer en premier** (CustomTab de l'ancienne file ? autre ?) — l'étoile de la
file est sur le splash adaptatif en attendant sa réponse.

## Journal
- [doc] `.md/Zen-Modes-Affichage.md` rédigé + validé (layouts = 2 prefs, compact, sidebar, scoping) — hors git (dossier .md non versionné)
- [discovery] `Utopia/continuity/discovery_Utopia.md` créé — U-D1 toggle teinte voile
- [constat] mods.json : Nebula-Fork OFF / Utopia ON → §3 BG-Zen mort (nebula-compact-mode plus posé)
- [registre] BG-Zen : continuity/ créé, roadmap_BGZen.md refondue **v2 (après correction Impre)** : uniquement les 3 features produit + travaux techniques ; les anciens objectifs de file restent EXCLUSIVEMENT dans l'archive `_legacy`
- [feature] v0.8.0-wip **splash adaptatif** livré et validé live (`dd8853a`) : zone-contenu si sidebar visible (::before + teinte noire), plein-fenêtre si masquée — JS inchangé
- [workflow] **Régime v2 acté** : le repo vit dans l'install (migration BG-Zen `dd8853a`, historique préservé, source archivée `BG-Zen.archived-2026-10-10`) ; skill sine-workflow + règle navigateur-workspace réécrits. Push restant à la décision d'Impre
- [divers] dossier source résiduel `Sine-Mods/BG-Zen/continuity/` (vide) tenu par un process (VSCode ?) — à supprimer à la fermeture/reboot
- [fix] v0.8.1 vieux bug splash figé (switch pendant chargement) tué : reveal à distance + filet + TabClose (`592b4cd`) — validé live par Impre
