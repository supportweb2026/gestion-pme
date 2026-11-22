# Charte graphique Gestia

## Logos

| Fichier | Usage |
| --- | --- |
| `gestia-logo-original.png` | Fichier source fourni |
| `gestia-logo.png` | Logo complet avec slogan, fond transparent, sur fond clair |
| `gestia-logo-blanc.png` | Logo complet pour fond sombre (icône sur pastille blanche, texte blanc) |
| `gestia-logo-sans-slogan.png` | En-tête d'application, signatures, petits formats |
| `gestia-logo-sans-slogan-blanc.png` | Idem, sur fond sombre |
| `gestia-texte.png` | Mot GESTIA seul |
| `gestia-icone.png` | Icône seule, fond transparent |
| `gestia-icone-fond-sombre.png` | Icône sur pastille blanche, pour fonds sombres ou colorés |
| `icon-512.png`, `icon-192.png` | Icônes d'application (Android, ordinateur) |
| `icon-maskable-512.png` | Icône Android adaptative (zone de sécurité respectée) |
| `apple-touch-icon.png` | Icône iPhone / iPad (fond blanc) |
| `favicon.ico`, `favicon-32.png` | Onglet du navigateur |
| `og-image.png` | Aperçu des liens partagés (WhatsApp, e-mail, réseaux) 1200 × 630 |

Ne pas déformer, recolorer ni poser l'icône bleue directement sur un fond bleu ou sombre :
utiliser alors la version sur pastille blanche.

## Couleurs

| Nom | Hex | Usage |
| --- | --- | --- |
| Nuit Gestia | `#101D36` | Texte principal, mot GESTIA, fonds sombres |
| Bleu Gestia | `#0255C6` | Couleur d'action (boutons, liens, accents), triangle du A |
| Bleu clair | `#0386FB` | Haut du dégradé de l'icône, mises en valeur |
| Bleu profond | `#04347D` | Ombre de l'icône, informations |
| Ardoise | `#36445F` | Slogan, textes secondaires |
| Fond | `#F5F7FB` | Fond des écrans |

Dégradé de l'icône : `#0386FB` → `#0255C6` → `#04347D`.

## Typographie

- **Montserrat** (police de la marque) : titres de page et de carte, Bold / SemiBold.
- **Manrope** : textes de l'interface, tableaux et montants (chiffres tabulaires). Plus étroite que
  Montserrat, elle garde les montants en FCFA lisibles dans les colonnes.
- Repli : police système.

## Interface (système de design)

Les jetons sont en tête de `src/web/styles.css` :

- fond des pages blanc ; texte `#101D36` ; textes secondaires `#3B4760` et `#5B6579` (contraste ≥ 5,9:1) ;
- une seule couleur d'action, le bleu Gestia `#0255C6` (boutons principaux, liens, menu actif sur fond `#EDF3FD`) ;
- états : brouillon gris, à encaisser bleu, partiellement payée ambre, payée vert, en retard rouge ;
- modules pas encore ouverts : groupe « Bientôt disponible » et pastille bleue « Bientôt » ;
- logo : toujours en hauteur fixe (26 px dans le menu, 40 px à la connexion), largeur proportionnelle ;
  sur téléphone, l'icône seule (28 px) suivie du nom de l'entreprise.
