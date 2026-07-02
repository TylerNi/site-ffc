#!/usr/bin/env bash
# Exécute les migrations de base de données comme une tâche ECS Fargate
# PONCTUELLE et CONTRÔLÉE, avec la NOUVELLE image, AVANT tout basculement de
# service. Interrompt le déploiement (sortie != 0) si la tâche de migration ne
# se termine pas avec le code 0.
set -euo pipefail

: "${AWS_REGION:?AWS_REGION requis}"
: "${CLUSTER:?CLUSTER requis}"
: "${TASK_DEF_FAMILY:?TASK_DEF_FAMILY requis}"
: "${IMAGE_URI:?IMAGE_URI requis}"
: "${SUBNETS:?SUBNETS requis (ids séparés par des virgules)}"
: "${SECURITY_GROUPS:?SECURITY_GROUPS requis (ids séparés par des virgules)}"

echo "::group::Enregistrement d'une révision de migration (${IMAGE_URI})"
aws ecs describe-task-definition --task-definition "$TASK_DEF_FAMILY" \
  --query 'taskDefinition' --output json >taskdef.json

# Remplace l'image de tous les conteneurs et retire les champs renvoyés par
# describe mais non acceptés par register-task-definition.
jq --arg IMAGE "$IMAGE_URI" '
  .containerDefinitions |= map(.image = $IMAGE)
  | del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
        .compatibilities, .registeredAt, .registeredBy)
' taskdef.json >taskdef-new.json

MIGRATE_ARN=$(aws ecs register-task-definition \
  --cli-input-json file://taskdef-new.json \
  --query 'taskDefinition.taskDefinitionArn' --output text)
echo "Révision de migration : ${MIGRATE_ARN}"
echo "::endgroup::"

echo "::group::Lancement de la tâche de migration"
NETWORK_CONFIG="awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SECURITY_GROUPS}],assignPublicIp=DISABLED}"
TASK_ARN=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$MIGRATE_ARN" \
  --launch-type FARGATE \
  --network-configuration "$NETWORK_CONFIG" \
  --started-by "gha-migrate-${GITHUB_SHA:-manual}" \
  --query 'tasks[0].taskArn' --output text)
echo "Tâche : ${TASK_ARN}"

echo "Attente de la fin de la tâche de migration…"
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

read -r EXIT_CODE STOP_REASON < <(aws ecs describe-tasks \
  --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].[containers[0].exitCode, stoppedReason]' --output text)
echo "Code de sortie : ${EXIT_CODE} — ${STOP_REASON}"
echo "::endgroup::"

if [[ "$EXIT_CODE" != "0" ]]; then
  echo "❌ Migrations échouées (code ${EXIT_CODE}) — déploiement interrompu."
  exit 1
fi
echo "✅ Migrations appliquées."
