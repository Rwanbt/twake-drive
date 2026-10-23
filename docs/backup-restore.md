# Sauvegarde et restauration — Twake Drive

> Procédure opérationnelle pour sauvegarder et restaurer une instance Drive.
> Référencée par le cahier de qualification §I. État : procédure documentée, non encore exécutée en CI (voir section Statut).

## 1. Ce qu'il faut sauvegarder

Une instance Drive repose sur trois composants persistants :

| Composant | Contenu | Où |
|---|---|---|
| CouchDB | données Cozy (fichiers, métadonnées, partages, utilisateurs) | volume couchdb_data du compose E2E ; en production : le stockage CouchDB de l'instance |
| Stockage de fichiers Cozy | blobs des fichiers uploadés | volume monté par cozy-stack (/data) ; en production : le répertoire de stockage configuré dans cozy.yml |
| Configuration | cozy.yml, secrets JWT, clés OnlyOffice | dépôt de configuration de l'instance |

Le Document Server OnlyOffice est sans état : il ne conserve pas les documents, il les reçoit du stack via JWT. Il n'y a rien à sauvegarder côté OnlyOffice.

## 2. Sauvegarde

### 2.1 CouchDB

    docker exec <couchdb> couchdb-backup \
      --source http://localhost:5984 \
      --destination /backup/couchdb-$(date +%Y%m%d-%H%M%S).tar.gz

En production, utiliser la réplication CouchDB vers un second nœud ou un dump couchdb-dump planifié (cron quotidien recommandé).

### 2.2 Stockage de fichiers Cozy

    rsync -a --delete /var/lib/cozy/storage/ /backup/cozy-storage-$(date +%Y%m%d)/

### 2.3 Configuration

    tar czf /backup/cozy-config-$(date +%Y%m%d).tar.gz /etc/cozy/cozy.yml /etc/cozy/secrets/

### 2.4 Vérification de la sauvegarde

- Vérifier que l'archive CouchDB est non vide et lisible (tar tzf).
- Vérifier la somme de contrôle (sha256sum).
- Conserver au moins 7 sauvegardes quotidiennes et 4 hebdomadaires.

## 3. Restauration

### 3.1 Arrêter les services

    docker compose down

### 3.2 Restaurer CouchDB

    docker compose up -d couchdb
    docker exec <couchdb> couchdb-restore \
      --source /backup/couchdb-<date>.tar.gz \
      --destination http://localhost:5984

### 3.3 Restaurer le stockage

    rsync -a /backup/cozy-storage-<date>/ /var/lib/cozy/storage/
    chown -R cozy:cozy /var/lib/cozy/storage/

### 3.4 Restaurer la configuration

    tar xzf /backup/cozy-config-<date>.tar.gz -C /

### 3.5 Redémarrer et vérifier

    docker compose up -d
    curl -s http://localhost:8080/version
    curl -s http://localhost:5984/_up

## 4. Test de restauration (à exécuter avant toute mise en production)

1. Créer une instance de test avec des données connues (fichier hello from twake-drive e2e).
2. Exécuter la sauvegarde.
3. Détruire l'instance (docker compose down -v).
4. Restaurer depuis la sauvegarde.
5. Vérifier que le fichier est présent et lisible.
6. Vérifier que les partages sont intacts.

Statut actuel : procédure documentée, non encore exécutée automatiquement. Aucun test automatisé ne couvre cette procédure dans le dépôt. C'est un point de NO-GO pour la qualification production complète (cahier section I).

## 5. Risques et limites

- La sauvegarde CouchDB doit être cohérente : arrêter les écritures ou utiliser la réplication continue.
- Le stockage de fichiers et CouchDB doivent être sauvegardés au même instant pour rester cohérents.
- La clé JWT OnlyOffice n'est pas sauvegardée (elle est régénérée à chaque démarrage) : après restauration, les sessions d'édition en cours sont invalidées, ce qui est attendu.
