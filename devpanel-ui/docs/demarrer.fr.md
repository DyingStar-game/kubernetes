# Tout installer depuis le début

Ce guide part d'une machine où **rien** n'est installé et t'amène jusqu'à entrer dans le monde du
jeu, sur ta propre machine. Compte une bonne heure, dont la majeure partie à attendre des
téléchargements.

Tu n'as besoin de rien connaître à Docker ou à Kubernetes : le panneau fait les gestes, et ce
guide te dit ce que chacun veut dire.

*English version: [getting-started.md](getting-started.md).*

## Ce qu'il te faut

| | Minimum | Confortable |
|---|---|---|
| Mémoire | 16 Go | 32 Go |
| Disque libre | 40 Go | 80 Go |
| Système | Windows 10 ou 11, ou Linux récent | |

Si ta machine a moins de 16 Go, la stack complète ne tiendra pas : parle-en à l'équipe, un
profil sans cluster local existe (éditeur et clients seulement).

## 1. Installer le panneau

1. Va sur la page **Releases** du dépôt `kubernetes` et prends le fichier de ton système :
   - Windows : `…-Setup-….exe` ;
   - Linux : `.AppImage` (toutes distributions), `.deb` (Debian, Ubuntu) ou `.rpm` (Fedora).
2. Lance-le.
   - **Windows affiche « Windows a protégé votre ordinateur »** : c'est normal, le programme
     n'est pas signé. Clique *Informations complémentaires*, puis *Exécuter quand même*.
   - AppImage : rends le fichier exécutable (`chmod +x`), puis lance-le. Si rien ne se passe sur
     un Ubuntu/Debian récent, installe FUSE 2 (`sudo apt install libfuse2`, `libfuse2t64` sur
     Ubuntu 24.04). Si une erreur « sandbox » apparaît (Ubuntu 24.04 restreint les user
     namespaces), prends plutôt le `.deb`, qui installe correctement l'aide de sandbox.

> Tant qu'aucune version n'est publiée sur la page Releases, pars des sources (ci-dessous).

Partir des sources : `git clone` du dépôt `kubernetes`, puis dans `devpanel-ui` :
`npm ci` et `npm start` (Node.js 20 ou plus). Il te faut alors git et Node.js avant de commencer.

## 2. L'assistant d'installation

Au premier lancement, l'écran **Installation** s'ouvre tout seul. Tu peux le rouvrir à tout
moment avec le bouton **⬇** en haut à droite.

Il liste cinq étapes. Chaque ligne montre une pastille :

- **verte** : c'est là, rien à faire ;
- **rouge** : ça manque, et un bouton jaune propose de l'obtenir ;
- **bleue**, avec un pourcentage : c'est en cours.

L'écran se met à jour tout seul. Tu peux le fermer et le rouvrir : il repart de l'état réel de
ta machine, pas de ce qu'il se souvient avoir fait.

### Étape 1 : le dossier de travail

C'est **le** dossier du projet : les sources et Godot y seront rangés côte à côte.

- Clique **Choisir…** et prends un dossier vide, sur un disque qui a de la place.
- Évite un chemin très long ou avec des caractères spéciaux.
- Tu as déjà cloné des dépôts quelque part ? Choisis le dossier qui les contient : ils seront
  reconnus, et jamais modifiés.

### Étape 2 : les programmes

| Programme | À quoi il sert |
|---|---|
| **git** | récupère les sources du projet |
| **Docker** | fait tourner des « conteneurs », de petites machines isolées ; tous les services du jeu en sont |
| **minikube** | un petit cluster Kubernetes sur ta machine, dans Docker : c'est lui qui héberge les services |
| **kubectl** | la commande qui parle au cluster (le panneau s'en sert en permanence) |
| **Helm** | installe des choses dans le cluster. Version **3** ou **4** |
| **SDK .NET 9** | bâtit la partie C# du jeu |

- **minikube, kubectl, Helm** : clique **Télécharger**. Le panneau les prend chez leur éditeur,
  vérifie chaque fichier, et les range dans son propre dossier. Aucun droit administrateur, rien
  d'autre n'est modifié sur ta machine.
- **git, Docker, .NET** sous Windows : clique **Installer**. Windows demande une autorisation,
  accepte. Suis l'avancement dans l'onglet `setup` en bas de la fenêtre.
- **Docker** demande ensuite de **fermer puis rouvrir ta session** (ou de redémarrer). Fais-le,
  relance Docker Desktop une fois, puis relance le panneau : l'assistant reprend où il en était.
- Sous Linux, le panneau n'appelle jamais `sudo` : il affiche la commande à lancer toi-même.

### Étape 3 : les sources

Clique **Cloner** sur chaque ligne.

| Dépôt | Contenu | Taille |
|---|---|---|
| `kubernetes` | la description de tous les services, et les scripts qui lancent la stack | petit |
| `DyingStar` | le jeu : client et serveur de jeu | **environ 2,4 Go**, plusieurs minutes |
| `horizonserver`, `services` | seulement si tu veux modifier ces services | petits |

Les dépôts demandés dépendent de ton profil : inutile de cloner ce dont tu ne te serviras pas.

### Étape 4 : Godot

Le projet utilise **son propre** Godot (C#, double précision). Celui de godotengine.org ne
marche pas avec. Clique **Télécharger** : environ 110 Mo, rangés dans le dossier de travail.

Les « paquets C# » de la ligne suivante arrivent avec lui.

### Étape 5 : la stack locale

C'est tout ce dont le jeu a besoin derrière lui : une trentaine de services (comptes, missions,
économie, voix…) qui tournent dans le cluster.

- Clique **Démarrer la stack**. La première fois, Windows demande les droits administrateur.
- **Le premier démarrage prend 10 à 25 minutes** : les images des services sont téléchargées.
- Suis l'avancement en haut de la fenêtre, voyant **pods** : `12/27 prêts`, puis `27/27 prêts`.

Quand les cinq étapes sont vertes, l'assistant affiche « Tout est en place ». Ferme-le.

## 3. Choisir ton profil

Ouvre les **Réglages** (roue dentée ⚙ en haut à droite), section **Profil**.

| Profil | Pour qui | Ce que tu vois |
|---|---|---|
| **Développeur** | la plupart des gens | core, serveur de jeu, services de jeu, administration ; l'éditeur, les clients |
| **Développeur services** | tu modifies les services de jeu | pareil, sans les outils du serveur de jeu local |
| **Développeur du serveur de jeu** | tu modifies le code du serveur de jeu | un pod à vide pour le serveur, qui tourne depuis tes sources derrière Telepresence |
| **Level designer** | tu travailles dans l'éditeur | le cluster minimum (core seul) et ton serveur de jeu local ; l'éditeur et les clients |
| **Stack complète** | tout, machine confortable | tous les ensembles, voix et supervision comprises |

Un profil change ce que le panneau **affiche et lance**, et les **ensembles de services** que le
cluster local déploie (le minimum est le *core*). Tu peux en changer quand tu veux, cocher ou
décocher un module, et ajouter ou retirer un ensemble sur un cluster qui tourne depuis la carte
**Services**.

## 4. Lire la fenêtre

**En haut, les voyants.** Un par chose surveillée : vert, ça marche ; orange, pas encore ; rouge,
problème. Laisse la souris dessus pour le détail.

**À gauche, les cartes.** Chacune a un **?** à côté de son titre : survole-le pour savoir ce que
font ses boutons.

- **Tout démarrer** : lance ce qu'il faut, dans le bon ordre. La **Séquence de démarrage**
  juste en dessous montre où ça en est, étape par étape.
- **Éditeur et clients** : ouvre le projet dans Godot, ou lance des clients du jeu. Chaque client
  est connecté tout seul comme un joueur de test.
- **Plateforme** et **Pods** : l'état du cluster. La croix d'un pod le redémarre.
- **Zone rouge** : les actions sans retour arrière. N'y touche pas sans savoir.

**À droite, les journaux.** Un onglet par service ou programme. La barre de recherche filtre
pendant que ça défile ; les boutons `ERROR` et `WARN` ne gardent que les problèmes.

## 5. Entrer dans le monde

1. Clique **Tout démarrer** et attends que la séquence soit entièrement verte.
2. Clique **Lancer les clients**. Le bouton reste grisé tant qu'il manque quelque chose : sa
   bulle dit quoi.
3. Dans le jeu, entre dans l'univers.

## Si ça coince

| Ce que tu vois | Quoi faire |
|---|---|
| Voyant **Docker** rouge | Lance Docker Desktop, attends une ou deux minutes |
| **pods** bloqué en dessous du total | Regarde l'onglet du pod en retard, cherche `ERROR`. Sa croix le redémarre |
| **Lancer les clients** grisé | Survole le bouton : il dit ce qui manque |
| Le client affiche « ERROR 1337 » | Horizon n'est pas joignable : regarde le voyant **horizon** |
| Un téléchargement échoue | Le fichier est effacé et le message dit pourquoi. Recommence : rien n'est gardé à moitié |
| Tu es perdu | Copie les lignes de l'onglet `panel` (bouton **Copier**) et envoie-les à l'équipe |

## Arrêter et reprendre

- **Tout arrêter** coupe ce que le panneau a lancé (serveur de jeu, clients). Le cluster, lui,
  reste : ses données aussi.
- Fermer le panneau ne supprime rien.
- Le lendemain : lance le panneau, **Tout démarrer**. Deux minutes, pas vingt-cinq.
