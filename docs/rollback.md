# Procédure de rollback — Twake Drive

> Procédure opérationnelle pour revenir à une version antérieure de Drive.
> Référencée par le cahier de qualification §I. État : **procédure documentée, non encore exécutée en CI** (voir § « Statut »).

## 1. Principe

Le rollback d'une instance Drive consiste à :

1. Revenir à l'artefact (image conteneur ou bundle webapp) de la version précédente.
2. Vérifier la compatibilité du schéma de données (CouchDB + stockage).
3. Redémarrer les services.
4. Valider la santé.

Le mécanisme de version existe (`manifest.webapp`, `cozy-app-publish`), mais n'est pas outillé ni exécuté automatiquement dans ce dépôt.

## 2. Rollback de l'application web (bundle)

### 2.1 Identifier la version précédente

```bash
gh release list -R Rwanbt/twake-drive
git log --oneline origin/master -5
```

### 2.2 Redéployer la version précédente

```bash
cozy-app-publish --token $REGISTRY_TOKEN --app-version <version-precedente>
git checkout <sha-precedent>
yarn build
```

### 2.3 Vérifier

```bash
curl -s http://localhost:8080/version
```

## 3. Rollback du runtime E2E (Docker)

Les images sont épinglées par digest dans `docker-compose.e2e.yml`.

```bash
git log --oneline -- docker-compose.e2e.yml
```

Variables d'environnement pour tester une autre révision sans modifier le fichier :

```bash
COZY_E2E_STACK_IMAGE=cozy/cozy-stack:<tag-precedent> \
COZY_E2E_STACK_PULL_POLICY=always \
yarn e2e
```

## 4. Rollback de la base de données (CouchDB)

Si le rollback nécessite de revenir à un état de données antérieur :

1. Arrêter les services (`docker compose down`).
2. Restaurer la sauvegarde CouchDB précédant le déploiement (voir `docs/backup-restore.md` §3.2).
3. Restaurer le stockage de fichiers correspondant.
4. Redémarrer et vérifier.

**Attention** : un rollback de données est destructif pour les données créées après le point de restauration. Toujours sauvegarder l'état actuel avant un rollback.

## 5. Test de rollback (à exécuter avant toute mise en production)

1. Déployer la version N.
2. Créer des données (fichier, partage).
3. Rollback vers la version N-1.
4. Vérifier que l'application démarre et que les données sont accessibles (ou que la perte est documentée).
5. Rollback vers la version N (restauration).
6. Vérifier que tout est revenu à l'état initial.

**Statut actuel** : procédure documentée, non encore exécutée. Aucun test automatisé ne couvre cette procédure. C'est un point de NO-GO pour la qualification production complète (cahier §I).

## 6. Risques et limites

- Les migrations de schéma CouchDB ne sont pas réversibles automatiquement : un rollback peut nécessiter une migration inverse manuelle.
- Les partages actifs sont invalidés si la clé JWT change entre versions.
- Le Document Server OnlyOffice doit être compatible avec la version cible de Drive : vérifier la matrice de compatibilité avant le rollback.
