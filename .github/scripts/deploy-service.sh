#!/usr/bin/env bash
# Déploie un service ECS (api ou workers) avec la nouvelle image : enregistre
# une nouvelle révision de task definition, met à jour le service, puis attend
# sa stabilisation. Exécuté APRÈS le succès des migrations.
set -euo pipefail

: "${AWS_REGION:?AWS_REGION requis}"
: "${CLUSTER:?CLUSTER requis}"
: "${SERVICE:?SERVICE requis}"
: "${TASK_DEF_FAMILY:?TASK_DEF_FAMILY requis}"
: "${IMAGE_URI:?IMAGE_URI requis}"

echo "::group::Nouvelle révision pour ${SERVICE} (${IMAGE_URI})"
aws ecs describe-task-definition --task-definition "$TASK_DEF_FAMILY" \
  --query 'taskDefinition' --output json >td.json
jq --arg IMAGE "$IMAGE_URI" '
  .containerDefinitions |= map(.image = $IMAGE)
  | del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
        .compatibilities, .registeredAt, .registeredBy)
' td.json >td-new.json
NEW_ARN=$(aws ecs register-task-definition --cli-input-json file://td-new.json \
  --query 'taskDefinition.taskDefinitionArn' --output text)
echo "Révision : ${NEW_ARN}"
echo "::endgroup::"

echo "::group::Mise à jour du service ${SERVICE}"
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
  --task-definition "$NEW_ARN" >/dev/null
echo "Attente de stabilisation du service…"
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
echo "✅ ${SERVICE} déployé et stable."
echo "::endgroup::"
